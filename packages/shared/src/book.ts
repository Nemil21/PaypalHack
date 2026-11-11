import { z } from 'zod';
import { clear, compareBids } from './auction.js';
import type { ClearBid, ClearInput } from './clear.js';
import { feeCents, netCents } from './fees.js';
import { LISTING_PHASES } from './listing.js';
import { LISTING_STATUSES } from './status.js';

/**
 * Brand-only read model behind the listing console (HF-022; api.md `GET /listings/:id/book` and
 * `/simulate`). Both endpoints are computed from exactly the `loadClearInput` rows Clear will use
 * (D8), and every number here comes from the shared `clear()` and `feeCents()`, so the console,
 * the slider (HF-024), the Clear modal (HF-028) and the server Clear agree to the cent.
 */

const isoOrNull = z.string().nullable();
/** Epoch microseconds as a decimal string: µs do not fit a JS number safely as a Date. */
const epochUs = z.string().regex(/^\d+$/);

export const bookListingSchema = z.object({
  id: z.string(),
  slug: z.string().nullable(),
  status: z.enum(LISTING_STATUSES),
  /** `listingPhase(listing, now).phase` at `asOf`. The console recomputes it as time passes. */
  phase: z.enum(LISTING_PHASES),
  product: z.object({ title: z.string().nullable(), imageUrl: z.string().nullable() }),
  quantity: z.number().int(),
  floorCents: z.number().int(),
  liquidationQuoteCents: z.number().int().nullable(),
  /** The brand's success fee (`brands.fee_bps`), for the W07 modal's fee and net. */
  feeBps: z.number().int(),
  windowOpensAt: isoOrNull,
  windowClosesAt: isoOrNull,
  roundsStartedAt: isoOrNull,
  roundsEndAt: isoOrNull,
  roundEndsAt: isoOrNull,
  currentRound: z.number().int().nullable(),
  targetQuantity: z.number().int().nullable(),
  clearDeadlineAt: isoOrNull,
  /** Oldest `bids.authorized_at` in the Clear input (D6), never `placed_at`. */
  oldestHoldAuthorizedAt: isoOrNull,
  /** min(`clearDeadlineAt`, `oldestHoldAuthorizedAt` + 66 h), from the shared `clearBy()`. */
  clearByAt: isoOrNull,
  priceWatch: z.object({
    /** A Channel3 price subscription exists for this product (D17). */
    on: z.boolean(),
    bestPublicPriceCents: z.number().int().nullable(),
    merchant: z.string().nullable(),
    offerUrl: z.string().nullable(),
    priceUpdatedAt: isoOrNull,
  }),
});
export type BookListing = z.infer<typeof bookListingSchema>;

export const bookStatsSchema = z.object({
  /** Bids in the Clear input (HELD with a real hold). */
  liveBids: z.number().int(),
  heldCents: z.number().int(),
  /** The part of `heldCents` held by SIM bidders, for "incl. $X simulated". */
  simulatedHeldCents: z.number().int(),
  bestPublicPriceCents: z.number().int().nullable(),
  /** Bids voided because the public price dropped below them (`void_reason = 'PRICE_DROP'`). */
  releasedByPriceWatch: z.number().int(),
});
export type BookStats = z.infer<typeof bookStatsSchema>;

export const demandCurvePointSchema = z.object({
  priceCents: z.number().int(),
  bidsAtOrAbove: z.number().int(),
  heldAtOrAboveCents: z.number().int(),
});
export type DemandCurvePoint = z.infer<typeof demandCurvePointSchema>;

export const bookBidSchema = z.object({
  id: z.string(),
  amountCents: z.number().int(),
  /** 1-based rank from the server's `clear()` ordering; null below the floor. */
  rank: z.number().int().nullable(),
  /** `placed_at` in epoch µs (DB time). Same-millisecond bids still order correctly. */
  placedAtUs: epochUs,
  source: z.string().nullable(),
  isSimulated: z.boolean(),
  /** Opaque per-listing label ("Shopper #1042"); never derived from an email. */
  shopperLabel: z.string(),
  status: z.literal('HELD'),
  belowFloor: z.boolean(),
});
export type BookBid = z.infer<typeof bookBidSchema>;

/** Display-only rows that are not (yet / any more) in the Clear input. */
export const bookPendingBidSchema = z.object({
  id: z.string(),
  amountCents: z.number().int(),
  placedAtUs: epochUs,
  source: z.string().nullable(),
  isSimulated: z.boolean(),
  shopperLabel: z.string(),
  status: z.enum(['PENDING_APPROVAL', 'VOIDING']),
});
export type BookPendingBid = z.infer<typeof bookPendingBidSchema>;

export const bookResponseSchema = z.object({
  listing: bookListingSchema,
  stats: bookStatsSchema,
  /** Ascending price; one point per distinct bid amount. */
  curve: z.array(demandCurvePointSchema),
  /** Exactly the Clear input, in server rank order (ranked first, then below-floor). */
  bids: z.array(bookBidSchema),
  pending: z.array(bookPendingBidSchema),
  /** `ClearInput.bookVersion`: changes whenever the Clear input changes. */
  bookVersion: z.string(),
  /** Server time the snapshot was read at (ISO). */
  asOf: z.string(),
});
export type BookResponse = z.infer<typeof bookResponseSchema>;

/** `GET /listings/:id/simulate?quantity=` query. Without `quantity`, the listing quantity is used. */
export const simulateQuerySchema = z
  .object({ quantity: z.coerce.number().int().min(1).optional() })
  .strict();

export const simulateResponseSchema = z.object({
  quantity: z.number().int(),
  cutoffCents: z.number().int().nullable(),
  /** Number of winners (≤ quantity). */
  winners: z.number().int(),
  losers: z.number().int(),
  winnerBidIds: z.array(z.string()),
  grossCents: z.number().int(),
  /** Lowest and average winning bid, for "lowest $219, average $226" in W07. */
  averageWinningCents: z.number().int().nullable(),
  feeBps: z.number().int(),
  feeCents: z.number().int(),
  netCents: z.number().int(),
  liquidationCents: z.number().int().nullable(),
  recoveryMultiple: z.number().nullable(),
  /** Winners whose hold is ≥ 66 h old: Clear would refuse with `HOLDS_TOO_OLD` (D6). */
  holdsTooOldBidIds: z.array(z.string()),
  bookVersion: z.string(),
});
export type SimulateResponse = z.infer<typeof simulateResponseSchema>;

/**
 * The demand curve (features/08 §Layout 3): for each distinct bid amount, how many bids and how
 * many held dollars sit at or above it. Pass the per-shopper deduped eligible bids (`clear()`'s
 * ranked + below-floor); ascending price, so it plots directly as a step line.
 */
export function buildDemandCurve(bids: readonly { amountCents: number }[]): DemandCurvePoint[] {
  const byPrice = new Map<number, number>();
  for (const b of bids) byPrice.set(b.amountCents, (byPrice.get(b.amountCents) ?? 0) + 1);
  const prices = [...byPrice.keys()].sort((a, b) => b - a);
  const points: DemandCurvePoint[] = [];
  let count = 0;
  let held = 0;
  for (const p of prices) {
    const n = byPrice.get(p)!;
    count += n;
    held += n * p;
    points.push({ priceCents: p, bidsAtOrAbove: count, heldAtOrAboveCents: held });
  }
  return points.reverse();
}

/** What liquidating the cleared units would have paid: `winners × liquidation_quote_cents`. */
export function liquidationCents(winners: number, quoteCents: number | null): number | null {
  return quoteCents === null ? null : winners * quoteCents;
}

/** Recovery vs liquidation (×5.8): `gross / liquidation`, 2 decimals; null with no comparison. */
export function recoveryMultiple(grossCents: number, liquidation: number | null): number | null {
  if (liquidation === null || liquidation <= 0) return null;
  return Math.round((grossCents * 100) / liquidation) / 100;
}

export interface SimulateOptions {
  feeBps: number;
  liquidationQuoteCents: number | null;
  /** Hold-age guard (D6), same rule as Clear: aged winners refuse, aged losers are dropped. */
  isAged?: (bid: ClearBid) => boolean;
}

/**
 * What Clear would do with this book at quantity `q`, mirroring `clearListing` (HF-027): run
 * `clear()` on the whole Clear input; aged winners are reported; aged losers are dropped (which
 * leaves the winners and gross unchanged).
 */
export function simulateClear(
  input: ClearInput,
  q: number,
  opts: SimulateOptions,
): SimulateResponse {
  const isAged = opts.isAged ?? (() => false);
  const full = clear(input.bids, q, input.floorCents);
  const holdsTooOldBidIds = full.winners.filter(isAged).map((b) => b.id);
  const result =
    holdsTooOldBidIds.length === 0 && input.bids.some(isAged)
      ? clear(
          input.bids.filter((b) => !isAged(b)),
          q,
          input.floorCents,
        )
      : full;
  const winners = result.winners.length;
  const liquidation = liquidationCents(winners, opts.liquidationQuoteCents);
  return {
    quantity: q,
    cutoffCents: result.cutoffCents,
    winners,
    losers: input.bids.length - winners,
    winnerBidIds: result.winners.map((b) => b.id),
    grossCents: result.grossCents,
    averageWinningCents: winners ? Math.round(result.grossCents / winners) : null,
    feeBps: opts.feeBps,
    feeCents: feeCents(result.grossCents, opts.feeBps),
    netCents: netCents(result.grossCents, opts.feeBps),
    liquidationCents: liquidation,
    recoveryMultiple: recoveryMultiple(result.grossCents, liquidation),
    holdsTooOldBidIds,
    bookVersion: input.bookVersion,
  };
}

/**
 * Server order for `book.bids`: ranked bids by rank, then below-floor bids, then any superseded
 * ones, each in `clear()` order.
 */
export function bookOrder(bids: readonly ClearBid[], floorCents: number) {
  if (bids.length === 0)
    return { ordered: [], rank: {} as Record<string, number>, belowFloor: new Set<string>() };
  const r = clear(bids, 1, floorCents);
  const ranked = [...r.winners, ...r.reserve];
  const rest = [...r.belowFloor, ...r.superseded, ...r.ineligible].sort(compareBids);
  return {
    ordered: [...ranked, ...rest],
    rank: r.rank,
    belowFloor: new Set(r.belowFloor.map((b) => b.id)),
  };
}

/**
 * Turn `book.bids` back into `clear()` input in the browser (HF-024's slider): each row is one
 * shopper's live hold, and `seq` is the row's position in server order, so `clear()` here ranks
 * exactly like the server even for bids placed in the same millisecond.
 */
export function clearBidsFromBook(bids: readonly BookBid[]): ClearBid[] {
  const ordered = bids
    .map((b, i) => ({ b, i }))
    .sort(
      (x, y) =>
        (x.b.rank ?? Number.MAX_SAFE_INTEGER) - (y.b.rank ?? Number.MAX_SAFE_INTEGER) || x.i - y.i,
    )
    .map(({ b }) => b);
  return ordered.map((b, i) => ({
    id: b.id,
    shopperId: `book:${b.id}`,
    amountCents: b.amountCents,
    seq: i,
    placedAt: '',
    status: 'HELD',
    paypalAuthorizationId: 'held',
    authorizedAt: null,
    isSimulated: b.isSimulated,
  }));
}
