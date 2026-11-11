import { describe, expect, it } from 'vitest';
import { centsToDecimal, decimalToCents, formatUsd, paypalAmount } from './money.js';

describe('cents <-> decimal', () => {
  it.each([
    [22900, '229.00'],
    [22950, '229.50'],
    [5, '0.05'],
    [0, '0.00'],
    [-5, '-0.05'],
    [100_000_000, '1000000.00'],
  ])('%i cents -> "%s"', (cents, s) => {
    expect(centsToDecimal(cents)).toBe(s);
    expect(decimalToCents(s)).toBe(cents);
  });

  it('parses short forms', () => {
    expect(decimalToCents('229')).toBe(22900);
    expect(decimalToCents('229.5')).toBe(22950);
    expect(decimalToCents(' 0.1 ')).toBe(10);
  });

  it.each(['', '1.234', '1e3', 'abc', '1.', '.5', '$5'])('rejects "%s"', (s) => {
    expect(() => decimalToCents(s)).toThrow(RangeError);
  });

  it('rejects non-integer cents', () => {
    expect(() => centsToDecimal(1.5)).toThrow(RangeError);
    expect(() => centsToDecimal(Number.NaN)).toThrow(RangeError);
  });

  it('avoids float drift (0.1 + 0.2 style)', () => {
    expect(decimalToCents('0.29')).toBe(29);
    expect(decimalToCents('1.15')).toBe(115);
  });

  it('builds the PayPal amount object', () => {
    expect(paypalAmount(22900)).toEqual({ currency_code: 'USD', value: '229.00' });
  });

  it('formats for display', () => {
    expect(formatUsd(22900)).toBe('$229');
    expect(formatUsd(5_424_000)).toBe('$54,240');
    expect(formatUsd(22950)).toBe('$229.50');
  });
});
