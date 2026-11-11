/**
 * Channel3 prices are decimals (`279.99`); Holdfast stores integer cents. Convert exactly once,
 * here, with `Math.round(price * 100)` (HF-009, M21): the float error of `price * 100`
 * (279.99 * 100 = 27998.999999999996) is far below half a cent, so rounding recovers the cents.
 */
export function priceToCents(price: number): number {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    throw new RangeError('Channel3 price must be a finite, non-negative number');
  }
  const cents = Math.round(price * 100);
  if (!Number.isSafeInteger(cents)) throw new RangeError('Channel3 price is out of range');
  return cents;
}

/** `priceToCents`, or null for a missing or unusable price (callers then ignore the offer). */
export function priceToCentsOrNull(price: unknown): number | null {
  try {
    return typeof price === 'number' ? priceToCents(price) : null;
  } catch {
    return null;
  }
}
