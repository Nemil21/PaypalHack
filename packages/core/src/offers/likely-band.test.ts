import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { demandBands, likelyBand, suggestedBidCents } from './likely-band.js';

const usd = (d: number) => d * 100;

describe('likelyBand (M22)', () => {
  it('is null until eligible bids reach the quantity', () => {
    expect(likelyBand([], 1)).toBeNull();
    expect(likelyBand([usd(229), usd(219)], 3)).toBeNull();
    expect(likelyBand([usd(229)], 0)).toBeNull();
  });

  it('returns the $10 band holding the quantity-th highest bid', () => {
    const bids = [249, 245, 241, 229, 225, 221, 219, 215, 212].map(usd);
    // Q=5 → cutoff $225 → bucket [$220, $230) with 3 bids.
    expect(likelyBand(bids, 5)).toEqual({ fromCents: 22_000, toCents: 23_000 });
    expect(likelyBand(bids, 9)).toEqual({ fromCents: 21_000, toCents: 22_000 });
  });

  it('merges buckets with fewer than 3 bids', () => {
    // $249 alone and $239 alone merge with $229 → one band [$220, $250).
    const bids = [249, 239, 229].map(usd);
    expect(demandBands(bids)).toEqual([{ fromCents: 22_000, toCents: 25_000, bids: 3 }]);
    expect(likelyBand(bids, 1)).toEqual({ fromCents: 22_000, toCents: 25_000 });
    // A short tail joins the band above it.
    const tail = [229, 228, 227, 199].map(usd);
    expect(demandBands(tail)).toEqual([{ fromCents: 19_000, toCents: 23_000, bids: 4 }]);
  });

  it('every band but a lone one has ≥ 3 bids, and bands tile without overlap', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 100, max: 100_000 }), { maxLength: 60 }), (a) => {
        const bands = demandBands(a);
        expect(bands.reduce((s, b) => s + b.bids, 0)).toBe(a.length);
        if (a.length >= 3) for (const b of bands) expect(b.bids).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < bands.length; i++) {
          expect(bands[i]!.toCents).toBeLessThanOrEqual(bands[i - 1]!.fromCents);
        }
        for (const b of bands) {
          expect(b.fromCents % 1000).toBe(0);
          expect(b.toCents % 1000).toBe(0);
        }
      }),
    );
  });
});

describe('suggestedBidCents', () => {
  it('is about 18% below the public price, in whole dollars', () => {
    expect(suggestedBidCents(27_900)).toBe(22_900);
    expect(suggestedBidCents(null)).toBeNull();
    expect(suggestedBidCents(0)).toBeNull();
    expect(suggestedBidCents(50)).toBe(100);
  });
});
