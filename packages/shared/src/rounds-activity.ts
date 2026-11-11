import { z } from 'zod';
import { bidRaisedEvent, ROUND_END_REASONS } from './events.js';
import { LISTING_STATUSES } from './status.js';

/**
 * `GET /listings/:id/rounds/activity` (HF-037b; features/19 §Screens, screens.md W06): what the
 * console's raises feed shows. SSE carries ids only (HF-008), so the console re-reads this on every
 * `bid.raised` / `round.*` notice, as it re-reads the book. Brand only, any role.
 *
 * Raises use the shared `bid.raised` contract (HF-018) plus the round they landed in. Labels are
 * the book's per-listing "Shopper #n" (the grid's labels), never PII. Gross numbers are
 * `clear(bids, targetQuantity, floor).grossCents`, the KPI row's expected gross during rounds.
 */

export const roundsActivityRaiseSchema = bidRaisedEvent
  .pick({
    bidId: true,
    replacesBidId: true,
    oldCents: true,
    newCents: true,
    shopperLabel: true,
    source: true,
    isSimulated: true,
    at: true,
  })
  .extend({ round: z.number().int() });
export type RoundsActivityRaise = z.infer<typeof roundsActivityRaiseSchema>;

export const roundsActivityRoundSchema = z.object({
  round: z.number().int(),
  startedAt: z.string().nullable(),
  /** Nudges written in this round's snapshot. */
  nudged: z.number().int(),
  /** Raises that landed while this round ran. */
  raised: z.number().int(),
  /** Expected gross when the round's snapshot was taken; null for rounds before HF-037b. */
  grossAtStartCents: z.number().int().nullable(),
  /**
   * Expected gross at the next round's start (or now, for the last round) minus at this round's
   * start. Includes the effect of a target change during the round. Null when unknown.
   */
  grossDeltaCents: z.number().int().nullable(),
});
export type RoundsActivityRound = z.infer<typeof roundsActivityRoundSchema>;

export const roundsActivityExtensionSchema = z.object({
  round: z.number().int(),
  at: z.string(),
  /** The raise that triggered it. */
  bidId: z.string(),
  roundEndsAt: z.string(),
  /** How far the round's end moved (10 min unscaled; less at the rounds cap). */
  extendedByMs: z.number().int(),
});
export type RoundsActivityExtension = z.infer<typeof roundsActivityExtensionSchema>;

export const roundsActivityEndedSchema = z.object({
  round: z.number().int(),
  reason: z.enum(ROUND_END_REASONS),
  at: z.string(),
});
export type RoundsActivityEnded = z.infer<typeof roundsActivityEndedSchema>;

export const roundsActivitySchema = z.object({
  listingId: z.string(),
  status: z.enum(LISTING_STATUSES),
  currentRound: z.number().int().nullable(),
  targetQuantity: z.number().int().nullable(),
  /**
   * Expected gross at the target quantity: live during rounds, the end audit's figure once they
   * ended (the book is frozen, so it stays after Clear / expiry). Null before rounds start.
   */
  expectedGrossCents: z.number().int().nullable(),
  /** Oldest first. */
  rounds: z.array(roundsActivityRoundSchema),
  /** Newest first; at most `ROUNDS_ACTIVITY_MAX_RAISES`. */
  raises: z.array(roundsActivityRaiseSchema),
  /** Newest first. */
  extensions: z.array(roundsActivityExtensionSchema),
  ended: roundsActivityEndedSchema.nullable(),
});
export type RoundsActivity = z.infer<typeof roundsActivitySchema>;

export const ROUNDS_ACTIVITY_MAX_RAISES = 200;
