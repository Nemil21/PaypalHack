/**
 * HF-022 integration tests: `/book` and `/simulate` read models on real Postgres, with holds
 * landed on the `FakePayPal` stub. Simulate is checked against a Clear dry-run (HF-027's
 * `clearListing` refusing with BOOK_CHANGED returns its own numbers and persists nothing).
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/listings/book
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookResponseSchema,
  clear,
  clearBidsFromBook,
  feeCents,
  simulateResponseSchema,
} from '@holdfast/shared';
import { auditHook } from '../audit.js';
import { loadClearInput } from '../clearInput.js';
import type { Db } from '../db.js';
import {
  StubPayPal,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient } from '../paypal/types.js';
import { recommend } from '../recommend.js';
import { NotFoundError } from '../tenancy.js';
import { SimulateQuantityError, loadBook, simulateListing } from './book.js';
import { clearListing, type ClearListingDeps } from './clear-listing.js';

const CARD = {
  number: '4111111111111111',
  expiry: '2030-12',
  security_code: '123',
  name: 'Book Buyer',
};
const BRAND_USER = { type: 'BRAND_USER', id: 'brand-user-1' };

/** Median wall time of 5 calls after 3 warm-ups (pool connections, JIT). */
async function medianMs(fn: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 3; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[2]!;
}

interface Listing {
  id: string;
  brandId: string;
}

interface SeedBid {
  amountCents: number;
  /** No PayPal hold (D8): HELD with `paypal_authorization_id IS NULL`. */
  noHold?: boolean;
  sim?: boolean;
  status?: 'HELD' | 'PENDING_APPROVAL' | 'VOIDING' | 'VOIDED';
  voidReason?: string;
  /** Explicit `placed_at` (to put many bids in the same millisecond). */
  placedAt?: string;
  ageHours?: number;
}

describe.skipIf(!TEST_DATABASE_URL)('HF-022 book and simulate', () => {
  let t: TestDatabase;
  let db: Db;
  let paypal: PayPalClient;
  const voids = new StubPayPal();

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows[0] as T;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    paypal = new FakePayPal().client({ timeoutMs: 1_000 });
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  function clearDeps(): ClearListingDeps {
    return { db, paypal: voids, voidBackoffMs: [0, 0, 0], audit: auditHook };
  }

  async function brand(feeBps = 900): Promise<string> {
    return (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email, fee_bps)
         VALUES ('Aurel Audio', 'payouts@aurel.example', $1) RETURNING id`,
        [feeBps],
      )
    ).id;
  }

  async function listing(
    cols: { brandId?: string; quantity?: number; floorCents?: number; quoteCents?: number } = {},
  ): Promise<Listing> {
    const brandId = cols.brandId ?? (await brand());
    const product = await one<{ id: string }>(
      `INSERT INTO products (title, image_url, best_public_price_cents, best_public_merchant,
                             channel3_subscription_id)
       VALUES ('Aurel A7 Wireless', 'https://img.example/a7.png', 27900, 'Retailer', 'sub_1')
       RETURNING id`,
    );
    const row = await one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, slug, status, quantity, floor_cents,
                             liquidation_quote_cents, window_opens_at, window_closes_at,
                             clear_deadline_at)
       VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, now() - interval '1 hour',
               now() + interval '24 hours', now() + interval '36 hours')
       RETURNING id`,
      [
        brandId,
        product.id,
        `a7-${randomUUID().slice(0, 8)}`,
        cols.quantity ?? 300,
        cols.floorCents ?? 19_900,
        cols.quoteCents ?? 3_800,
      ],
    );
    return { id: row.id, brandId };
  }

  /** Lands each hold on FakePayPal, then inserts all bids in one statement. */
  async function seed(l: Listing, bids: SeedBid[]): Promise<string[]> {
    const rows = await Promise.all(
      bids.map(async (b) => {
        const id = randomUUID();
        const status = b.status ?? 'HELD';
        let authId: string | null = null;
        let authorizedAt: string | null = null;
        if (!b.noHold && status !== 'PENDING_APPROVAL') {
          const hold = await paypal.createAuthOrder({
            requestId: orderRequestId(id),
            amountCents: b.amountCents,
            paymentSource: { kind: 'test_card', card: CARD, vault: false },
          });
          if (hold.kind !== 'held') throw new Error(`no hold: ${hold.kind}`);
          authId = hold.authorizationId;
          authorizedAt = b.ageHours
            ? new Date(Date.now() - b.ageHours * 3_600_000).toISOString()
            : hold.authorizedAt;
        }
        return {
          id,
          status,
          amount: b.amountCents,
          authId,
          authorizedAt,
          sim: b.sim ?? false,
          voidReason: b.voidReason ?? null,
          placedAt: b.placedAt ?? null,
        };
      }),
    );
    await db.pool.query(
      `WITH input AS (
         SELECT * FROM unnest($2::uuid[], $3::text[], $4::int[], $5::text[], $6::timestamptz[],
                              $7::bool[], $8::text[], $9::timestamptz[])
                  WITH ORDINALITY AS u(id, status, amount, auth_id, authorized_at, sim, void_reason,
                                       placed_at, ord)
       ), shoppers_in AS (
         INSERT INTO shoppers (email, is_simulated)
         SELECT 'shopper-' || id || '@example.com', sim FROM input ORDER BY ord
         RETURNING id AS shopper_id, email
       )
       INSERT INTO bids (id, listing_id, shopper_id, amount_cents, status, idempotency_key,
                         paypal_authorization_id, authorized_amount_cents, authorized_at, source,
                         void_reason, placed_at)
       SELECT i.id, $1, s.shopper_id, i.amount, i.status, i.id::text, i.auth_id,
              CASE WHEN i.auth_id IS NULL THEN NULL ELSE i.amount END, i.authorized_at,
              CASE WHEN i.sim THEN 'SIM' ELSE 'OFFER_PAGE' END, i.void_reason,
              coalesce(i.placed_at, clock_timestamp())
         FROM input i JOIN shoppers_in s ON s.email = 'shopper-' || i.id || '@example.com'
        ORDER BY i.ord`,
      [
        l.id,
        rows.map((r) => r.id),
        rows.map((r) => r.status),
        rows.map((r) => r.amount),
        rows.map((r) => r.authId),
        rows.map((r) => r.authorizedAt),
        rows.map((r) => r.sim),
        rows.map((r) => r.voidReason),
        rows.map((r) => r.placedAt),
      ],
    );
    return rows.map((r) => r.id);
  }

  /** Clear's own numbers for quantity `q`, persisting nothing (BOOK_CHANGED rolls back). */
  async function clearDryRun(l: Listing, q: number) {
    const out = await clearListing(clearDeps(), {
      listingId: l.id,
      brandId: l.brandId,
      quantity: q,
      expectedGrossCents: -1,
      actor: BRAND_USER,
    });
    if (out.ok || out.error.code !== 'STATE_CONFLICT') throw new Error('expected a refusal');
    return out.error;
  }

  const amounts = (n: number, from = 18_000, step = 37) =>
    Array.from({ length: n }, (_, i) => from + ((i * step) % 9_000));

  describe('300-bid book on FakePayPal', () => {
    let l: Listing;
    let noHoldIds: string[];

    beforeAll(async () => {
      l = await listing({ quantity: 300 });
      const all = amounts(300);
      await seed(
        l,
        all.map((a, i) => ({ amountCents: a, sim: i % 5 === 0 })),
      );
      noHoldIds = await seed(
        l,
        [{ amountCents: 40_000 }, { amountCents: 35_000 }].map((b) => ({ ...b, noHold: true })),
      );
      await seed(l, [
        { amountCents: 26_000, status: 'PENDING_APPROVAL' },
        { amountCents: 24_000, status: 'VOIDING' },
        { amountCents: 21_000, status: 'VOIDED', voidReason: 'PRICE_DROP' },
        { amountCents: 22_000, status: 'VOIDED', voidReason: 'PRICE_DROP' },
        { amountCents: 23_000, status: 'VOIDED', voidReason: 'CANCELLED' },
      ]);
    }, 60_000);

    it('book.bids is exactly the loadClearInput rows, ranked like clear()', async () => {
      const book = bookResponseSchema.parse(await loadBook(db, l.brandId, l.id));
      const input = (await loadClearInput(db.pool, l.id))!;
      expect(book.bids).toHaveLength(300);
      expect(new Set(book.bids.map((b) => b.id))).toEqual(new Set(input.bids.map((b) => b.id)));
      expect(book.bookVersion).toBe(input.bookVersion);

      const r = clear(input.bids, 300, input.floorCents);
      for (const b of book.bids) {
        expect(b.rank).toBe(r.rank[b.id] ?? null);
        expect(b.belowFloor).toBe(b.amountCents < input.floorCents);
        expect(b.placedAtUs).toMatch(/^\d{16}$/);
      }
      const ranks = book.bids.filter((b) => b.rank !== null).map((b) => b.rank);
      expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    });

    it('stats, curve and pending', async () => {
      const book = await loadBook(db, l.brandId, l.id);
      const input = (await loadClearInput(db.pool, l.id))!;
      const held = input.bids.reduce((s, b) => s + b.amountCents, 0);
      const sim = input.bids.filter((b) => b.isSimulated).reduce((s, b) => s + b.amountCents, 0);
      expect(book.stats).toEqual({
        liveBids: 300,
        heldCents: held,
        simulatedHeldCents: sim,
        bestPublicPriceCents: 27_900,
        releasedByPriceWatch: 2,
        simulatedNoHoldBids: 0,
      });
      expect(sim).toBeGreaterThan(0);
      expect(book.curve[0]).toMatchObject({ bidsAtOrAbove: 300, heldAtOrAboveCents: held });
      expect(book.curve.at(-1)!.priceCents).toBe(Math.max(...input.bids.map((b) => b.amountCents)));
      expect(book.pending.map((p) => [p.amountCents, p.status])).toEqual([
        [26_000, 'PENDING_APPROVAL'],
        [24_000, 'VOIDING'],
      ]);
      expect(book.listing).toMatchObject({
        id: l.id,
        status: 'OPEN',
        phase: 'BIDDING',
        quantity: 300,
        floorCents: 19_900,
        liquidationQuoteCents: 3_800,
        feeBps: 900,
        oldestHoldAuthorizedAt: input.oldestHoldAuthorizedAt,
        product: { title: 'Aurel A7 Wireless', imageUrl: 'https://img.example/a7.png' },
        priceWatch: { on: true, bestPublicPriceCents: 27_900, merchant: 'Retailer' },
      });
      expect(book.listing.clearByAt).not.toBeNull();
    });

    it('bids with no hold never appear in bids, heldCents, the curve or simulate (D8)', async () => {
      const book = await loadBook(db, l.brandId, l.id);
      const ids = new Set(book.bids.map((b) => b.id));
      for (const id of noHoldIds) expect(ids.has(id)).toBe(false);
      expect(book.pending.some((p) => noHoldIds.includes(p.id))).toBe(false);
      // The no-hold bids ($400, $350) sit above every held bid; the curve never reaches them.
      expect(book.curve.some((p) => p.priceCents >= 35_000)).toBe(false);
      const sim = await simulateListing(db, l.brandId, l.id, 300);
      for (const id of noHoldIds) expect(sim.winnerBidIds).not.toContain(id);
      expect(sim.grossCents).toBeLessThanOrEqual(book.stats.heldCents);
    });

    it('shopper labels are opaque, unique and stable', async () => {
      const a = await loadBook(db, l.brandId, l.id);
      const b = await loadBook(db, l.brandId, l.id);
      const labels = a.bids.map((x) => x.shopperLabel);
      expect(new Set(labels).size).toBe(labels.length);
      for (const s of labels) expect(s).toMatch(/^Shopper #\d+$/);
      expect(b.bids.map((x) => x.shopperLabel)).toEqual(labels);
      expect(JSON.stringify(a)).not.toContain('@example.com');
    });

    it('simulate equals the server Clear numbers at several quantities', async () => {
      for (const q of [1, 37, 150, 240, 300]) {
        const sim = simulateResponseSchema.parse(await simulateListing(db, l.brandId, l.id, q));
        const dry = await clearDryRun(l, q);
        expect(dry.reason).toBe('BOOK_CHANGED');
        expect(dry.numbers).toEqual({
          cutoffCents: sim.cutoffCents,
          grossCents: sim.grossCents,
          winners: sim.winners,
          bookVersion: sim.bookVersion,
        });
        expect(sim.feeCents).toBe(feeCents(sim.grossCents, 900));
        expect(sim.netCents).toBe(sim.grossCents - sim.feeCents);
        expect(sim.liquidationCents).toBe(sim.winners * 3_800);
      }
    });

    it('responds in < 200 ms', async () => {
      const bookMs = await medianMs(() => loadBook(db, l.brandId, l.id));
      const simMs = await medianMs(() => simulateListing(db, l.brandId, l.id, 240));
      expect(bookMs).toBeLessThan(200);
      expect(simMs).toBeLessThan(200);
    });

    it('another brand, or a malformed id, is NOT_FOUND', async () => {
      const other = await brand();
      await expect(loadBook(db, other, l.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(simulateListing(db, other, l.id, 1)).rejects.toBeInstanceOf(NotFoundError);
      await expect(loadBook(db, l.brandId, 'nope')).rejects.toBeInstanceOf(NotFoundError);
      await expect(loadBook(db, l.brandId, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('simulate rejects a quantity above the listing quantity', async () => {
      await expect(simulateListing(db, l.brandId, l.id, 301)).rejects.toBeInstanceOf(
        SimulateQuantityError,
      );
      expect((await simulateListing(db, l.brandId, l.id)).quantity).toBe(300);
    });
  });

  it('same-millisecond bulk bids: client rank sort = simulate winners = real Clear winners', async () => {
    const l = await listing({ quantity: 60, floorCents: 10_000 });
    const sameMs = '2026-11-11T10:00:00.123Z';
    await seed(
      l,
      Array.from({ length: 60 }, (_, i) => ({
        amountCents: [20_000, 21_000, 22_000][i % 3]!,
        placedAt: sameMs,
      })),
    );
    const book = await loadBook(db, l.brandId, l.id);
    expect(new Set(book.bids.map((b) => b.placedAtUs)).size).toBe(1);
    const q = 25;
    const sim = await simulateListing(db, l.brandId, l.id, q);
    const shuffled = [...book.bids].sort((a, b) => (a.id < b.id ? -1 : 1));
    const byRank = shuffled
      .sort((a, b) => a.rank! - b.rank!)
      .slice(0, q)
      .map((b) => b.id);
    expect(byRank).toEqual(sim.winnerBidIds);
    expect(clear(clearBidsFromBook(shuffled), q, 10_000).winners.map((b) => b.id)).toEqual(
      sim.winnerBidIds,
    );

    const out = await clearListing(clearDeps(), {
      listingId: l.id,
      brandId: l.brandId,
      quantity: q,
      expectedGrossCents: sim.grossCents,
      actor: BRAND_USER,
    });
    expect(out.ok).toBe(true);
    if (out.ok) await out.released;
    const won = await db.pool.query<{ id: string }>(
      `SELECT id FROM bids WHERE listing_id = $1 AND status = 'WON'`,
      [l.id],
    );
    expect(new Set(won.rows.map((r) => r.id))).toEqual(new Set(sim.winnerBidIds));
  });

  it('an aged winning hold shows in holdsTooOldBidIds and Clear refuses it too (D6)', async () => {
    const l = await listing({ quantity: 5, floorCents: 10_000 });
    const [aged] = await seed(l, [{ amountCents: 30_000, ageHours: 70 }]);
    await seed(l, [{ amountCents: 20_000 }, { amountCents: 15_000 }]);
    const sim = await simulateListing(db, l.brandId, l.id, 2);
    expect(sim.holdsTooOldBidIds).toEqual([aged]);
    const dry = await clearDryRun(l, 2);
    expect(dry).toMatchObject({ reason: 'HOLDS_TOO_OLD', bidIds: [aged] });
  });

  it('property: for random books, simulate and clear(book.bids) gross equal a Clear dry-run', async () => {
    const brandId = await brand(750);
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            amountCents: fc.integer({ min: 50, max: 300 }).map((n) => n * 100),
            noHold: fc.integer({ min: 0, max: 9 }).map((n) => n < 2),
            sim: fc.boolean(),
            sameMs: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        fc.integer({ min: 1, max: 45 }),
        fc.integer({ min: 50, max: 300 }).map((n) => n * 100),
        async (raw, q, floorCents) => {
          const l = await listing({ brandId, quantity: 45, floorCents });
          await seed(
            l,
            raw.map((b) => ({
              amountCents: b.amountCents,
              noHold: b.noHold,
              sim: b.sim,
              placedAt: b.sameMs ? '2026-11-11T09:00:00.000Z' : undefined,
            })),
          );
          const [book, sim, dry] = [
            await loadBook(db, brandId, l.id),
            await simulateListing(db, brandId, l.id, q),
            await clearDryRun(l, q),
          ];
          expect(dry.numbers!.grossCents).toBe(sim.grossCents);
          expect(dry.numbers!.cutoffCents).toBe(sim.cutoffCents);
          expect(dry.numbers!.winners).toBe(sim.winners);
          const client = clear(clearBidsFromBook(book.bids), q, book.listing.floorCents);
          expect(client.grossCents).toBe(dry.numbers!.grossCents);
          expect(client.winners.map((b) => b.id)).toEqual(sim.winnerBidIds);
          expect(sim.feeCents).toBe(feeCents(sim.grossCents, 750));
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);

  describe('HF-051a brand agent recommendation on /book', () => {
    it('Aurel demo book: 240 at $219 from the same snapshot, matching /simulate', async () => {
      const l = await listing({ quantity: 300 });
      await db.pool.query(`UPDATE brands SET max_discount_bps = 2200 WHERE id = $1`, [l.brandId]);
      const amounts = [
        ...Array<number>(120).fill(22_900),
        ...Array<number>(60).fill(22_700),
        ...Array<number>(60).fill(21_900),
        ...Array<number>(30).fill(21_500),
        ...Array<number>(16).fill(19_900),
      ];
      await seed(
        l,
        amounts.map((a, i) => ({ amountCents: a, sim: i % 4 === 0 })),
      );
      await seed(l, [{ amountCents: 40_000, noHold: true }]); // D8: never counted

      const book = bookResponseSchema.parse(await loadBook(db, l.brandId, l.id));
      expect(book.recommendation).toMatchObject({
        kind: 'RECOMMEND',
        quantity: 240,
        cutoffCents: 21_900,
        grossCents: 5_424_000,
        netCents: 5_424_000 - feeCents(5_424_000, 900),
        liquidationCents: 240 * 3_800,
        minCutoffCents: 21_762,
      });
      const input = (await loadClearInput(db.pool, l.id))!;
      expect(book.recommendation).toEqual(
        recommend(input, {
          listingQuantity: 300,
          feeBps: 900,
          liquidationQuoteCents: 3_800,
          publicLowCents: 27_900,
          maxDiscountBps: 2_200,
        }),
      );
      const sim = await simulateListing(db, l.brandId, l.id, 240);
      expect(book.recommendation).toMatchObject({
        cutoffCents: sim.cutoffCents,
        grossCents: sim.grossCents,
        netCents: sim.netCents,
        liquidationCents: sim.liquidationCents,
      });

      // Without a max discount the floor is the only guard: clear every qualifying bid.
      await db.pool.query(`UPDATE brands SET max_discount_bps = NULL WHERE id = $1`, [l.brandId]);
      const open = await loadBook(db, l.brandId, l.id);
      expect(open.recommendation).toMatchObject({ kind: 'RECOMMEND', quantity: 286 });
    });

    it('no bids → NO_DEMAND', async () => {
      const l = await listing();
      const book = await loadBook(db, l.brandId, l.id);
      expect(book.recommendation).toEqual({ kind: 'NO_DEMAND', minCutoffCents: 19_900 });
    });
  });

  it('feeCents rounds exactly like Postgres integer math', async () => {
    const cases = fc.sample(
      fc.tuple(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 0, max: 10_000 })),
      500,
    );
    cases.push([5, 900], [6, 900], [5_424_000, 900], [0, 0], [55_555, 10_000], [1, 5_000]);
    const { rows } = await db.pool.query<{ fee: string }>(
      `SELECT ((g * b + 5000) / 10000)::text AS fee
         FROM unnest($1::bigint[], $2::bigint[]) WITH ORDINALITY AS u(g, b, ord) ORDER BY ord`,
      [cases.map((c) => c[0]), cases.map((c) => c[1])],
    );
    expect(rows.map((r) => Number(r.fee))).toEqual(cases.map(([g, b]) => feeCents(g, b)));
  });
});
