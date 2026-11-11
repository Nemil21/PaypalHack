import {
  clear,
  clearBidsFromBook,
  liquidationCents,
  recoveryMultiple,
  type BookResponse,
  type ClearBid,
  type ClearResult,
} from '@holdfast/shared';

/**
 * The console quantity slider's maths (HF-024, features/08 §Layout 4). Two paths that always
 * agree:
 *
 * - **Drag:** the book is ranked once per change (`prepareSlider`, one shared `clear()` call) and
 *   every slider position reads the cutoff and gross from prefix sums in O(1), so dragging stays
 *   smooth at 5k bids.
 * - **Release:** the shared `clear()` runs at the chosen quantity (`exactAt`), the same code
 *   `/simulate` and Clear run on the server, and its result is what HF-028 confirms.
 *
 * No React here: the store (`slider-store.ts`) and the parity tests both use these functions.
 */

/** The slider-dependent numbers the KPIs, curve marker and Clear modal show. */
export interface SliderNumbers {
  quantity: number;
  /** Lowest winning bid; null when nobody wins. */
  cutoffCents: number | null;
  /** Sum of the winners' own bids (pay-your-bid). */
  grossCents: number;
  winners: number;
  /** `winners × liquidation_quote_cents`, null without a quote (shared `liquidationCents`). */
  liquidationCents: number | null;
  /** `gross / liquidation`, 2 decimals (shared `recoveryMultiple`, same as `/simulate`). */
  recoveryMultiple: number | null;
}

/** One book, ranked once. Rebuilt only when the book snapshot changes. */
export interface SliderBook {
  /** `clear()` input rebuilt from `book.bids` in server order (shared `clearBidsFromBook`). */
  bids: ClearBid[];
  /** Eligible bids at or above the floor, in rank order (per-shopper deduped). */
  ranked: ClearBid[];
  /** `prefix[q]` = gross of the top `q` ranked bids; `prefix[0] = 0`. */
  prefix: Float64Array;
  /** 1-based rank by bid id (the grid's "Would win?": rank ≤ quantity). */
  rank: Readonly<Record<string, number>>;
  floorCents: number;
  listingQuantity: number;
  liquidationQuoteCents: number | null;
  /** Slider upper bound: min(listing quantity, bids at or above the floor). 0 disables it. */
  max: number;
}

export function prepareSlider(book: BookResponse): SliderBook {
  const { floorCents, quantity, liquidationQuoteCents } = book.listing;
  const bids = clearBidsFromBook(book.bids);
  // q = 1 only to get the ranking: winners + reserve is every ranked bid in rank order.
  const r = bids.length ? clear(bids, 1, floorCents) : null;
  const ranked = r ? [...r.winners, ...r.reserve] : [];
  const prefix = new Float64Array(ranked.length + 1);
  for (let i = 0; i < ranked.length; i++) prefix[i + 1] = prefix[i]! + ranked[i]!.amountCents;
  return {
    bids,
    ranked,
    prefix,
    rank: r?.rank ?? {},
    floorCents,
    listingQuantity: quantity,
    liquidationQuoteCents,
    max: Math.max(0, Math.min(quantity, ranked.length)),
  };
}

/** Clamp a requested quantity into the slider range `1 … max`; null when the slider is empty. */
export function clampQuantity(sb: SliderBook, requested: number): number | null {
  if (sb.max < 1) return null;
  const q = Number.isFinite(requested) ? Math.round(requested) : sb.max;
  return Math.min(sb.max, Math.max(1, q));
}

function numbers(sb: SliderBook, q: number, winners: number, cutoff: number | null, gross: number) {
  const liquidation = liquidationCents(winners, sb.liquidationQuoteCents);
  return {
    quantity: q,
    cutoffCents: cutoff,
    grossCents: gross,
    winners,
    liquidationCents: liquidation,
    recoveryMultiple: recoveryMultiple(gross, liquidation),
  } satisfies SliderNumbers;
}

/** Drag path: O(1) from the prefix sums. `q` must already be in `1 … max`. */
export function previewAt(sb: SliderBook, q: number): SliderNumbers {
  const winners = Math.min(q, sb.ranked.length);
  const cutoff = winners ? sb.ranked[winners - 1]!.amountCents : null;
  return numbers(sb, q, winners, cutoff, sb.prefix[winners]!);
}

/** Release path: the shared `clear()` at `q`, exactly as `/simulate` and Clear run it. */
export function exactAt(
  sb: SliderBook,
  q: number,
): { result: ClearResult; numbers: SliderNumbers } {
  const result = clear(sb.bids, q, sb.floorCents);
  return {
    result,
    numbers: numbers(sb, q, result.winners.length, result.cutoffCents, result.grossCents),
  };
}

/** Whether this bid wins at `quantity` (the grid's "Would win?" column, HF-025). */
export function wouldWin(sb: SliderBook, bidId: string, quantity: number | null): boolean {
  const r = sb.rank[bidId];
  return quantity !== null && r !== undefined && r <= quantity;
}

/**
 * Why the slider stops short of what the brand asked for (features/08 §Edge cases), or null.
 * "Only 120 bids are at or above your $199 floor, so you can clear at most 120 units."
 */
export function clampNote(sb: SliderBook, requested: number, floorLabel: string): string | null {
  const qualifying = sb.ranked.length;
  if (qualifying >= Math.min(requested, sb.listingQuantity)) return null;
  if (qualifying === 0) return `No bids at or above your ${floorLabel} floor yet.`;
  const bids = qualifying === 1 ? '1 bid is' : `${qualifying.toLocaleString('en-US')} bids are`;
  const units = qualifying === 1 ? '1 unit' : `${qualifying.toLocaleString('en-US')} units`;
  return `Only ${bids} at or above your ${floorLabel} floor, so you can clear at most ${units}.`;
}
