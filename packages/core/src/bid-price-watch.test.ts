/**
 * HF-020 integration + race tests: `setReleaseIfCheaper` (`PATCH /bids/:id`) and the price-watch /
 * price-drop parts of `getBidDetail`, on real Postgres with the `FakePayPal` stub (HF-004).
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/bid-price-watch.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import { cancelBid } from './bid-cancel.js';
import { setReleaseIfCheaper, setReleaseIfCheaperResponse } from './bid-price-watch.js';
import { getBidDetail } from './bid-views.js';
import { placeBid, type PlaceBidDeps } from './bids.js';
import type { Db } from './db.js';
import { clearListing } from './listings/clear-listing.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { voidKey } from './money/void.js';
import { FakePayPal } from './paypal/fake.js';
import type { PayPalClient } from './paypal/types.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-020 release-if-cheaper toggle', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let mark = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake.latencyMs = 0;
    fake.clearFaults();
    mark = fake.calls.length;
  });

  const deps = (extra: Partial<PlaceBidDeps> = {}): PlaceBidDeps => ({
    db,
    paypal: client,
    voidBackoffMs: [0, 0, 0],
    audit: auditHook,
    allowTestCard: true,
    ...extra,
  });
  const voidsFor = (bidId: string) =>
    fake.calls.slice(mark).filter((c) => c.op === 'void' && c.requestId === voidKey(bidId));

  async function held(listingId: string, shopperId: string, amountCents = 22_900) {
    const r = await placeBid(deps(), {
      shopperId,
      listingId,
      amountCents,
      paymentMethod: 'TEST_CARD',
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(`hold failed: ${JSON.stringify(r.error)}`);
    return r.bid;
  }

  /** Set the product's best public offer (what HF-009 / HF-042 keep fresh). */
  async function publicPrice(listingId: string, cents: number | null) {
    await db.pool.query(
      `UPDATE products SET best_public_price_cents = $2, best_public_merchant = 'cheapstore.example',
              best_public_offer_url = 'https://cheapstore.example/a7', price_updated_at = now()
        WHERE id = (SELECT product_id FROM listings WHERE id = $1)`,
      [listingId, cents],
    );
  }

  /** A held bid with the watch switched off (the shopper confirmed bidding above public price). */
  async function heldWatchOff(listingId: string, shopperId: string, amountCents = 22_900) {
    const bid = await held(listingId, shopperId, amountCents);
    const off = await setReleaseIfCheaper(deps(), {
      bidId: bid.id,
      shopperId,
      releaseIfCheaper: false,
    });
    expect(off).toMatchObject({ ok: true, released: false });
    mark = fake.calls.length;
    return bid;
  }

  it('switching off persists, audits once, and touches no money', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    await publicPrice(l.id, 21_900);
    const bid = await heldWatchOff(l.id, s.id);
    expect((await fx.bid(bid.id)).release_if_cheaper).toBe(false);
    // Same value again: no second audit row.
    await setReleaseIfCheaper(deps(), { bidId: bid.id, shopperId: s.id, releaseIfCheaper: false });
    const audits = await db.pool.query(
      `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'BID_RELEASE_IF_CHEAPER_SET'`,
      [bid.id],
    );
    expect(audits.rows).toEqual([{ data: { releaseIfCheaper: false, reason: 'PRICE_WATCH_OFF' } }]);
    expect((await fx.bid(bid.id)).status).toBe('HELD');
  });

  it('switching on below the public price keeps the hold', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    await publicPrice(l.id, 27_900);
    const bid = await heldWatchOff(l.id, s.id);
    const r = await setReleaseIfCheaper(deps(), {
      bidId: bid.id,
      shopperId: s.id,
      releaseIfCheaper: true,
    });
    expect(r).toMatchObject({ ok: true, released: false });
    expect(await fx.bid(bid.id)).toMatchObject({ status: 'HELD', release_if_cheaper: true });
    expect(voidsFor(bid.id)).toHaveLength(0);
  });

  it('switching on above the public price voids with PRICE_DROP (void-<bidId>) and records the store', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    await publicPrice(l.id, 21_900);
    const bid = await heldWatchOff(l.id, s.id);
    const r = await setReleaseIfCheaper(deps(), {
      bidId: bid.id,
      shopperId: s.id,
      releaseIfCheaper: true,
    });
    expect(r).toMatchObject({
      ok: true,
      released: true,
      cheaper: { priceCents: 21_900, merchant: 'cheapstore.example' },
    });
    expect(await fx.bid(bid.id)).toMatchObject({
      status: 'VOIDED',
      void_reason: 'PRICE_DROP',
      release_if_cheaper: true,
    });
    expect(fake.authorization(bid.paypal_authorization_id!)?.status).toBe('VOIDED');
    expect(voidsFor(bid.id)).toHaveLength(1);

    const body = setReleaseIfCheaperResponse(r);
    expect(body).toMatchObject({
      status: 200,
      body: {
        status: 'VOIDED',
        moneyKey: 'released',
        message: 'We released your $229 hold. Your bank may show it as pending for a few days.',
      },
    });

    const detail = (await getBidDetail(db.pool, s.id, bid.id))!;
    expect(detail.priceDrop).toMatchObject({
      bidId: bid.id,
      oldCents: 22_900,
      newCents: 21_900,
      merchant: 'cheapstore.example',
      url: 'https://cheapstore.example/a7',
      released: true,
      replayed: false,
    });
    expect(detail.timeline.map((e) => e.step)).toEqual(
      expect.arrayContaining(['HELD', 'RELEASING', 'RELEASED']),
    );
  });

  it('owner only: another shopper gets NOT_FOUND; a settled bid is STATE_CONFLICT', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const other = await fx.shopper();
    const bid = await held(l.id, s.id);
    expect(
      await setReleaseIfCheaper(deps(), {
        bidId: bid.id,
        shopperId: other.id,
        releaseIfCheaper: false,
      }),
    ).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
    const r = await setReleaseIfCheaper(deps(), {
      bidId: bid.id,
      shopperId: s.id,
      releaseIfCheaper: false,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'VOIDED' } });
    expect(setReleaseIfCheaperResponse(r).status).toBe(409);
  });

  it('does not void while the listing is not OPEN/ROUNDS', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    await publicPrice(l.id, 21_900);
    const bid = await heldWatchOff(l.id, s.id);
    await db.pool.query(`UPDATE listings SET status = 'CANCELLED' WHERE id = $1`, [l.id]);
    const r = await setReleaseIfCheaper(deps(), {
      bidId: bid.id,
      shopperId: s.id,
      releaseIfCheaper: true,
    });
    expect(r).toMatchObject({ ok: true, released: false });
    expect(voidsFor(bid.id)).toHaveLength(0);
  });

  it('price watch row: on/off, since the first hold, last public price check', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    await publicPrice(l.id, 27_900);
    const bid = await held(l.id, s.id);
    const detail = (await getBidDetail(db.pool, s.id, bid.id))!;
    expect(detail.priceWatch).toMatchObject({
      on: true,
      bestPublicPriceCents: 27_900,
      merchant: 'cheapstore.example',
    });
    expect(detail.priceWatch.since).toBeTruthy();
    expect(detail.priceWatch.checkedAt).toBeTruthy();
    expect(detail.priceDrop).toBeNull();
  });

  describe('races (FakePayPal stub)', () => {
    it('toggle-on vs cancel → one PayPal void; the bid ends VOIDED', async () => {
      for (let i = 0; i < 3; i++) {
        const l = await fx.listing();
        const s = await fx.shopper();
        await publicPrice(l.id, 21_900);
        const bid = await heldWatchOff(l.id, s.id);
        fake.latencyMs = 150;
        const [toggled, cancelled] = await Promise.all([
          setReleaseIfCheaper(deps(), { bidId: bid.id, shopperId: s.id, releaseIfCheaper: true }),
          cancelBid(deps(), { bidId: bid.id, shopperId: s.id }),
        ]);
        fake.latencyMs = 0;
        expect(cancelled.ok).toBe(true);
        // The toggle either released it, or lost the race and saw it already releasing.
        if (!toggled.ok) expect(toggled.error.code).toBe('STATE_CONFLICT');
        const row = await fx.bid(bid.id);
        expect(['VOIDING', 'VOIDED']).toContain(row.status);
        expect(['PRICE_DROP', 'CANCELLED']).toContain(row.void_reason);
        expect(voidsFor(bid.id)).toHaveLength(1);
        expect(fake.authorization(bid.paypal_authorization_id!)?.status).toBe('VOIDED');
      }
    });

    it('five concurrent toggle-ons → one PayPal void', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      await publicPrice(l.id, 21_900);
      const bid = await heldWatchOff(l.id, s.id);
      fake.latencyMs = 150;
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          setReleaseIfCheaper(deps(), { bidId: bid.id, shopperId: s.id, releaseIfCheaper: true }),
        ),
      );
      fake.latencyMs = 0;
      expect(results.filter((r) => r.ok && r.released)).toHaveLength(1);
      expect(voidsFor(bid.id)).toHaveLength(1);
      expect((await fx.bid(bid.id)).status).toBe('VOIDED');
    });

    it('toggle-on vs Clear: released (never cleared) or settled (never voided), not both', async () => {
      for (let i = 0; i < 4; i++) {
        const l = await fx.listing();
        const brand = (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [l.id]))
          .rows[0].brand_id as string;
        const s = await fx.shopper();
        const other = await fx.shopper();
        await publicPrice(l.id, 21_900);
        const mine = await heldWatchOff(l.id, s.id, 22_900);
        await heldWatchOff(l.id, other.id, 20_000);
        fake.latencyMs = 100;
        const [toggled, cleared] = await Promise.all([
          setReleaseIfCheaper(deps(), { bidId: mine.id, shopperId: s.id, releaseIfCheaper: true }),
          clearListing(
            { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook },
            {
              listingId: l.id,
              brandId: brand,
              quantity: 1,
              expectedGrossCents: 22_900,
              actor: { type: 'BRAND_USER', id: 'u1' },
            },
          ),
        ]);
        fake.latencyMs = 0;
        const row = await fx.bid(mine.id);
        const auth = fake.authorization(mine.paypal_authorization_id!)?.status;
        if (toggled.ok && toggled.released) {
          expect(row.void_reason).toBe('PRICE_DROP');
          expect(auth).toBe('VOIDED');
          // Clear ran without it (expected gross mismatched → 409) or never saw it as HELD.
          const settled = await db.pool.query(
            `SELECT count(*)::int AS n FROM settlements WHERE bid_id = $1`,
            [mine.id],
          );
          expect(settled.rows[0].n).toBe(0);
        } else {
          expect(cleared.ok).toBe(true);
          expect(['WON', 'LOST']).toContain(row.status);
          expect(auth).toBe('CREATED');
          expect(voidsFor(mine.id)).toHaveLength(0);
        }
      }
    });
  });
});
