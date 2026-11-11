import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { books, summarize, toClearBid } from '../fixtures/books.js';
import { clear, compareBids } from './auction.js';
import type { ClearBid } from './clear.js';
import { isEligibleBid } from './eligibility.js';
import { BID_STATUSES } from './status.js';

describe('clear() shared fixtures', () => {
  it.each(books.map((b) => [b.name, b] as const))('%s', (_name, book) => {
    const r = clear(book.bids.map(toClearBid), book.q, book.floorCents);
    expect(summarize(r)).toEqual(book.expect);
    expect(r.rank).toEqual(
      Object.fromEntries(
        [...book.expect.winners, ...book.expect.reserve].map((id, i) => [id, i + 1]),
      ),
    );
  });
});

describe('clear() input validation', () => {
  const bid = toClearBid({ id: 'a', shopperId: 's1', amountCents: 20000, seq: 1 });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects q = %s', (q) => {
    expect(() => clear([bid], q, 100)).toThrow(RangeError);
  });

  it.each([-1, 0.5, Number.NaN])('rejects floor = %s', (floor) => {
    expect(() => clear([bid], 1, floor)).toThrow(RangeError);
  });

  it.each([0, -100, 199.5, Number.NaN, 2 ** 53])('rejects amount = %s', (amountCents) => {
    expect(() => clear([{ ...bid, amountCents }], 1, 100)).toThrow(RangeError);
  });

  it('rejects a non-integer seq and duplicate ids', () => {
    expect(() => clear([{ ...bid, seq: 1.5 }], 1, 100)).toThrow(RangeError);
    expect(() => clear([bid, { ...bid }], 1, 100)).toThrow(/duplicate/);
  });
});

describe('isEligibleBid (D8)', () => {
  const held = toClearBid({ id: 'a', shopperId: 's1', amountCents: 20000, seq: 1 });

  it('needs HELD and an authorization id', () => {
    expect(isEligibleBid(held)).toBe(true);
    expect(isEligibleBid({ ...held, paypalAuthorizationId: null })).toBe(false);
    expect(isEligibleBid({ ...held, paypalAuthorizationId: '' })).toBe(false);
    for (const status of BID_STATUSES.filter((s) => s !== 'HELD')) {
      expect(isEligibleBid({ ...held, status })).toBe(false);
    }
  });

  it('can be replaced through opts.eligible', () => {
    const sim = {
      ...held,
      id: 'b',
      shopperId: 's2',
      paypalAuthorizationId: null,
      isSimulated: true,
    };
    const r = clear([held, sim], 2, 100, { eligible: (b) => b.isSimulated || isEligibleBid(b) });
    expect(r.winners.map((b) => b.id)).toEqual(['a', 'b']);
  });
});

// --- properties (features/10 acceptance, 1k random books) --------------------------------------

const arbBid: fc.Arbitrary<ClearBid> = fc.record({
  // Mixed-case ids so ordinal and locale order disagree.
  id: fc.string({
    unit: fc.constantFrom('a', 'b', 'A', 'B', '0', '_'),
    minLength: 1,
    maxLength: 6,
  }),
  // Few shoppers and amounts so duplicates and ties are common.
  shopperId: fc.constantFrom('s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'),
  amountCents: fc.integer({ min: 1, max: 40 }).map((n) => n * 500),
  seq: fc.integer({ min: 1, max: 30 }),
  placedAt: fc.constant('2026-11-11T10:00:00.000000Z'),
  status: fc.constantFrom(...BID_STATUSES, 'HELD', 'HELD', 'HELD'),
  paypalAuthorizationId: fc.option(fc.constant('AUTH'), { freq: 5 }),
  authorizedAt: fc.constant(null),
  isSimulated: fc.boolean(),
});

const arbBook = fc.record({
  bids: fc.uniqueArray(arbBid, { selector: (b) => b.id, maxLength: 40 }),
  q: fc.integer({ min: 1, max: 15 }),
  floorCents: fc.integer({ min: 0, max: 20000 }),
});

const runs = { numRuns: 1000 };

describe('clear() properties', () => {
  it('holds every features/10 invariant', () => {
    fc.assert(
      fc.property(arbBook, ({ bids, q, floorCents }) => {
        const r = clear(bids, q, floorCents);
        const { winners, reserve, belowFloor, superseded, ineligible, cutoffCents } = r;

        // Every bid lands in exactly one bucket.
        const all = [...winners, ...reserve, ...belowFloor, ...superseded, ...ineligible];
        expect(all.map((b) => b.id).sort()).toEqual(bids.map((b) => b.id).sort());

        // Winners ≤ Q, and = min(Q, ranked eligible).
        expect(winners.length).toBeLessThanOrEqual(q);
        expect(winners.length).toBe(Math.min(q, winners.length + reserve.length));
        if (reserve.length > 0) expect(winners.length).toBe(q);

        // Every winner ≥ cutoff ≥ floor; every eligible loser ≤ cutoff.
        if (winners.length === 0) {
          expect(cutoffCents).toBeNull();
        } else {
          expect(cutoffCents).toBe(Math.min(...winners.map((w) => w.amountCents)));
          for (const w of winners) expect(w.amountCents).toBeGreaterThanOrEqual(cutoffCents!);
          expect(cutoffCents!).toBeGreaterThanOrEqual(floorCents);
          for (const l of [...reserve, ...belowFloor])
            expect(l.amountCents).toBeLessThanOrEqual(cutoffCents!);
        }
        for (const b of reserve) expect(b.amountCents).toBeGreaterThanOrEqual(floorCents);
        for (const b of belowFloor) expect(b.amountCents).toBeLessThan(floorCents);

        // Each winner's charge is their own bid (the input bid, untouched).
        for (const w of winners) expect(bids).toContain(w);

        // ≤ 1 win per shopper; one ranked bid per shopper; superseded only behind a better own bid.
        const kept = [...winners, ...reserve, ...belowFloor];
        expect(new Set(winners.map((w) => w.shopperId)).size).toBe(winners.length);
        expect(new Set(kept.map((b) => b.shopperId)).size).toBe(kept.length);
        for (const s of superseded) {
          const own = kept.find((b) => b.shopperId === s.shopperId);
          expect(own && compareBids(own, s) < 0).toBe(true);
        }

        // Gross = integer sum of winners' amounts.
        expect(r.grossCents).toBe(winners.reduce((sum, w) => sum + w.amountCents, 0));
        expect(Number.isInteger(r.grossCents)).toBe(true);

        // No-hold or non-HELD bids are never winners or reserve.
        for (const b of [...winners, ...reserve]) {
          expect(b.status).toBe('HELD');
          expect(b.paypalAuthorizationId).not.toBeNull();
        }
        for (const b of ineligible) expect(isEligibleBid(b)).toBe(false);

        // Rank order and the rank map.
        const ranked = [...winners, ...reserve];
        for (let i = 1; i < ranked.length; i++)
          expect(compareBids(ranked[i - 1]!, ranked[i]!)).toBeLessThan(0);
        expect(r.rank).toEqual(Object.fromEntries(ranked.map((b, i) => [b.id, i + 1])));
      }),
      runs,
    );
  });

  it('does not depend on input order', () => {
    fc.assert(
      fc.property(
        arbBook.chain((book) =>
          fc.shuffledSubarray(book.bids, { minLength: book.bids.length }).map((s) => ({ book, s })),
        ),
        ({ book, s }) => {
          expect(clear(s, book.q, book.floorCents)).toEqual(
            clear(book.bids, book.q, book.floorCents),
          );
        },
      ),
      runs,
    );
  });

  it('ties are broken by seq, then ordinal id', () => {
    fc.assert(
      fc.property(arbBook, ({ bids, q, floorCents }) => {
        const { winners, reserve } = clear(bids, q, floorCents);
        const ranked = [...winners, ...reserve];
        for (let i = 1; i < ranked.length; i++) {
          const [a, b] = [ranked[i - 1]!, ranked[i]!];
          if (a.amountCents === b.amountCents) {
            expect(a.seq < b.seq || (a.seq === b.seq && a.id < b.id)).toBe(true);
          }
        }
      }),
      runs,
    );
  });
});
