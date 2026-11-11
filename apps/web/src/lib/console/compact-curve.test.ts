import { describe, expect, it } from 'vitest';
import { bookFromInput, clearInput, heldBid } from './book.fixtures';
import { compactCurve } from './compact-curve';
import { buildCurveModel } from './curve';

describe('M10 compact demand curve (HF-061)', () => {
  // Floor $199; bids $150 (below floor), $239 ×2, $259. Domain pads 4% (≥ $1) each side.
  const book = bookFromInput(
    clearInput([heldBid(0, 25_900), heldBid(1, 23_900), heldBid(2, 23_900), heldBid(3, 15_000)], 4),
  );
  const model = buildCurveModel(book);
  const size = { width: 100, height: 50, pad: 0 };

  it('draws the W06 step line (step at the start) over the same domain', () => {
    const c = compactCurve(model, null, size);
    const { min, max } = model.domain!;
    expect(c.maxBids).toBe(4);
    const x = (cents: number) => Math.round(((cents - min) / (max - min)) * 1000) / 10;
    expect(c.line).toBe(
      `M${x(15_000)} 0 L${x(15_000)} 12.5 L${x(23_900)} 12.5 L${x(23_900)} 37.5 L${x(25_900)} 37.5`,
    );
    expect(c.area.endsWith(`L${x(25_900)} 50 L${x(15_000)} 50 Z`)).toBe(true);
  });

  it('places the floor and the cutoff marker on the same x scale', () => {
    const c = compactCurve(model, 23_900, size);
    expect(c.markers.map((m) => m.kind)).toEqual([...model.markers.map((m) => m.kind), 'cutoff']);
    const floor = c.markers.find((m) => m.kind === 'floor');
    const cutoff = c.markers.find((m) => m.kind === 'cutoff');
    expect(floor!.label).toBe('Floor $199');
    expect(cutoff!.label).toBe('Cutoff $239');
    expect(floor!.x).toBeLessThan(cutoff!.x);
    expect(compactCurve(model, null, size).markers.map((m) => m.kind)).not.toContain('cutoff');
  });

  it('empty book: no line, nothing to draw', () => {
    const empty = bookFromInput(clearInput([], 4));
    const c = compactCurve({ ...buildCurveModel(empty), domain: null }, null, size);
    expect(c).toEqual({ line: '', area: '', markers: [], maxBids: 0 });
  });
});
