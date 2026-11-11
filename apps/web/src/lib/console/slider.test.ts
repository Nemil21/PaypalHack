import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { simulateClear, type ClearBid } from '@holdfast/shared';
import { bookFromInput, clearInput, heldBid } from './book.fixtures';
import { clampNote, clampQuantity, exactAt, prepareSlider, previewAt, wouldWin } from './slider';

const pick = (n: { cutoffCents: number | null; grossCents: number; winners: number }) => ({
  cutoffCents: n.cutoffCents,
  grossCents: n.grossCents,
  winners: n.winners,
});

describe('slider maths', () => {
  // Ranked: 25,900 · 23,900 (seq 2) · 23,900 (seq 3) · 21,900 · 19,900; below floor: 15,000.
  const bids = [
    heldBid(0, 25_900),
    heldBid(1, 23_900),
    heldBid(2, 23_900),
    heldBid(3, 21_900),
    heldBid(4, 19_900),
    heldBid(5, 15_000),
  ];
  const book = bookFromInput(clearInput(bids, 10));
  const sb = prepareSlider(book);

  it('ranks once: max = min(listing quantity, bids at or above the floor)', () => {
    expect(sb.ranked.map((b) => b.amountCents)).toEqual([25_900, 23_900, 23_900, 21_900, 19_900]);
    expect(sb.max).toBe(5);
    expect(prepareSlider(bookFromInput(clearInput(bids, 3))).max).toBe(3);
    expect(Array.from(sb.prefix)).toEqual([0, 25_900, 49_800, 73_700, 95_600, 115_500]);
  });

  it('prefix sums give the cutoff, gross and recovery at each quantity', () => {
    expect(previewAt(sb, 3)).toEqual({
      quantity: 3,
      cutoffCents: 23_900,
      grossCents: 73_700,
      winners: 3,
      liquidationCents: 11_400,
      // 73,700 / (3 × 3,800) = 6.46
      recoveryMultiple: 6.46,
    });
  });

  it('matches the shared clear() at every quantity, including the tie at $239', () => {
    for (let q = 1; q <= sb.max; q++) {
      const exact = exactAt(sb, q);
      expect(previewAt(sb, q)).toEqual(exact.numbers);
      expect(exact.result.winners.map((b) => b.id)).toEqual(sb.ranked.slice(0, q).map((b) => b.id));
    }
  });

  it('clamps into 1 … max and is empty with no bid at or above the floor', () => {
    expect(clampQuantity(sb, 0)).toBe(1);
    expect(clampQuantity(sb, 99)).toBe(5);
    expect(clampQuantity(sb, 2.6)).toBe(3);
    const none = prepareSlider(bookFromInput(clearInput([heldBid(0, 9_900)], 10)));
    expect(none.max).toBe(0);
    expect(clampQuantity(none, 5)).toBeNull();
    const empty = prepareSlider(bookFromInput(clearInput([], 10)));
    expect(empty.max).toBe(0);
    expect(empty.ranked).toEqual([]);
  });

  it('explains the clamp (features/08 §Edge cases)', () => {
    expect(clampNote(sb, 10, '$199')).toBe(
      'Only 5 bids are at or above your $199 floor, so you can clear at most 5 units.',
    );
    expect(clampNote(sb, 4, '$199')).toBeNull();
    const one = prepareSlider(bookFromInput(clearInput([heldBid(0, 20_000)], 10)));
    expect(clampNote(one, 10, '$199')).toBe(
      'Only 1 bid is at or above your $199 floor, so you can clear at most 1 unit.',
    );
    const none = prepareSlider(bookFromInput(clearInput([], 10)));
    expect(clampNote(none, 10, '$199')).toBe('No bids at or above your $199 floor yet.');
    // Listing quantity is the real cap: asking for more than it is not a bid shortage.
    expect(clampNote(prepareSlider(bookFromInput(clearInput(bids, 5))), 10, '$199')).toBeNull();
  });

  it('would-win follows rank ≤ quantity; below-floor bids never win', () => {
    expect(wouldWin(sb, bids[2]!.id, 3)).toBe(true);
    expect(wouldWin(sb, bids[3]!.id, 3)).toBe(false);
    expect(wouldWin(sb, bids[5]!.id, 5)).toBe(false);
    expect(wouldWin(sb, bids[0]!.id, null)).toBe(false);
  });
});

/**
 * features/10 §Acceptance "Server and console produce identical results": for random Clear inputs
 * (ties, below-floor bids, aged holds), the client path (book → `clearBidsFromBook` → prefix sums
 * and `clear()`) equals `simulateClear` (what `/simulate` returns) at every quantity.
 */
describe('client slider vs /simulate (simulateClear) parity', () => {
  const arbBook = fc
    .record({
      amounts: fc.array(fc.integer({ min: 1, max: 60 }), { maxLength: 60 }),
      floorStep: fc.integer({ min: 0, max: 40 }),
      quantity: fc.integer({ min: 1, max: 70 }),
      quote: fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: null }),
      aged: fc.array(fc.boolean(), { maxLength: 60 }),
      seqs: fc.array(fc.integer({ min: 1, max: 1_000 }), { maxLength: 60 }),
    })
    .map(({ amounts, floorStep, quantity, quote, aged, seqs }) => {
      // Coarse amounts force ties; seqs shuffle the tie-break away from insertion order.
      const bids: ClearBid[] = amounts.map((a, i) =>
        heldBid(i, a * 500, {
          seq: (seqs[i] ?? i) * 100 + i,
          authorizedAt: aged[i] ? '2026-11-08T00:00:00.000Z' : '2026-11-11T10:00:00.000Z',
        }),
      );
      return { input: clearInput(bids, quantity, floorStep * 500), quote };
    });

  it('prefix sums, clear() and simulateClear agree at every quantity (1k random books)', () => {
    fc.assert(
      fc.property(arbBook, ({ input, quote }) => {
        const book = bookFromInput(input, { liquidationQuoteCents: quote });
        const sb = prepareSlider(book);
        const isAged = (b: ClearBid) => b.authorizedAt === '2026-11-08T00:00:00.000Z';
        const eligible = input.bids.filter((b) => b.amountCents >= input.floorCents).length;
        expect(sb.max).toBe(Math.min(input.quantity, eligible));
        for (let q = 1; q <= sb.max; q++) {
          const server = simulateClear(input, q, {
            feeBps: 500,
            liquidationQuoteCents: quote,
            isAged,
          });
          const exact = exactAt(sb, q);
          const preview = previewAt(sb, q);
          expect(preview).toEqual(exact.numbers);
          expect(pick(exact.numbers)).toEqual(pick(server));
          expect(exact.numbers.recoveryMultiple).toBe(server.recoveryMultiple);
          expect(exact.numbers.liquidationCents).toBe(server.liquidationCents);
          expect(exact.result.winners.map((b) => b.id)).toEqual(server.winnerBidIds);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('slider performance', () => {
  const book = (n: number) =>
    bookFromInput(
      clearInput(
        Array.from({ length: n }, (_, i) => heldBid(i, 20_000 + ((i * 53) % 9_000))),
        n,
      ),
    );

  it('a 300-bid book: re-rank plus exact clear() well under 50 ms', () => {
    const b = book(300);
    prepareSlider(b); // warm-up (JIT)
    const t0 = performance.now();
    const sb = prepareSlider(b);
    exactAt(sb, 240);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('a 5k-bid book: every drag step reads prefix sums (all 5,000 positions in < 50 ms)', () => {
    const sb = prepareSlider(book(5_000));
    const t0 = performance.now();
    let gross = 0;
    for (let q = 1; q <= sb.max; q++) gross += previewAt(sb, q).grossCents;
    expect(performance.now() - t0).toBeLessThan(50);
    expect(gross).toBeGreaterThan(0);
    // Release at the far end is still one clear(): exact equals the drag preview.
    expect(exactAt(sb, sb.max).numbers).toEqual(previewAt(sb, sb.max));
  });
});
