import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toClearBid } from '../fixtures/books.js';
import { clear } from './auction.js';
import {
  bookOrder,
  buildDemandCurve,
  clearBidsFromBook,
  liquidationCents,
  recoveryMultiple,
  simulateClear,
  type BookBid,
} from './book.js';
import type { ClearBid, ClearInput } from './clear.js';
import { feeCents } from './fees.js';

const input = (bids: ClearBid[], floorCents = 10_000): ClearInput => ({
  listingId: 'l1',
  floorCents,
  quantity: 300,
  bids,
  bookVersion: 'v1',
  oldestHoldAuthorizedAt: null,
});

/** What `/book` returns for these Clear-input bids (core does the same, plus display columns). */
function bookBids(bids: ClearBid[], floorCents: number): BookBid[] {
  const { ordered, rank, belowFloor } = bookOrder(bids, floorCents);
  return ordered.map((b) => ({
    id: b.id,
    amountCents: b.amountCents,
    rank: rank[b.id] ?? null,
    placedAtUs: '0',
    source: null,
    isSimulated: b.isSimulated,
    shopperLabel: 'Shopper #1',
    status: 'HELD',
    belowFloor: belowFloor.has(b.id),
  }));
}

describe('buildDemandCurve', () => {
  it('is empty for no bids', () => {
    expect(buildDemandCurve([])).toEqual([]);
  });

  it('counts bids and held dollars at or above each distinct price, ascending', () => {
    const bids = [22900, 21900, 22900, 25000, 19900].map((amountCents) => ({ amountCents }));
    expect(buildDemandCurve(bids)).toEqual([
      { priceCents: 19900, bidsAtOrAbove: 5, heldAtOrAboveCents: 112600 },
      { priceCents: 21900, bidsAtOrAbove: 4, heldAtOrAboveCents: 92700 },
      { priceCents: 22900, bidsAtOrAbove: 3, heldAtOrAboveCents: 70800 },
      { priceCents: 25000, bidsAtOrAbove: 1, heldAtOrAboveCents: 25000 },
    ]);
  });

  it('matches a brute-force count at every point', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 100, max: 50_000 }), { maxLength: 80 }), (amounts) => {
        const curve = buildDemandCurve(amounts.map((amountCents) => ({ amountCents })));
        expect(curve.map((p) => p.priceCents)).toEqual([...new Set(amounts)].sort((a, b) => a - b));
        for (const p of curve) {
          const at = amounts.filter((a) => a >= p.priceCents);
          expect(p.bidsAtOrAbove).toBe(at.length);
          expect(p.heldAtOrAboveCents).toBe(at.reduce((s, a) => s + a, 0));
        }
      }),
    );
  });
});

describe('liquidation and recovery', () => {
  it('liquidation = winners × quote; null without a quote', () => {
    expect(liquidationCents(240, 3800)).toBe(912_000);
    expect(liquidationCents(240, null)).toBeNull();
  });

  it('recovery = gross / liquidation to 2 decimals; null with nothing to compare', () => {
    expect(recoveryMultiple(5_424_000, 912_000)).toBe(5.95);
    expect(recoveryMultiple(5_424_000, 0)).toBeNull();
    expect(recoveryMultiple(5_424_000, null)).toBeNull();
  });
});

describe('simulateClear', () => {
  const bids = [
    toClearBid({ id: 'a', shopperId: 's1', amountCents: 25_000, seq: 3 }),
    toClearBid({ id: 'b', shopperId: 's2', amountCents: 22_900, seq: 1 }),
    toClearBid({ id: 'c', shopperId: 's3', amountCents: 22_900, seq: 2 }),
    toClearBid({ id: 'd', shopperId: 's4', amountCents: 9_000, seq: 4 }),
  ];

  it('returns the api.md numbers from clear() and feeCents()', () => {
    const s = simulateClear(input(bids), 2, { feeBps: 900, liquidationQuoteCents: 3800 });
    expect(s).toEqual({
      quantity: 2,
      cutoffCents: 22_900,
      winners: 2,
      losers: 2,
      winnerBidIds: ['a', 'b'],
      grossCents: 47_900,
      averageWinningCents: 23_950,
      feeBps: 900,
      feeCents: feeCents(47_900, 900),
      netCents: 47_900 - feeCents(47_900, 900),
      liquidationCents: 7_600,
      recoveryMultiple: 6.3,
      holdsTooOldBidIds: [],
      bookVersion: 'v1',
    });
  });

  it('reports aged winners (Clear would refuse) and ignores aged losers like Clear', () => {
    const agedWinner = simulateClear(input(bids), 2, {
      feeBps: 900,
      liquidationQuoteCents: null,
      isAged: (b) => b.id === 'b',
    });
    expect(agedWinner.holdsTooOldBidIds).toEqual(['b']);
    const agedLoser = simulateClear(input(bids), 2, {
      feeBps: 900,
      liquidationQuoteCents: null,
      isAged: (b) => b.id === 'c',
    });
    expect(agedLoser.holdsTooOldBidIds).toEqual([]);
    expect(agedLoser.winnerBidIds).toEqual(['a', 'b']);
    expect(agedLoser.grossCents).toBe(47_900);
  });

  it('handles an empty book', () => {
    const s = simulateClear(input([]), 5, { feeBps: 900, liquidationQuoteCents: 3800 });
    expect(s).toMatchObject({ winners: 0, cutoffCents: null, grossCents: 0, feeCents: 0 });
    expect(s.averageWinningCents).toBeNull();
    expect(s.recoveryMultiple).toBeNull();
  });
});

describe('client ranking from book.bids', () => {
  const bidArb = fc.record({
    amountCents: fc.integer({ min: 100, max: 400 }).map((n) => n * 100),
    seq: fc.integer({ min: 1, max: 1_000_000 }),
  });

  it('client sort by rank and clear(clearBidsFromBook()) pick the server winners, even for equal amounts', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(bidArb, { selector: (b) => b.seq, maxLength: 60 }),
        fc.integer({ min: 1, max: 70 }),
        fc.integer({ min: 100, max: 400 }).map((n) => n * 100),
        (raw, q, floor) => {
          const bids = raw.map((b, i) =>
            toClearBid({
              id: `bid-${i}`,
              shopperId: `s${i}`,
              amountCents: b.amountCents,
              seq: b.seq,
            }),
          );
          const server = simulateClear(input(bids, floor), q, {
            feeBps: 900,
            liquidationQuoteCents: null,
          });
          // The JSON arrives in any order; the client sorts by rank alone.
          const book = bookBids(bids, floor).reverse();
          const byRank = book
            .filter((b) => b.rank !== null)
            .sort((a, b) => a.rank! - b.rank!)
            .slice(0, q)
            .map((b) => b.id);
          expect(byRank).toEqual(server.winnerBidIds);
          const client = clear(clearBidsFromBook(book), q, floor);
          expect(client.winners.map((b) => b.id)).toEqual(server.winnerBidIds);
          expect(client.grossCents).toBe(server.grossCents);
          expect(client.cutoffCents).toBe(server.cutoffCents);
        },
      ),
    );
  });

  it('orders ranked bids first, then below-floor ones', () => {
    const bids = [
      toClearBid({ id: 'low', shopperId: 's1', amountCents: 5_000, seq: 1 }),
      toClearBid({ id: 'hi', shopperId: 's2', amountCents: 20_000, seq: 2 }),
    ];
    const book = bookBids(bids, 10_000);
    expect(book.map((b) => [b.id, b.rank, b.belowFloor])).toEqual([
      ['hi', 1, false],
      ['low', null, true],
    ]);
  });
});
