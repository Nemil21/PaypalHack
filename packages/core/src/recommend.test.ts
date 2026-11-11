/**
 * HF-051a: the brand agent recommendation equals the brute-force optimum (features/09 §Acceptance
 * criteria) on 5 fixture books, with and without the max-discount guard binding, and on random
 * books (fast-check). The brute force below shares no code with `recommend()`: it dedupes, ranks
 * and sums by hand.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  feeCents,
  recommendationSchema,
  simulateClear,
  type ClearBid,
  type ClearInput,
} from '@holdfast/shared';
import { minCutoffCents, recommend, type RecommendOptions } from './recommend.js';

let nextId = 0;
function bid(amountCents: number, o: Partial<ClearBid> = {}): ClearBid {
  const n = nextId++;
  return {
    id: `b${String(n).padStart(5, '0')}`,
    shopperId: `s${n}`,
    amountCents,
    seq: n,
    placedAt: '2026-11-11T10:00:00.000000Z',
    status: 'HELD',
    paypalAuthorizationId: `auth-${n}`,
    authorizedAt: '2026-11-11T10:00:00.000000Z',
    isSimulated: false,
    ...o,
  };
}
const many = (count: number, amountCents: number) =>
  Array.from({ length: count }, () => bid(amountCents));

function book(bids: ClearBid[], floorCents: number, quantity: number): ClearInput {
  return {
    listingId: 'l1',
    floorCents,
    quantity,
    bids,
    bookVersion: 'v1',
    oldestHoldAuthorizedAt: null,
  };
}

const AUREL: Omit<RecommendOptions, 'listingQuantity'> = {
  feeBps: 900,
  liquidationQuoteCents: 3_800,
  publicLowCents: 27_900,
  maxDiscountBps: 2_200,
};

/** Independent optimum: max net over Q with cutoff ≥ guard; ties → smaller Q. */
function bruteForce(input: ClearInput, opts: RecommendOptions) {
  const best = new Map<string, ClearBid>();
  for (const b of input.bids) {
    if (b.status !== 'HELD' || !b.paypalAuthorizationId) continue;
    const cur = best.get(b.shopperId);
    const better =
      !cur ||
      b.amountCents > cur.amountCents ||
      (b.amountCents === cur.amountCents &&
        (b.seq < cur.seq || (b.seq === cur.seq && b.id < cur.id)));
    if (better) best.set(b.shopperId, b);
  }
  const amounts = [...best.values()]
    .filter((b) => b.amountCents >= input.floorCents)
    .map((b) => b.amountCents)
    .sort((a, b) => b - a);
  let guard = input.floorCents;
  if (opts.publicLowCents !== null && opts.maxDiscountBps !== null) {
    // Exact rational compare: cutoff × 10000 ≥ (10000 − bps) × public low.
    guard = Math.max(
      guard,
      Math.ceil(((10_000 - opts.maxDiscountBps) * opts.publicLowCents) / 10_000),
    );
  }
  let answer: {
    quantity: number;
    cutoffCents: number;
    grossCents: number;
    netCents: number;
  } | null = null;
  for (let q = 1; q <= Math.min(opts.listingQuantity, amounts.length); q++) {
    const top = amounts.slice(0, q);
    const cutoff = top[q - 1]!;
    const gross = top.reduce((s, a) => s + a, 0);
    const net = gross - feeCents(gross, opts.feeBps);
    if (cutoff < guard) continue;
    if (!answer || net > answer.netCents) {
      answer = { quantity: q, cutoffCents: cutoff, grossCents: gross, netCents: net };
    }
  }
  return { answer, qualifying: amounts.length };
}

function expectOptimum(input: ClearInput, opts: RecommendOptions) {
  const r = recommend(input, opts);
  recommendationSchema.parse(r);
  const { answer, qualifying } = bruteForce(input, opts);
  if (answer === null) {
    expect(r.kind).toBe(qualifying === 0 ? 'NO_DEMAND' : 'BELOW_GUARD');
    return r;
  }
  expect(r).toMatchObject({ kind: 'RECOMMEND', ...answer });
  return r;
}

describe('recommend() on 5 fixture books', () => {
  it('Aurel demo book: the 22% guard binds → 240 at $219, $54,240 gross', () => {
    // 240 bids at ≥ $219 (lowest $219, average $226) and 46 between the floor and the guard.
    const bids = [
      ...many(120, 22_900),
      ...many(60, 22_700),
      ...many(60, 21_900),
      ...many(30, 21_500),
      ...many(16, 19_900),
    ];
    const input = book(bids, 19_900, 300);
    const opts = { ...AUREL, listingQuantity: 300 };
    const r = expectOptimum(input, opts);
    expect(minCutoffCents(19_900, 27_900, 2_200)).toBe(21_762); // $279 × 0.78 = $217.62
    expect(r).toEqual({
      kind: 'RECOMMEND',
      quantity: 240,
      cutoffCents: 21_900,
      grossCents: 5_424_000,
      netCents: 5_424_000 - 488_160,
      liquidationCents: 240 * 3_800,
      withinGuard: true,
      minCutoffCents: 21_762,
      alternatives: [
        // Clear every qualifying bid: more gross, but 29% under the public price.
        {
          quantity: 286,
          cutoffCents: 19_900,
          grossCents: 5_424_000 + 30 * 21_500 + 16 * 19_900,
          netCents: expect.any(Number),
          liquidationCents: 286 * 3_800,
          withinGuard: false,
        },
        // The next higher cutoff.
        {
          quantity: 180,
          cutoffCents: 22_700,
          grossCents: 120 * 22_900 + 60 * 22_700,
          netCents: expect.any(Number),
          liquidationCents: 180 * 3_800,
          withinGuard: true,
        },
      ],
    });
  });

  it('guard does not bind: every qualifying bid clears', () => {
    const bids = [...many(50, 25_000), ...many(30, 23_000), ...many(10, 22_000)];
    const r = expectOptimum(book(bids, 19_900, 300), { ...AUREL, listingQuantity: 300 });
    expect(r).toMatchObject({ kind: 'RECOMMEND', quantity: 90, cutoffCents: 22_000 });
    // Nothing more to clear; alternatives step up the cutoff instead.
    if (r.kind !== 'RECOMMEND') throw new Error('expected RECOMMEND');
    expect(r.alternatives.map((a) => [a.quantity, a.cutoffCents])).toEqual([
      [80, 23_000],
      [50, 25_000],
    ]);
  });

  it('no public price (or no max discount): floor only, capped at the listing quantity', () => {
    const bids = [...many(40, 30_000), ...many(40, 20_000), ...many(5, 15_000)];
    const opts = { ...AUREL, listingQuantity: 60, publicLowCents: null };
    const r = expectOptimum(book(bids, 19_900, 60), opts);
    expect(r).toMatchObject({ kind: 'RECOMMEND', quantity: 60, cutoffCents: 20_000 });
    expectOptimum(book(bids, 19_900, 60), {
      ...opts,
      publicLowCents: 27_900,
      maxDiscountBps: null,
    });
  });

  it('dedupes shoppers, skips no-hold and below-floor bids; guard binds inside a price tie', () => {
    const twice = bid(26_000, { shopperId: 'dup' });
    const bids = [
      twice,
      bid(24_000, { shopperId: 'dup' }), // superseded by the same shopper's $260
      bid(28_000, { paypalAuthorizationId: null }), // no hold (D8)
      bid(27_000, { status: 'VOIDING' }),
      ...many(5, 24_000),
      ...many(3, 21_762), // exactly at the guard: allowed
      ...many(4, 21_761), // one cent under: not allowed
      ...many(6, 18_000), // below the floor
    ];
    const r = expectOptimum(book(bids, 19_900, 300), { ...AUREL, listingQuantity: 300 });
    expect(r).toMatchObject({ kind: 'RECOMMEND', quantity: 9, cutoffCents: 21_762 });
  });

  it('nothing within the guard → BELOW_GUARD; nothing at the floor → NO_DEMAND', () => {
    const below = book([...many(10, 21_000), ...many(5, 20_000)], 19_900, 300);
    const r = expectOptimum(below, { ...AUREL, listingQuantity: 300 });
    expect(r).toMatchObject({ kind: 'BELOW_GUARD', minCutoffCents: 21_762, bestBidCents: 21_000 });
    if (r.kind !== 'BELOW_GUARD') throw new Error('expected BELOW_GUARD');
    expect(r.alternatives).toMatchObject([
      { quantity: 15, cutoffCents: 20_000, withinGuard: false },
    ]);

    expect(recommend(book([], 19_900, 300), { ...AUREL, listingQuantity: 300 })).toEqual({
      kind: 'NO_DEMAND',
      minCutoffCents: 21_762,
    });
    expectOptimum(book(many(4, 15_000), 19_900, 300), { ...AUREL, listingQuantity: 300 });
  });
});

describe('recommend() on random books', () => {
  const arbBook = fc.record({
    floorCents: fc.integer({ min: 100, max: 30_000 }),
    quantity: fc.integer({ min: 1, max: 40 }),
    feeBps: fc.integer({ min: 0, max: 2_000 }),
    publicLowCents: fc.option(fc.integer({ min: 100, max: 40_000 })),
    maxDiscountBps: fc.option(fc.integer({ min: 0, max: 10_000 })),
    bids: fc.array(
      fc.record({
        amountCents: fc.integer({ min: 100, max: 40_000 }),
        shopper: fc.integer({ min: 0, max: 30 }),
        held: fc.boolean(),
      }),
      { maxLength: 60 },
    ),
  });

  it('equals the brute-force optimum, and every option equals simulateClear()', () => {
    fc.assert(
      fc.property(arbBook, (b) => {
        const bids = b.bids.map((x, i) =>
          bid(x.amountCents, {
            id: `r${String(i).padStart(3, '0')}`,
            shopperId: `s${x.shopper}`,
            seq: i,
            paypalAuthorizationId: x.held || i % 3 ? `auth-${i}` : null,
          }),
        );
        const input = book(bids, b.floorCents, b.quantity);
        const opts: RecommendOptions = {
          listingQuantity: b.quantity,
          feeBps: b.feeBps,
          liquidationQuoteCents: 3_800,
          publicLowCents: b.publicLowCents,
          maxDiscountBps: b.maxDiscountBps,
        };
        const r = expectOptimum(input, opts);
        if (r.kind === 'NO_DEMAND') return;
        const options = r.kind === 'RECOMMEND' ? [r, ...r.alternatives] : r.alternatives;
        for (const o of options) {
          const s = simulateClear(input, o.quantity, {
            feeBps: b.feeBps,
            liquidationQuoteCents: 3_800,
          });
          expect(o).toMatchObject({
            cutoffCents: s.cutoffCents,
            grossCents: s.grossCents,
            netCents: s.netCents,
            liquidationCents: s.liquidationCents,
          });
        }
        expect(new Set(options.map((o) => o.quantity)).size).toBe(options.length);
      }),
      { numRuns: 300 },
    );
  });

  it('scans a 5k-bid book quickly', () => {
    const bids = Array.from({ length: 5_000 }, (_, i) => bid(20_000 + ((i * 7919) % 9_000)));
    const t0 = performance.now();
    const r = recommend(book(bids, 19_900, 5_000), { ...AUREL, listingQuantity: 5_000 });
    expect(r.kind).toBe('RECOMMEND');
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
