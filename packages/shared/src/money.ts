/**
 * Money is integer cents everywhere in Holdfast. PayPal wants decimal strings ("229.00"),
 * so these helpers are the only place cents cross into that format. No float math.
 */

/** Smallest and largest bid amounts accepted from users (security checklist, feature 16). */
export const MIN_AMOUNT_CENTS = 100;
export const MAX_AMOUNT_CENTS = 1_000_000;

export const CURRENCY = 'USD' as const;
export type Currency = typeof CURRENCY;

export function assertCents(cents: number, label = 'cents'): void {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`${label} must be a safe integer, got ${String(cents)}`);
  }
}

/** 22900 → "229.00"; -5 → "-0.05". */
export function centsToDecimal(cents: number): string {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${frac.toString().padStart(2, '0')}`;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** "229.00" | "229.5" | "229" → integer cents. Rejects more than two decimals, exponents, blanks. */
export function decimalToCents(value: string): number {
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) throw new RangeError(`not a money amount with at most 2 decimals: "${value}"`);
  const [, neg, whole = '0', frac = ''] = m;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  assertCents(cents);
  return neg ? -cents : cents;
}

/** PayPal amount object, e.g. `{ currency_code: 'USD', value: '229.00' }` (was `usd()` in the spikes). */
export function paypalAmount(cents: number): { currency_code: Currency; value: string } {
  return { currency_code: CURRENCY, value: centsToDecimal(cents) };
}

/** Display format: 22900 → "$229", 22950 → "$229.50". */
export function formatUsd(cents: number): string {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = abs % 100;
  return frac === 0 ? `${sign}$${whole}` : `${sign}$${whole}.${frac.toString().padStart(2, '0')}`;
}
