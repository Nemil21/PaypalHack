import { z } from 'zod';
import type { BidStatus } from './status.js';

/**
 * Contracts for the pay-your-bid auction (features/10, D8). `clear()` is in auction.ts, the default
 * predicate in eligibility.ts and `loadClearInput` in @holdfast/core (HF-005). `/book`, `/simulate`, the
 * console slider, the rounds runner and Clear all consume exactly this shape so numbers never drift.
 */

/** One bid as the auction sees it. All money in integer cents. */
export interface ClearBid {
  id: string;
  shopperId: string;
  amountCents: number;
  /** `bids.seq` (bigserial): rank tie-break after amount. Fits a JS number for any realistic book. */
  seq: number;
  /** ISO timestamp with µs precision when available (`placed_at`, DB time only). */
  placedAt: string;
  status: BidStatus;
  /** Null means no PayPal hold; such bids are never eligible (D8). */
  paypalAuthorizationId: string | null;
  /** PayPal authorization `create_time`; hold age is measured from this (D6). */
  authorizedAt: string | null;
  isSimulated: boolean;
}

/** D8: one shared predicate decides which bids count. Default: HELD with a PayPal authorization id. */
export type EligibilityPredicate = (bid: ClearBid) => boolean;

/** The eligible book for one listing, as returned by `loadClearInput(tx, listingId)` (HF-005). */
export interface ClearInput {
  listingId: string;
  floorCents: number;
  /** Listing quantity; callers pass the chosen Q to `clear()` separately. */
  quantity: number;
  bids: ClearBid[];
  /** Changes whenever the book changes; Clear sends it back to detect `BOOK_CHANGED`. */
  bookVersion: string;
  oldestHoldAuthorizedAt: string | null;
}

export interface ClearOptions {
  eligible?: EligibilityPredicate;
}

/** Output of `clear(bids, q, floorCents, opts)` (HF-005). Winners each pay their own bid. */
export interface ClearResult {
  winners: ClearBid[];
  /** Lowest winning bid, or null when nobody wins. Used for nudges and the console only. */
  cutoffCents: number | null;
  /** Sum of the winners' own bids. */
  grossCents: number;
  /** Eligible losers at or above the floor, in rank order (promotion candidates, D10). */
  reserve: ClearBid[];
  belowFloor: ClearBid[];
  /** Lower bids from a shopper who already has a higher one (D3). */
  superseded: ClearBid[];
  /** Bids the eligibility predicate rejected (e.g. no hold, D8). Never winners or reserve. */
  ineligible: ClearBid[];
  /** 1-based rank of every ranked eligible bid, by bid id. */
  rank: Record<string, number>;
}

/** Body of `POST /api/listings/:id/clear` (api.md). `quantity ≤ listing.quantity` is checked server-side (422). */
export const clearListingRequestSchema = z
  .object({
    quantity: z.number().int().min(1),
    /** The gross the brand confirmed in the modal; a mismatch is 409 `BOOK_CHANGED` (M12). */
    expectedGrossCents: z.number().int().min(0),
  })
  .strict();
export type ClearListingRequest = z.infer<typeof clearListingRequestSchema>;

/** 202 body of `POST /api/listings/:id/clear`. */
export interface ClearListingResponse {
  status: 'CLEARING';
  cutoffCents: number | null;
  grossCents: number;
  winners: number;
  losers: number;
  /** The `settlement_runs` outbox row (B6). */
  runId: string;
  /** Same id as `runId`, under the api.md name. */
  settlementRunId: string;
  /** Holds ≥ 66 h old released at Clear (`HOLD_AGED`, D6). */
  holdsReleased: number;
}

/** Recomputed numbers carried by 409 `STATE_CONFLICT {reason: 'BOOK_CHANGED'}` so the modal can offer "Confirm $X". */
export interface ClearNumbers {
  cutoffCents: number | null;
  grossCents: number;
  winners: number;
  bookVersion: string;
}

/** `reason` values of a 409 `STATE_CONFLICT` from Clear. */
export const CLEAR_CONFLICT_REASONS = [
  'NOT_CLEARABLE',
  'BOOK_CHANGED',
  'HOLDS_TOO_OLD',
  'AMOUNT_MISMATCH',
  'CONCURRENT_UPDATE',
] as const;
export type ClearConflictReason = (typeof CLEAR_CONFLICT_REASONS)[number];
