import { assertCents } from './money.js';

/**
 * Platform success fee. Default 900 bps (9%), matching `brands.fee_bps` (data-model.md) and
 * features/12. Pass the brand's own `fee_bps` when it differs.
 */
export const DEFAULT_FEE_BPS = 900;

/**
 * Fee in integer cents: `floor((grossCents * bps + 5000) / 10000)`, i.e. round half up to the
 * nearest cent (HF-022). Used by `/simulate`, the W07 Clear modal and `payoutBrand` (HF-032), so
 * the number the brand sees before Clear is the number it is charged.
 *
 * Examples at 900 bps: 5_424_000 → 488_160; 5 → 0 (0.45¢ rounds down); 6 → 1 (0.54¢ rounds up).
 */
export function feeCents(grossCents: number, feeBps: number = DEFAULT_FEE_BPS): number {
  assertCents(grossCents, 'grossCents');
  if (grossCents < 0) throw new RangeError('grossCents must be >= 0');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError('feeBps must be an integer in 0..10000');
  }
  const fee = Math.floor((grossCents * feeBps + 5000) / 10_000);
  assertCents(fee, 'feeCents');
  return fee;
}

/** Brand net after the platform fee. */
export function netCents(grossCents: number, feeBps: number = DEFAULT_FEE_BPS): number {
  return grossCents - feeCents(grossCents, feeBps);
}
