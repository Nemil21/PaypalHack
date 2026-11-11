import { describe, expect, it } from 'vitest';
import { buildDemandCurve, type ClearBid } from '@holdfast/shared';
import { bookFromInput, clearInput, heldBid } from './book.fixtures';
import { buildCurveModel, curveDomain, curveHover, cutoffMarker } from './curve';
import { prepareSlider, previewAt } from './slider';

describe('demand curve builder', () => {
  it('hover reads "120 bids ≥ $229 · $27.5k held"', () => {
    expect(
      curveHover({ priceCents: 22_900, bidsAtOrAbove: 120, heldAtOrAboveCents: 2_750_000 }),
    ).toBe('120 bids ≥ $229 · $27.5k held');
    expect(curveHover({ priceCents: 30_000, bidsAtOrAbove: 1, heldAtOrAboveCents: 30_000 })).toBe(
      '1 bid ≥ $300 · $300 held',
    );
  });

  it('plots the server curve as-is (ascending price, bids and held at or above)', () => {
    const book = bookFromInput(
      clearInput(
        [heldBid(0, 25_900), heldBid(1, 23_900), heldBid(2, 23_900), heldBid(3, 15_000)],
        4,
      ),
    );
    const m = buildCurveModel(book);
    expect(m.data.map(({ hover: _h, ...p }) => p)).toEqual(book.curve);
    expect(m.data).toEqual([
      {
        priceCents: 15_000,
        bidsAtOrAbove: 4,
        heldAtOrAboveCents: 88_700,
        hover: '4 bids ≥ $150 · $887 held',
      },
      {
        priceCents: 23_900,
        bidsAtOrAbove: 3,
        heldAtOrAboveCents: 73_700,
        hover: '3 bids ≥ $239 · $737 held',
      },
      {
        priceCents: 25_900,
        bidsAtOrAbove: 1,
        heldAtOrAboveCents: 25_900,
        hover: '1 bid ≥ $259 · $259 held',
      },
    ]);
  });

  it('marks the floor and the public low; the cutoff marker follows the slider', () => {
    const book = bookFromInput(clearInput([heldBid(0, 25_900), heldBid(1, 23_900)], 4));
    const m = buildCurveModel(book);
    expect(m.markers).toEqual([
      { kind: 'floor', priceCents: 19_900, label: 'Floor $199' },
      { kind: 'publicLow', priceCents: 27_900, label: 'Public low $279' },
    ]);
    book.listing.priceWatch.bestPublicPriceCents = null;
    expect(buildCurveModel(book).markers.map((x) => x.kind)).toEqual(['floor']);
    expect(cutoffMarker(23_900)).toEqual({
      kind: 'cutoff',
      priceCents: 23_900,
      label: 'Cutoff $239',
    });
    expect(cutoffMarker(null)).toBeNull();
  });

  it('domain keeps every point and marker inside the frame', () => {
    expect(
      curveDomain([{ priceCents: 20_000 }, { priceCents: 30_000 }], [{ priceCents: 19_900 }]),
    ).toEqual({
      min: 19_900 - 404,
      max: 30_000 + 404,
    });
    expect(curveDomain([{ priceCents: 500 }], [])).toEqual({ min: 400, max: 600 });
    expect(curveDomain([], [])).toBeNull();
  });

  it('the slider cutoff sits on the curve: bids at or above it ≥ winners', () => {
    const bids: ClearBid[] = Array.from({ length: 80 }, (_, i) =>
      heldBid(i, 18_000 + ((i * 37) % 40) * 250),
    );
    const book = bookFromInput(clearInput(bids, 60));
    const sb = prepareSlider(book);
    for (let q = 1; q <= sb.max; q++) {
      const n = previewAt(sb, q);
      const point = book.curve.find((p) => p.priceCents === n.cutoffCents)!;
      expect(point.bidsAtOrAbove).toBeGreaterThanOrEqual(n.winners);
      // Held at the cutoff ≥ gross (ties at the cutoff may add held dollars that do not win).
      expect(point.heldAtOrAboveCents).toBeGreaterThanOrEqual(n.grossCents);
    }
    // The curve the server sends is the shared builder over the deduped Clear input.
    expect(book.curve).toEqual(buildDemandCurve(bids));
  });
});
