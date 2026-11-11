/**
 * HF-023 `dev:bids`: SIM bids land HELD through `landHold` with stub holds, show up in the book as
 * simulated, publish `bid.held`, and a closed window refuses them. Needs TEST_DATABASE_URL.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LISTING_EVENTS_CHANNEL, loadBook } from '@holdfast/core';
import { listingEventNoticeSchema } from '@holdfast/shared';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import {
  placeSimBid,
  raiseSimBid,
  releaseSimBid,
  resolveSimListing,
  simBidAmount,
  STUB_AUTH_PREFIX,
  type SimListing,
} from './sim-bids.js';

describe('simBidAmount', () => {
  const listing: SimListing = { id: 'x', slug: null, floorCents: 19_900, publicCents: 27_900 };

  it('whole dollars, mostly between floor and public low, sometimes just under the floor', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16_807) % 2_147_483_647) - 1) / 2_147_483_646;
    const amounts = Array.from({ length: 500 }, () => simBidAmount(listing, random));
    expect(amounts.every((a) => a % 100 === 0 && a > 0 && a <= 27_900)).toBe(true);
    const below = amounts.filter((a) => a < 19_900).length;
    expect(below).toBeGreaterThan(0);
    expect(below).toBeLessThan(150);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('HF-023 dev:bids against Postgres', () => {
  let tdb: TestDatabase;
  let brandId: string;
  let open: string;
  let closed: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;

  async function listing(slug: string, window: string): Promise<string> {
    const product = await one<{ id: string }>(
      `INSERT INTO products (title, best_public_price_cents) VALUES ($1, 27900) RETURNING id`,
      [slug],
    );
    return (
      await one<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, slug, status, quantity, floor_cents,
                               window_opens_at, window_closes_at)
         VALUES ($1, $2, $3, 'OPEN', 10, 19900, now() - interval '2 hours', ${window})
         RETURNING id`,
        [brandId, product.id, slug],
      )
    ).id;
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    brandId = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'p@aurel.example') RETURNING id`,
      )
    ).id;
    closed = await listing('closed', `now() - interval '1 hour'`);
    open = await listing('open', `now() + interval '24 hours'`);
  }, 60_000);

  afterAll(async () => {
    await tdb?.close();
  });

  it('resolves the newest biddable listing, or one by slug or id', async () => {
    expect((await resolveSimListing(tdb.db))?.id).toBe(open);
    expect((await resolveSimListing(tdb.db, 'closed'))?.id).toBe(closed);
    expect((await resolveSimListing(tdb.db, open))?.slug).toBe('open');
    expect(await resolveSimListing(tdb.db, 'nope')).toBeNull();
  });

  it('lands HELD SIM bids with stub holds and publishes bid.held for each', async () => {
    const listener = new pg.Client({ connectionString: tdb.url });
    await listener.connect();
    const notices: unknown[] = [];
    listener.on('notification', (n) => notices.push(JSON.parse(n.payload!)));
    await listener.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
    try {
      const target = (await resolveSimListing(tdb.db))!;
      const results = [];
      for (const amount of [21_900, 22_900, 23_900]) {
        results.push(await placeSimBid(tdb.db, target, amount));
      }
      expect(results.every((r) => r.ok)).toBe(true);

      const rows = (
        await tdb.db.pool.query(
          `SELECT b.status, b.source, b.paypal_authorization_id, s.is_simulated
             FROM bids b JOIN shoppers s ON s.id = b.shopper_id WHERE b.listing_id = $1`,
          [open],
        )
      ).rows;
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r).toMatchObject({ status: 'HELD', source: 'SIM', is_simulated: true });
        expect(r.paypal_authorization_id.startsWith(STUB_AUTH_PREFIX)).toBe(true);
      }

      const book = await loadBook(tdb.db, brandId, open);
      expect(book.stats).toMatchObject({
        liveBids: 3,
        heldCents: 68_700,
        simulatedHeldCents: 68_700,
      });

      await new Promise((r) => setTimeout(r, 100));
      const held = notices
        .map((n) => listingEventNoticeSchema.parse(n))
        .filter((n) => n.type === 'bid.held' && n.listingId === open);
      expect(held.map((n) => n.ids.bidId).sort()).toEqual(results.map((r) => r.bidId).sort());
    } finally {
      await listener.end();
    }
  });

  it('--raise swaps one SIM hold (bid.held + bid.raised); the book keeps the shopper label', async () => {
    const listener = new pg.Client({ connectionString: tdb.url });
    await listener.connect();
    const notices: unknown[] = [];
    listener.on('notification', (n) => notices.push(JSON.parse(n.payload!)));
    await listener.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
    try {
      const target = (await resolveSimListing(tdb.db, 'open'))!;
      const before = await loadBook(tdb.db, brandId, open);
      const r = await raiseSimBid(tdb.db, target, () => 0);
      if (!r.ok) throw new Error(r.reason);
      expect(r.toCents - r.fromCents).toBe(1_000);

      const old = await one<{ status: string; void_reason: string }>(
        `SELECT status, void_reason FROM bids WHERE id = $1`,
        [r.replacesBidId],
      );
      expect(old).toMatchObject({ status: 'VOIDED', void_reason: 'REPLACED' });

      const after = await loadBook(tdb.db, brandId, open);
      expect(after.stats.liveBids).toBe(before.stats.liveBids);
      const was = before.bids.find((b) => b.id === r.replacesBidId)!;
      const now = after.bids.find((b) => b.id === r.bidId)!;
      expect(now).toMatchObject({ amountCents: r.toCents, isSimulated: true });
      // The grid's fallback match for a missed bid.raised notice (HF-025) relies on this.
      expect(now.shopperLabel).toBe(was.shopperLabel);

      await new Promise((res) => setTimeout(res, 100));
      const parsed = notices.map((n) => listingEventNoticeSchema.parse(n));
      expect(parsed.find((n) => n.type === 'bid.raised')?.ids).toEqual({
        bidId: r.bidId,
        replacesBidId: r.replacesBidId,
      });
    } finally {
      await listener.end();
    }
  });

  it('--release voids one SIM hold and it leaves the book', async () => {
    const target = (await resolveSimListing(tdb.db, 'open'))!;
    const before = await loadBook(tdb.db, brandId, open);
    const r = await releaseSimBid(tdb.db, target, () => 0);
    if (!r.ok) throw new Error(r.reason);
    const after = await loadBook(tdb.db, brandId, open);
    expect(after.stats.liveBids).toBe(before.stats.liveBids - 1);
    expect(after.bids.some((b) => b.id === r.bidId)).toBe(false);
    expect(after.pending.some((b) => b.id === r.bidId)).toBe(false);
  });

  it('a closed window refuses the bid like a real hold (D7)', async () => {
    const target = (await resolveSimListing(tdb.db, 'closed'))!;
    const r = await placeSimBid(tdb.db, target, 21_900);
    expect(r).toMatchObject({ ok: false, reason: 'WINDOW_CLOSED' });
    const bid = await one<{ status: string }>(`SELECT status FROM bids WHERE id = $1`, [r.bidId]);
    expect(bid.status).toBe('VOIDED');
  });
});
