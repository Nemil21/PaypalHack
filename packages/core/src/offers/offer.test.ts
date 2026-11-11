/**
 * HF-019 `loadOffer` on Postgres. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/offers
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../money/test-harness.js';
import { loadOffer } from './offer.js';

describe.skipIf(!TEST_DATABASE_URL)('loadOffer (HF-019)', () => {
  let tdb: TestDatabase;
  let fx: Fixtures;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
  }, 60_000);
  afterAll(async () => {
    await tdb?.close();
  });

  async function offerListing(opts: { quantity?: number; status?: string } = {}) {
    const l = await fx.listing({ status: opts.status });
    const slug = `aurel-a7-${l.id.slice(0, 8)}`;
    await tdb.db.pool.query(`UPDATE listings SET slug = $2, quantity = $3 WHERE id = $1`, [
      l.id,
      slug,
      opts.quantity ?? 3,
    ]);
    await tdb.db.pool.query(
      `UPDATE products p SET title = 'Aurel A7 Wireless — Midnight', image_url = 'https://img.example/a7.png',
              best_public_price_cents = 27900, best_public_merchant = 'retailer.example',
              best_public_offer_url = 'https://retailer.example/a7', price_updated_at = now()
         FROM listings l WHERE l.product_id = p.id AND l.id = $1`,
      [l.id],
    );
    await tdb.db.pool.query(
      `UPDATE brands b SET verification_status = 'VERIFIED' FROM listings l
        WHERE l.brand_id = b.id AND l.id = $1`,
      [l.id],
    );
    return { id: l.id, slug };
  }

  it('shows the product, anchor, suggestion and band; no floor anywhere', async () => {
    const l = await offerListing({ quantity: 3 });
    for (const amount of [22_900, 22_500, 22_100, 20_500]) {
      const s = await fx.shopper();
      await fx.heldBid(l.id, s.id, { amountCents: amount });
    }
    const view = await loadOffer(tdb.db.pool, l.slug, null);
    expect(view).toMatchObject({
      listingId: l.id,
      brand: { name: 'Aurel Audio', verified: true },
      product: { title: 'Aurel A7 Wireless — Midnight', bestPublicPriceCents: 27_900 },
      publicOffer: { merchant: 'retailer.example', priceCents: 27_900 },
      status: 'OPEN',
      phase: 'BIDDING',
      biddable: true,
      suggestedBidCents: 22_900,
      // $229/$225/$221 make one band; the lone $205 merges into it (< 3 bids).
      likelyBand: { fromCents: 20_000, toCents: 23_000 },
      myBid: null,
    });
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/floor/i);
    expect(json).not.toMatch(/:10000[,}]/); // fixture floor_cents as a value
  });

  it('changing the floor never changes the response (M22)', async () => {
    const l = await offerListing({ quantity: 2 });
    for (const amount of [24_900, 23_900, 21_900]) {
      const s = await fx.shopper();
      await fx.heldBid(l.id, s.id, { amountCents: amount });
    }
    const before = JSON.stringify(await loadOffer(tdb.db.pool, l.slug, null));
    for (const floor of [100, 21_900, 23_000, 25_000, 99_900]) {
      await tdb.db.pool.query(`UPDATE listings SET floor_cents = $2 WHERE id = $1`, [l.id, floor]);
      expect(JSON.stringify(await loadOffer(tdb.db.pool, l.slug, null))).toBe(before);
    }
  });

  it("the brand agent's guard and recommendation never reach the offer (HF-051a)", async () => {
    const l = await offerListing({ quantity: 2 });
    for (const amount of [24_900, 23_900, 21_900]) {
      const s = await fx.shopper();
      await fx.heldBid(l.id, s.id, { amountCents: amount });
    }
    const before = JSON.stringify(await loadOffer(tdb.db.pool, l.slug, null));
    expect(before).not.toMatch(/recommend|discount|minCutoff/i);
    for (const bps of [0, 1_000, 2_200, 10_000, null]) {
      await tdb.db.pool.query(
        `UPDATE brands b SET max_discount_bps = $2 FROM listings l
          WHERE l.brand_id = b.id AND l.id = $1`,
        [l.id, bps],
      );
      for (const floor of [100, 23_000]) {
        await tdb.db.pool.query(`UPDATE listings SET floor_cents = $2 WHERE id = $1`, [
          l.id,
          floor,
        ]);
        expect(JSON.stringify(await loadOffer(tdb.db.pool, l.slug, null))).toBe(before);
      }
    }
  });

  it('shows only the suggestion while eligible bids < quantity; ignores bids with no hold', async () => {
    const l = await offerListing({ quantity: 5 });
    const s = await fx.shopper();
    await fx.heldBid(l.id, s.id, { amountCents: 22_900 });
    await fx.pendingBid(l.id, (await fx.shopper()).id, { amountCents: 22_900 });
    const view = await loadOffer(tdb.db.pool, l.slug, null);
    expect(view?.likelyBand).toBeNull();
    expect(view?.suggestedBidCents).toBe(22_900);
  });

  it("returns the shopper's live bid as myBid", async () => {
    const l = await offerListing();
    const s = await fx.shopper();
    const other = await fx.shopper();
    const bid = await fx.heldBid(l.id, s.id, { amountCents: 23_400 });
    expect((await loadOffer(tdb.db.pool, l.slug, s.id))?.myBid).toMatchObject({
      bidId: bid.id,
      status: 'HELD',
      amountCents: 23_400,
      releaseIfCheaper: true,
    });
    expect((await loadOffer(tdb.db.pool, l.slug, other.id))?.myBid).toBeNull();
  });

  it('hides DRAFT and unknown slugs; closed windows are not biddable', async () => {
    const draft = await offerListing({ status: 'DRAFT' });
    expect(await loadOffer(tdb.db.pool, draft.slug, null)).toBeNull();
    expect(await loadOffer(tdb.db.pool, 'nope', null)).toBeNull();
    const closed = await offerListing();
    await tdb.db.pool.query(
      `UPDATE listings SET window_closes_at = now() - interval '1 minute' WHERE id = $1`,
      [closed.id],
    );
    expect(await loadOffer(tdb.db.pool, closed.slug, null)).toMatchObject({
      status: 'OPEN',
      biddable: false,
      phase: 'AWAITING_ROUNDS_OR_CLEAR',
    });
  });
});
