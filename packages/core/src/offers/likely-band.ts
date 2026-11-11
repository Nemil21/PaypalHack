/**
 * Floor-blind demand hints for shoppers and buyer agents (M22; features/03 §Logic 2). One
 * implementation shared by the offer page (HF-019), the buyer agent's `suggest_bid` (HF-039) and
 * MCP `get_book` bands (HF-044a).
 *
 * Neither function takes the floor, so no output can depend on it: the inputs are the eligible
 * (D8: HELD with an authorization) bid amounts, the listing quantity and the public price.
 */

/** Band width: amounts are bucketed to whole $10 steps. */
export const LIKELY_BAND_BUCKET_CENTS = 1_000;
/** A band must hold at least this many bids; thinner buckets merge into their neighbours. */
export const LIKELY_BAND_MIN_BIDS = 3;
/** The default bid sits about this far below the cheapest public price (features/03 §Logic 2). */
export const SUGGESTED_DISCOUNT_BPS = 1_800;

export interface PriceBand {
  /** Inclusive lower edge, a multiple of $10. */
  fromCents: number;
  /** Exclusive upper edge, a multiple of $10. */
  toCents: number;
}

/**
 * Demand bands, highest first: $10 buckets, walked from the top, closed once they hold
 * `LIKELY_BAND_MIN_BIDS` bids; a short tail merges into the band above it.
 */
export function demandBands(
  eligibleAmountsCents: readonly number[],
): Array<PriceBand & { bids: number }> {
  const counts = new Map<number, number>();
  for (const a of eligibleAmountsCents) {
    const b = Math.floor(a / LIKELY_BAND_BUCKET_CENTS) * LIKELY_BAND_BUCKET_CENTS;
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const buckets = [...counts.entries()].sort(([a], [b]) => b - a);

  const bands: Array<PriceBand & { bids: number }> = [];
  let open: (PriceBand & { bids: number }) | null = null;
  for (const [from, n] of buckets) {
    open ??= { fromCents: from, toCents: from + LIKELY_BAND_BUCKET_CENTS, bids: 0 };
    open.fromCents = from;
    open.bids += n;
    if (open.bids >= LIKELY_BAND_MIN_BIDS) {
      bands.push(open);
      open = null;
    }
  }
  if (open) {
    const last = bands[bands.length - 1];
    if (last) {
      last.fromCents = open.fromCents;
      last.bids += open.bids;
    } else {
      bands.push(open);
    }
  }
  return bands;
}

/**
 * "Bids near $219 are most likely to clear": the band holding the `quantity`-th highest eligible
 * bid (the pay-your-bid cutoff if the brand cleared everything now). Null unless eligible bids
 * ≥ quantity; the page then shows only the suggestion.
 */
export function likelyBand(
  eligibleAmountsCents: readonly number[],
  quantity: number,
): PriceBand | null {
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  if (eligibleAmountsCents.length < quantity) return null;
  const cutoff = [...eligibleAmountsCents].sort((a, b) => b - a)[quantity - 1]!;
  const band = demandBands(eligibleAmountsCents).find(
    (b) => cutoff >= b.fromCents && cutoff < b.toCents,
  );
  return band ? { fromCents: band.fromCents, toCents: band.toCents } : null;
}

/** The default bid: about 18% below the cheapest public price, rounded to whole dollars. */
export function suggestedBidCents(bestPublicPriceCents: number | null): number | null {
  if (bestPublicPriceCents == null || bestPublicPriceCents <= 0) return null;
  const raw = (bestPublicPriceCents * (10_000 - SUGGESTED_DISCOUNT_BPS)) / 10_000;
  return Math.max(100, Math.round(raw / 100) * 100);
}
