/**
 * HF-059a `GET /api/bids/:id/won` (W18 / M08) through the real server on Postgres with the
 * `FakePayPal` stub. Bid, capture and shipment rows are written the way Clear (HF-027), settleBid
 * (HF-029), promoteWithin (HF-031) and the HF-059b shipments endpoint leave them.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/bids-won.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook, FakePayPal, loadConfig } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'w'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  PAYPAL_MODE: 'stub',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-059a won page', () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    const fake = new FakePayPal();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      bids: {
        money: {
          db: tdb.db,
          paypal: fake.client({ timeoutMs: 10_000, holdRetries: 1 }),
          audit: auditHook,
          voidBackoffMs: [0, 0, 0],
          allowTestCard: true,
        },
      },
    });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const q = (sql: string, params: unknown[] = []) => tdb.db.pool.query(sql, params);
  const session = (shopperId: string) =>
    `${SHOPPER_COOKIE}=${signToken(SECRET, 'shopper-session', { sub: shopperId, exp: Date.now() + 60_000 })}`;
  const getWon = (bidId: string, shopperId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/bids/${bidId}/won`,
      headers: { cookie: session(shopperId) },
    });

  /** A cleared listing with one held bid moved to WON (Clear), optionally captured. */
  async function wonBid(opts: { amountCents?: number; capture?: boolean } = {}) {
    const listing = await fx.listing({ status: 'OPEN' });
    const shopper = await fx.shopper();
    const bid = await fx.heldBid(listing.id, shopper.id, {
      amountCents: opts.amountCents ?? 22_900,
    });
    await q(`UPDATE listings SET status = 'SETTLED', cleared_at = now() WHERE id = $1`, [
      listing.id,
    ]);
    await q(`UPDATE bids SET status = 'WON', won_rank = 1, unit_root_bid_id = id WHERE id = $1`, [
      bid.id,
    ]);
    if (opts.capture ?? true) await capture(listing.id, bid.id, bid.amount_cents);
    return {
      listingId: listing.id,
      shopperId: shopper.id,
      bidId: bid.id,
      amount: bid.amount_cents,
    };
  }

  async function capture(
    listingId: string,
    bidId: string,
    amountCents: number,
    captureId = 'CAP-9XK2',
  ) {
    await q(
      `INSERT INTO settlements (listing_id, bid_id, action, amount_cents, status, paypal_id,
                                paypal_status, finished_at)
       VALUES ($1, $2, 'CAPTURE', $3, 'SUCCEEDED', $4, 'COMPLETED', now())`,
      [listingId, bidId, amountCents, captureId],
    );
    await q(`UPDATE bids SET status = 'CAPTURED' WHERE id = $1`, [bidId]);
  }

  it('captured winner: D14 headline, charged = the bid, capture id and date, not shipped yet', async () => {
    const w = await wonBid({ amountCents: 22_900 });
    const res = await getWon(w.bidId, w.shopperId);
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.headline).toMatchInlineSnapshot(`"You won at your bid of $229. Charged $229."`);
    expect(view.status).toBe('CAPTURED');
    expect(view.promoted).toBe(false);
    expect(view.promotedNote).toBeNull();
    expect(view.receipt.chargedCents).toBe(w.amount);
    expect(view.receipt.captureId).toBe('CAP-9XK2');
    expect(typeof view.receipt.capturedAt).toBe('string');
    expect(view.shipment).toBeNull();
    // Charged equals the bid, the authorization and the capture row (INV-5, D14).
    const row = (
      await q(
        `SELECT b.amount_cents, b.authorized_amount_cents, s.amount_cents AS captured
           FROM bids b JOIN settlements s ON s.bid_id = b.id AND s.action = 'CAPTURE'
          WHERE b.id = $1`,
        [w.bidId],
      )
    ).rows[0];
    expect(view.receipt.chargedCents).toBe(row.amount_cents);
    expect(view.receipt.chargedCents).toBe(row.authorized_amount_cents);
    expect(view.receipt.chargedCents).toBe(row.captured);
    expect(JSON.stringify(view)).not.toMatch(/got it at/i);
  });

  it('WON before the capture: never says "Charged" and has no receipt yet', async () => {
    const w = await wonBid({ capture: false });
    const view = (await getWon(w.bidId, w.shopperId)).json();
    expect(view.headline).toBe('You won at your bid of $229.');
    expect(view.headline).not.toMatch(/charged/i);
    expect(view.receipt).toBeNull();
  });

  it('tracking added through the shipments row (HF-059b) shows, with a carrier link', async () => {
    const w = await wonBid();
    await q(
      `INSERT INTO shipments (bid_id, listing_id, carrier, tracking_number, paypal_tracker_id,
                              tracking_request_id, status, shipped_at)
       VALUES ($1, $2, 'UPS', '1Z999AA10123456784', 'TRK-1', 'track-x', 'SHIPPED', now())`,
      [w.bidId, w.listingId],
    );
    await q(`UPDATE bids SET status = 'SHIPPED' WHERE id = $1`, [w.bidId]);

    let view = (await getWon(w.bidId, w.shopperId)).json();
    expect(view.status).toBe('SHIPPED');
    expect(view.headline).toBe('You won at your bid of $229. Charged $229.');
    expect(view.shipment).toMatchObject({
      stage: 'SHIPPED',
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
      trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
    });

    await q(`UPDATE shipments SET status = 'DELIVERED' WHERE bid_id = $1`, [w.bidId]);
    view = (await getWon(w.bidId, w.shopperId)).json();
    expect(view.shipment.stage).toBe('DELIVERED');
  });

  it('a shipments row without a tracking number is still "ordered"', async () => {
    const w = await wonBid();
    await q(`INSERT INTO shipments (bid_id, listing_id) VALUES ($1, $2)`, [w.bidId, w.listingId]);
    const view = (await getWon(w.bidId, w.shopperId)).json();
    expect(view.shipment.stage).toBe('ORDERED');
    expect(view.shipment.trackingUrl).toBeNull();
  });

  it('promoted winner: "You moved up from the reserve list", charged their own bid', async () => {
    const w = await wonBid({ capture: false });
    // The original winner's capture failed; the reserve bid at $219 took its unit (HF-031).
    await q(`UPDATE bids SET status = 'CAPTURE_FAILED' WHERE id = $1`, [w.bidId]);
    const shopper = await fx.shopper();
    const reserve = await fx.heldBid(w.listingId, shopper.id, { amountCents: 21_900 });
    await q(
      `UPDATE bids SET status = 'WON', unit_root_bid_id = $2, promotion_count = 1 WHERE id = $1`,
      [reserve.id, w.bidId],
    );
    await capture(w.listingId, reserve.id, 21_900, 'CAP-PROMO');

    const view = (await getWon(reserve.id, shopper.id)).json();
    expect(view.promoted).toBe(true);
    expect(view.promotedNote).toBe('You moved up from the reserve list');
    expect(view.headline).toBe('You won at your bid of $219. Charged $219.');
    expect(view.receipt).toMatchObject({ chargedCents: 21_900, captureId: 'CAP-PROMO' });
  });

  it('lists holds released by an earlier raise on the chain', async () => {
    const w = await wonBid();
    const old = await fx.heldBid(w.listingId, w.shopperId, { amountCents: 20_500 });
    await q(
      `UPDATE bids SET status = 'VOIDED', void_reason = 'REPLACED', voided_at = now() WHERE id = $1`,
      [old.id],
    );
    await q(`UPDATE bids SET replaces_bid_id = $2 WHERE id = $1`, [w.bidId, old.id]);
    const view = (await getWon(w.bidId, w.shopperId)).json();
    expect(view.released).toEqual([
      {
        bidId: old.id,
        amountCents: 20_500,
        text: '$205 released. Your bank may show it as pending for a few days.',
      },
    ]);
  });

  it('owner only: another shopper gets 404; a bid that has not won is 409 NOT_WON', async () => {
    const w = await wonBid();
    const stranger = await fx.shopper();
    const other = await getWon(w.bidId, stranger.id);
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe('NOT_FOUND');

    const listing = await fx.listing();
    const held = await fx.heldBid(listing.id, stranger.id);
    const notWon = await getWon(held.id, stranger.id);
    expect(notWon.statusCode).toBe(409);
    expect(notWon.json().error).toMatchObject({ code: 'STATE_CONFLICT', reason: 'NOT_WON' });

    const unauth = await app.inject({ method: 'GET', url: `/api/bids/${w.bidId}/won` });
    expect(unauth.statusCode).toBe(401);
    expect((await getWon('not-a-uuid', w.shopperId)).statusCode).toBe(404);
  });
});
