import { describe, expect, it, vi } from 'vitest';
import { simulateClear, type Recommendation, type RecommendationOption } from '@holdfast/shared';
import { bookFromInput, clearInput, heldBid } from './book.fixtures';
import { recommendationClearNote, recommendationView } from './recommendation';
import { createSliderStore } from './slider-store';

// A small Aurel-shaped book: 3 bids above the $217.62 guard, 2 between the floor and the guard.
const input = clearInput(
  [22_900, 22_700, 21_900, 21_500, 19_900].map((a, i) => heldBid(i, a)),
  5,
);
const option = (q: number, withinGuard: boolean): RecommendationOption => {
  const s = simulateClear(input, q, { feeBps: 500, liquidationQuoteCents: 3_800 });
  return {
    quantity: q,
    cutoffCents: s.cutoffCents!,
    grossCents: s.grossCents,
    netCents: s.netCents,
    liquidationCents: s.liquidationCents,
    withinGuard,
  };
};
const rec: Recommendation = {
  kind: 'RECOMMEND',
  ...option(3, true),
  minCutoffCents: 21_762,
  alternatives: [option(5, false), option(2, true)],
};

describe('recommendation card copy', () => {
  it('formats the JSON fields only', () => {
    const v = recommendationView(rec);
    expect(v).toEqual({
      kind: 'recommend',
      primary: {
        quantity: 3,
        label: 'Clear 3 (cutoff $219)',
        detail: '$675 gross · $641.25 net vs $114 liquidation',
        warning: null,
      },
      guardNote:
        'Cutoff stays at or above $217.62 (your floor and max discount). No public price change.',
      alternatives: [
        {
          quantity: 5,
          label: 'Clear 5 (cutoff $199)',
          detail: '$1,089 gross · $1,034.55 net vs $190 liquidation',
          warning: 'Below your $217.62 max-discount guard',
        },
        {
          quantity: 2,
          label: 'Clear 2 (cutoff $227)',
          detail: '$456 gross · $433.20 net vs $76 liquidation',
          warning: null,
        },
      ],
    });
  });

  it('uses compact money for the demo-sized numbers', () => {
    const big: Recommendation = {
      kind: 'RECOMMEND',
      quantity: 240,
      cutoffCents: 21_900,
      grossCents: 5_424_000,
      netCents: 4_935_840,
      liquidationCents: 912_000,
      withinGuard: true,
      minCutoffCents: 21_762,
      alternatives: [],
    };
    const v = recommendationView(big);
    if (v.kind !== 'recommend') throw new Error('expected recommend');
    expect(v.primary.label).toBe('Clear 240 (cutoff $219)');
    expect(v.primary.detail).toBe('$54.2k gross · $49.4k net vs $9,120 liquidation');
  });

  it('no bids → "Not enough demand yet"', () => {
    expect(recommendationView({ kind: 'NO_DEMAND', minCutoffCents: 19_900 })).toEqual({
      kind: 'empty',
      message: 'Not enough demand yet; share your link.',
    });
  });

  it('nothing within the guard: says so and still offers clearing every qualifying bid', () => {
    const v = recommendationView({
      kind: 'BELOW_GUARD',
      minCutoffCents: 21_762,
      bestBidCents: 21_500,
      alternatives: [option(2, false)],
    });
    expect(v).toMatchObject({
      kind: 'below_guard',
      message: 'No bid clears your max-discount guard yet: the best is $215, the guard is $217.62.',
      alternatives: [{ quantity: 2, warning: 'Below your $217.62 max-discount guard' }],
    });
  });

  it('W07 line names the recommendation and the quantity being cleared', () => {
    expect(recommendationClearNote(rec, 3)).toBe(
      'Brand agent recommends 3 (cutoff $219). You are clearing that.',
    );
    expect(recommendationClearNote(rec, 5)).toBe(
      'Brand agent recommends 3 (cutoff $219). You are clearing 5.',
    );
    expect(recommendationClearNote({ kind: 'NO_DEMAND', minCutoffCents: 1 }, 3)).toBeNull();
    expect(recommendationClearNote(undefined, 3)).toBeNull();
  });
});

describe('"Apply to slider"', () => {
  it('updates the slider at once, with the exact numbers the card shows', () => {
    const s = createSliderStore();
    s.setBook(bookFromInput(input));
    expect(s.get().committedQuantity).toBe(5);
    const fn = vi.fn();
    s.subscribe(fn);

    s.setSliderQuantity(rec.quantity); // what the card's button calls
    expect(fn).toHaveBeenCalledTimes(1);
    const st = s.get();
    expect(st).toMatchObject({ quantity: 3, committedQuantity: 3, dragging: false });
    expect(st.numbers).toMatchObject({
      cutoffCents: rec.kind === 'RECOMMEND' ? rec.cutoffCents : null,
      grossCents: rec.kind === 'RECOMMEND' ? rec.grossCents : null,
      liquidationCents: rec.kind === 'RECOMMEND' ? rec.liquidationCents : null,
    });
    expect(st.clearResult?.grossCents).toBe(rec.kind === 'RECOMMEND' ? rec.grossCents : null);
  });

  it('applied before the first book lands, it takes effect when the book arrives', () => {
    const s = createSliderStore();
    s.setSliderQuantity(2);
    s.setBook(bookFromInput(input));
    expect(s.get()).toMatchObject({ quantity: 2, committedQuantity: 2 });
  });
});
