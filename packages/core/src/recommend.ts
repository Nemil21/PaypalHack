import {
  clear,
  netCents,
  simulateClear,
  type ClearBid,
  type ClearInput,
  type Recommendation,
  type RecommendationOption,
} from '@holdfast/shared';

/**
 * The brand agent's recommendation, computed by code with no model call (HF-051a, features/09
 * §Logic 1). It scans every quantity `1 … min(listing quantity, bids at or above the floor)` of
 * the shared `clear()` ranking over the `loadClearInput` book (D8) and picks the quantity with the
 * highest net recovery whose cutoff is at least
 *
 *   max(floor, ⌈(1 − brands.max_discount_bps / 10000) × public low⌉).
 *
 * Under pay-your-bid every qualifying bid adds money, so net rises with Q; the max-discount guard
 * is what stops it (Aurel: $279 × 0.78 → $217.62, so 240 units at $219, not 300 at $199). Ties
 * go to the smaller quantity. Without a public price or a `max_discount_bps`, only the floor
 * applies. Every number returned comes from `simulateClear()`, so it equals `/simulate`, the
 * slider and the W07 modal to the cent. Hold age is not a constraint here: Clear's own
 * HOLDS_TOO_OLD path (W07) handles it.
 */

export interface RecommendOptions {
  /** `listings.quantity`: the most units the brand can clear. */
  listingQuantity: number;
  feeBps: number;
  liquidationQuoteCents: number | null;
  /** Best public price for the product (`products.best_public_price_cents`). */
  publicLowCents: number | null;
  /** `brands.max_discount_bps`; null = no discount guard. */
  maxDiscountBps: number | null;
  /** Hold-age rule, passed through to `simulateClear()` so numbers match `/simulate`. */
  isAged?: (bid: ClearBid) => boolean;
}

/** max(floor, ⌈(1 − bps/10000) × public low⌉) in integer cents. */
export function minCutoffCents(
  floorCents: number,
  publicLowCents: number | null,
  maxDiscountBps: number | null,
): number {
  if (publicLowCents === null || maxDiscountBps === null) return floorCents;
  const guard = Math.ceil(((10_000 - maxDiscountBps) * publicLowCents) / 10_000);
  return Math.max(floorCents, guard);
}

export function recommend(input: ClearInput, opts: RecommendOptions): Recommendation {
  const minCutoff = minCutoffCents(input.floorCents, opts.publicLowCents, opts.maxDiscountBps);
  // q = 1 only to rank: winners + reserve is every per-shopper-deduped bid at or above the floor.
  const ranked = input.bids.length ? clear(input.bids, 1, input.floorCents) : null;
  const qualifying = ranked ? ranked.winners.length + ranked.reserve.length : 0;
  const maxQ = Math.min(opts.listingQuantity, qualifying);
  if (maxQ < 1) return { kind: 'NO_DEMAND', minCutoffCents: minCutoff };

  // clear() at q wins exactly the first q ranked bids, so the scan reads cutoff and gross from
  // one ranking; the options returned are then re-run through simulateClear() itself.
  const order = [...ranked!.winners, ...ranked!.reserve];
  let gross = 0;
  let bestQ = 0;
  let bestNet = -1;
  const cutoffAt: number[] = [0];
  for (let q = 1; q <= maxQ; q++) {
    const cutoff = order[q - 1]!.amountCents;
    gross += cutoff;
    cutoffAt.push(cutoff);
    const net = netCents(gross, opts.feeBps);
    if (cutoff >= minCutoff && net > bestNet) {
      bestQ = q;
      bestNet = net;
    }
  }

  const option = (q: number): RecommendationOption => {
    const s = simulateClear(input, q, {
      feeBps: opts.feeBps,
      liquidationQuoteCents: opts.liquidationQuoteCents,
      isAged: opts.isAged,
    });
    return {
      quantity: q,
      cutoffCents: s.cutoffCents!,
      grossCents: s.grossCents,
      netCents: s.netCents,
      liquidationCents: s.liquidationCents,
      withinGuard: s.cutoffCents! >= minCutoff,
    };
  };
  const all = option(maxQ);

  if (bestQ === 0) {
    return {
      kind: 'BELOW_GUARD',
      minCutoffCents: minCutoff,
      bestBidCents: cutoffAt[1]!,
      alternatives: [all],
    };
  }
  const best = option(bestQ);

  // Alternatives: clearing every qualifying bid ("what if I clear all 300?"), then the largest
  // quantity at the next higher cutoff (fewer units, higher prices).
  const alternatives: RecommendationOption[] = [];
  if (maxQ !== bestQ) alternatives.push(all);
  let cutoff = cutoffAt[bestQ]!;
  for (let q = bestQ - 1; q >= 1 && alternatives.length < 2; q--) {
    if (cutoffAt[q]! > cutoff) {
      alternatives.push(option(q));
      cutoff = cutoffAt[q]!;
    }
  }

  return { kind: 'RECOMMEND', ...best, minCutoffCents: minCutoff, alternatives };
}
