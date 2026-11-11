/**
 * HF-060 order-timeline facts on a real Postgres: tenancy (another brand / shopper gets null),
 * listing timestamps, settlement / payout / shipment aggregates, price-watch audit counts and the
 * shopper's narrowed view. Needs TEST_DATABASE_URL; skipped when unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orderTimeline } from '@holdfast/shared';
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from './money/test-harness.js';
import { brandOrderTimeline, shopperOrderTimeline } from './order-timeline.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-060 order timeline facts', () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let listingId: string;
  let brandId: string;
  let winner: { shopper: string; bid: string };
  let loser: { shopper: string; bid: string };
  let declined: { shopper: string; bid: string };

  const q = (sql: string, params: unknown[] = []) => tdb.db.pool.query(sql, params);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    listingId = (await fx.listing()).id;
    brandId = (
      (await q(`SELECT brand_id FROM listings WHERE id = $1`, [listingId])).rows[0] as {
        brand_id: string;
      }
    ).brand_id;
    await q(
      `UPDATE products SET channel3_subscription_id = 'sub-1'
        WHERE id = (SELECT product_id FROM listings WHERE id = $1)`,
      [listingId],
    );

    const place = async (cents: number) => {
      const shopper = (await fx.shopper()).id;
      const bid = (await fx.heldBid(listingId, shopper, { amountCents: cents })).id;
      return { shopper, bid };
    };
    winner = await place(24_900);
    declined = await place(23_900);
    loser = await place(19_900);

    // Clear and settle by hand: winner charged, declined winner's capture failed, loser released.
    await q(
      `UPDATE listings SET status = 'PAID_OUT', cleared_at = now() - interval '10 minutes',
              window_closes_at = now() - interval '20 minutes', cutoff_cents = 23900
        WHERE id = $1`,
      [listingId],
    );
    await q(`UPDATE bids SET status = 'CAPTURED' WHERE id = $1`, [winner.bid]);
    await q(`UPDATE bids SET status = 'CAPTURE_FAILED' WHERE id = $1`, [declined.bid]);
    await q(`UPDATE bids SET status = 'VOIDED', void_reason = 'LOST' WHERE id = $1`, [loser.bid]);
    const settle = (
      bid: string,
      action: string,
      status: string,
      cents: number | null,
      startMin: number,
    ) =>
      q(
        `INSERT INTO settlements (listing_id, bid_id, action, amount_cents, status, attempts,
                                  started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, 1, now() - $6::float8 * interval '1 minute',
                 now() - ($6::float8 - 0.1) * interval '1 minute')`,
        [listingId, bid, action, cents, status, startMin],
      );
    await settle(winner.bid, 'CAPTURE', 'SUCCEEDED', 24_900, 9);
    await settle(declined.bid, 'CAPTURE', 'FAILED', 23_900, 8.9);
    await settle(loser.bid, 'VOID', 'SUCCEEDED', null, 8.5);
    await q(
      `INSERT INTO payouts (listing_id, brand_id, status, gross_cents, fee_cents, net_cents,
                            created_at, completed_at)
       VALUES ($1, $2, 'SUCCESS', 24900, 2241, 22659, now() - interval '8 minutes',
               now() - interval '7 minutes')`,
      [listingId, brandId],
    );
    await q(
      `INSERT INTO shipments (bid_id, listing_id, carrier, tracking_number, status, shipped_at)
       VALUES ($1, $2, 'UPS', '1Z999', 'SHIPPED', now() - interval '1 minute')`,
      [winner.bid, listingId],
    );
    await q(
      `INSERT INTO audit_events (actor_type, listing_id, entity, action, data)
       VALUES ('WATCHER', $1, 'product', 'PRICE_IGNORED', '{}'),
              ('WATCHER', $1, 'listing', 'PRICE_WATCH_RELEASED', '{}')`,
      [listingId],
    );
  }, 60_000);

  afterAll(async () => {
    await tdb?.close();
  });

  it('brand: real timestamps and aggregates for every phase', async () => {
    const f = (await brandOrderTimeline(tdb.db.pool, brandId, listingId))!;
    expect(f.audience).toBe('brand');
    expect(f.listingStatus).toBe('PAID_OUT');
    expect(f.windowOpensAt).not.toBeNull();
    expect(f.clearedAt).not.toBeNull();
    expect(f.priceWatch).toMatchObject({ on: true, events: 2, released: 0 });
    expect(f.settlement).toMatchObject({ total: 3, finished: 3, failed: 1, charged: 1 });
    expect(Date.parse(f.settlement!.firstStartedAt!)).toBeLessThan(
      Date.parse(f.settlement!.lastFinishedAt!),
    );
    expect(f.payout).toMatchObject({ status: 'SUCCESS' });
    expect(f.payout!.completedAt).not.toBeNull();
    expect(f.shipping).toMatchObject({ expected: 1, shipped: 1 });

    const phases = orderTimeline(f, new Date(f.asOf));
    expect(phases.map((p) => [p.key, p.state])).toEqual([
      ['window', 'done'],
      ['priceWatch', 'done'],
      ['rounds', 'skipped'],
      ['lock', 'done'],
      ['capture', 'done'],
      ['payout', 'done'],
      ['shipping', 'done'],
    ]);
  });

  it('brand: another brand, an unknown id and a malformed id are all null', async () => {
    const other = (await fx.listing()).id;
    const otherBrand = (
      (await q(`SELECT brand_id FROM listings WHERE id = $1`, [other])).rows[0] as {
        brand_id: string;
      }
    ).brand_id;
    expect(await brandOrderTimeline(tdb.db.pool, otherBrand, listingId)).toBeNull();
    expect(await brandOrderTimeline(tdb.db.pool, brandId, randomUUID())).toBeNull();
    expect(await brandOrderTimeline(tdb.db.pool, brandId, 'not-a-uuid')).toBeNull();
  });

  it('shopper (winner): own capture and shipment, payout shown', async () => {
    const f = (await shopperOrderTimeline(tdb.db.pool, winner.shopper, winner.bid))!;
    expect(f).toMatchObject({ audience: 'shopper', outcome: 'won' });
    expect(f.settlement).toMatchObject({ total: 1, finished: 1, failed: 0, charged: 1 });
    expect(f.payout).toMatchObject({ status: 'SUCCESS' });
    expect(f.shipping).toMatchObject({ expected: 1, shipped: 1 });
    // The brand-wide price-watch counts never reach a shopper.
    expect(f.priceWatch.events).toBe(0);
  });

  it('shopper (lost): own release only, no payout or shipping', async () => {
    const f = (await shopperOrderTimeline(tdb.db.pool, loser.shopper, loser.bid))!;
    expect(f.outcome).toBe('lost');
    expect(f.settlement).toMatchObject({ total: 1, charged: 0 });
    expect(f.payout).toBeNull();
    expect(f.shipping).toBeNull();
    const capture = orderTimeline(f, new Date(f.asOf)).find((p) => p.key === 'capture')!;
    expect(capture.detail).toBe('Hold released, never charged');
  });

  it('shopper (declined at capture): outcome declined, nothing ships', async () => {
    const f = (await shopperOrderTimeline(tdb.db.pool, declined.shopper, declined.bid))!;
    expect(f.outcome).toBe('declined');
    expect(f.settlement).toMatchObject({ failed: 1, charged: 0 });
    expect(f.payout).toBeNull();
    expect(f.shipping).toBeNull();
  });

  it("shopper: someone else's bid is null", async () => {
    expect(await shopperOrderTimeline(tdb.db.pool, loser.shopper, winner.bid)).toBeNull();
    expect(await shopperOrderTimeline(tdb.db.pool, loser.shopper, 'nope')).toBeNull();
  });
});
