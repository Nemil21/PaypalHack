import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_BPS, feeCents, netCents } from './fees.js';

describe('feeCents', () => {
  it('defaults to 900 bps (9%)', () => {
    expect(DEFAULT_FEE_BPS).toBe(900);
    // api.md /simulate example: gross 5,424,000 -> fee 488,160, net 4,935,840.
    expect(feeCents(5_424_000)).toBe(488_160);
    expect(netCents(5_424_000)).toBe(4_935_840);
  });

  it('rounds half up to the cent', () => {
    expect(feeCents(5)).toBe(0); // 0.45
    expect(feeCents(6)).toBe(1); // 0.54
    expect(feeCents(50, 1000)).toBe(5); // exact
    expect(feeCents(5, 1000)).toBe(1); // 0.5 -> up
    expect(feeCents(15, 1000)).toBe(2); // 1.5 -> up
  });

  it('accepts a brand fee_bps', () => {
    expect(feeCents(10_000, 500)).toBe(500);
    expect(feeCents(10_000, 0)).toBe(0);
  });

  it('is an integer and fee + net = gross', () => {
    for (let g = 0; g < 5000; g += 7) {
      const f = feeCents(g);
      expect(Number.isInteger(f)).toBe(true);
      expect(f + netCents(g)).toBe(g);
    }
  });

  it('rejects bad input', () => {
    expect(() => feeCents(-1)).toThrow(RangeError);
    expect(() => feeCents(1.5)).toThrow(RangeError);
    expect(() => feeCents(100, 10_001)).toThrow(RangeError);
    expect(() => feeCents(100, 1.5)).toThrow(RangeError);
  });
});
