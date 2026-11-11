import { z } from 'zod';
import type { ClearBid, ClearResult } from './clear.js';
import { ROUND_END_REASONS } from './events.js';
import { formatUsd } from './money.js';
import { LISTING_STATUSES } from './status.js';

/**
 * Live rounds contracts (features/19, HF-036a). The rounds runner (HF-036a basic, HF-036b timer),
 * the brand console (HF-037a/b), the shopper bid page (HF-038a), the auto-raise runner (HF-038b),
 * `GET /bids/mine` and MCP `my_bids` (HF-016, HF-044a) all build against these shapes.
 *
 * Floor-blind by construction: no type here carries the floor, and every number comes from
 * `clear()` output (cutoff = lowest winning bid) or the shopper's own bid.
 */

/** Minimum raise: $1 or 1% of the amount, whichever is larger, rounded up to a cent (19 §Logic 5). */
export function minRaiseCents(amountCents: number): number {
  return Math.max(100, Math.ceil(amountCents / 100));
}

/**
 * The raise a nudge suggests: `max(cutoff + minRaise(cutoff), current + minRaise(current))`.
 * The same number drives the template text, the bid page "Raise to" button and the auto-raise.
 */
export function suggestedRaiseCents(cutoffCents: number, yourBidCents: number): number {
  return Math.max(
    cutoffCents + minRaiseCents(cutoffCents),
    yourBidCents + minRaiseCents(yourBidCents),
  );
}

/** The numbers of one nudge, all from code (M10). `targetQuantity` is the brand's Q, not units left. */
export const nudgePayloadSchema = z
  .object({
    cutoffCents: z.number().int().positive(),
    yourBidCents: z.number().int().positive(),
    targetQuantity: z.number().int().positive(),
    /** End of this round; null while rounds advance by the "Next round" button (basic mode). */
    roundEndsAt: z.string().min(1).nullable(),
    suggestedCents: z.number().int().positive(),
  })
  .strict();
export type NudgePayload = z.infer<typeof nudgePayloadSchema>;

/** A `nudges` row as every consumer sees it (data-model §nudges). One per (listing, round, shopper). */
export const nudgeSchema = nudgePayloadSchema
  .extend({
    id: z.string().min(1),
    listingId: z.string().min(1),
    bidId: z.string().min(1),
    shopperId: z.string().min(1),
    round: z.number().int().positive(),
    text: z.string().min(1),
    sentAt: z.string().min(1),
  })
  .strict();
export type Nudge = z.infer<typeof nudgeSchema>;

/**
 * Nudge consumer (HF-038b `core/rounds-buyer.ts#onNudge`). Called after the round's snapshot
 * commits, once per new nudge; it must be idempotent (key raises on `raise:<nudge.id>`) and must
 * not block the round (queue the work).
 */
export type OnNudge = (nudge: Nudge) => void | Promise<void>;

// --- Auto-raise (HF-038b, features/19 §Logic 4) ----------------------------------------------

/** Why the buyer agent asks the shopper (M07) instead of raising on its own. */
export const AUTO_RAISE_ASK_REASONS = [
  /** The bid was placed without a mandate: the shopper raises themselves. */
  'NO_MANDATE',
  /** No saved card or wallet (vault): a raise needs the shopper present. */
  'NO_VAULT',
  /** The mandate is paused, fulfilled, expired or doesn't cover this product. */
  'MANDATE_INACTIVE',
  /** The target is above the mandate's max price per item. */
  'ABOVE_MANDATE_MAX',
  /** The target would take live holds past the mandate's total hold cap (D12). */
  'MANDATE_CAP',
  /** `release_if_cheaper` is on and the target is above the best public price (M11). */
  'ABOVE_PUBLIC_PRICE',
  /** The agent already raised this round, or 3 times on this listing (M11). */
  'AGENT_LIMIT',
  /** The agent tried, and PayPal declined the new hold; the old bid stands. */
  'RAISE_FAILED',
] as const;
export type AutoRaiseAskReason = (typeof AUTO_RAISE_ASK_REASONS)[number];

/** What the nudge consumer did with one nudge (audit `NUDGE_HANDLED`). */
export const AUTO_RAISE_OUTCOMES = ['RAISED', 'ASKED', 'SKIPPED'] as const;
export type AutoRaiseOutcome = (typeof AUTO_RAISE_OUTCOMES)[number];

/** The facts the auto-raise rule looks at, all re-read after the nudge (never from the model). */
export interface AutoRaiseFacts {
  /** The suggested raise (`suggestedRaiseCents`). */
  targetCents: number;
  hasMandate: boolean;
  /** The shopper has a saved card or wallet (S2 / S7 step 4: MIT holds from either vault). */
  vaulted: boolean;
  /** The mandate's own refusal of `targetCents`, or null when it covers it (`mandates` rules). */
  mandateDenial:
    | 'MANDATE_NOT_FOUND'
    | 'MANDATE_INACTIVE'
    | 'MANDATE_EXPIRED'
    | 'ABOVE_MANDATE_MAX'
    | 'MANDATE_EXCEEDED'
    | 'PRODUCT_NOT_ALLOWED'
    | null;
  releaseIfCheaper: boolean;
  bestPublicPriceCents: number | null;
  /** The M11 agent caps (once per round, 3 per listing per shopper; HF-018) are used up. */
  agentLimitReached: boolean;
}

/**
 * The auto-raise rule as a pure function: `RAISE` only when an ACTIVE mandate covers the target,
 * the shopper is vaulted, the M11 caps allow it and (with `release_if_cheaper`) the target is not
 * above the best public price. Otherwise the reason the shopper is asked. `raiseBid` re-checks
 * the mandate under `FOR UPDATE` (D12) and the caps; this is the cheap first pass.
 */
export function decideAutoRaise(
  f: AutoRaiseFacts,
): { action: 'RAISE' } | { action: 'ASK'; reason: AutoRaiseAskReason } {
  const ask = (reason: AutoRaiseAskReason) => ({ action: 'ASK' as const, reason });
  if (!f.hasMandate) return ask('NO_MANDATE');
  if (!f.vaulted) return ask('NO_VAULT');
  if (f.mandateDenial) return ask(askReasonForDenial(f.mandateDenial));
  if (
    f.releaseIfCheaper &&
    f.bestPublicPriceCents != null &&
    f.targetCents > f.bestPublicPriceCents
  ) {
    return ask('ABOVE_PUBLIC_PRICE');
  }
  if (f.agentLimitReached) return ask('AGENT_LIMIT');
  return { action: 'RAISE' };
}

export function askReasonForDenial(
  denial: NonNullable<AutoRaiseFacts['mandateDenial']>,
): AutoRaiseAskReason {
  switch (denial) {
    case 'ABOVE_MANDATE_MAX':
      return 'ABOVE_MANDATE_MAX';
    case 'MANDATE_EXCEEDED':
      return 'MANDATE_CAP';
    default:
      return 'MANDATE_INACTIVE';
  }
}

/**
 * The line M07 shows above the raise when the agent asked instead of raising. Null for bids
 * without a mandate (the shopper raises themselves; nothing to explain).
 */
export function autoRaiseAskCopy(
  reason: AutoRaiseAskReason,
  ctx: { targetCents: number; maxPriceCents?: number | null; publicPriceCents?: number | null },
): string | null {
  const to = formatUsd(ctx.targetCents);
  switch (reason) {
    case 'NO_MANDATE':
      return null;
    case 'NO_VAULT':
      return `Your agent needs a saved payment method to raise to ${to} for you.`;
    case 'MANDATE_INACTIVE':
      return `Your agent mandate doesn't cover this right now, so it didn't raise to ${to}.`;
    case 'ABOVE_MANDATE_MAX':
      return ctx.maxPriceCents != null
        ? `${to} is above your agent's max of ${formatUsd(ctx.maxPriceCents)}, so it's asking you.`
        : `${to} is above your agent's max, so it's asking you.`;
    case 'MANDATE_CAP':
      return `Raising to ${to} would go over your agent's total hold limit, so it's asking you.`;
    case 'ABOVE_PUBLIC_PRICE':
      return ctx.publicPriceCents != null
        ? `${to} is above the best public price of ${formatUsd(ctx.publicPriceCents)}, so your agent didn't raise.`
        : `${to} is above the best public price, so your agent didn't raise.`;
    case 'AGENT_LIMIT':
      return 'Your agent has used its raises here (once per round, 3 per listing), so it’s asking you.';
    case 'RAISE_FAILED':
      return `Your agent tried to raise to ${to}, but the new hold was declined.`;
  }
}

/** The agent's decision on this round's nudge, as `GET /bids/mine` shows it (HF-038b). */
export interface NudgeAgentDecision {
  outcome: AutoRaiseOutcome;
  reason: AutoRaiseAskReason | null;
  /** M07 line explaining why the agent asked; null when there is nothing to explain. */
  message: string | null;
}

/**
 * Template nudge text (Q#26: template in P0; HF-036b's Claude phrasing falls back to this):
 * "You're out at $219. The cutoff is $240. Raise to $241?"
 */
export function nudgeText(
  n: Pick<NudgePayload, 'yourBidCents' | 'cutoffCents' | 'suggestedCents'>,
): string {
  return `You're out at ${formatUsd(n.yourBidCents)}. The cutoff is ${formatUsd(n.cutoffCents)}. Raise to ${formatUsd(n.suggestedCents)}?`;
}

/** One bid the round will nudge, with its numbers. */
export interface NudgeDraft extends NudgePayload {
  bidId: string;
  shopperId: string;
  isSimulated: boolean;
}

/**
 * Which bids a round nudges (19 §Logic 2): every eligible HELD bid **not in `winners`**
 * (`belowCutoff = !winners.has(bid)`), which covers ties lost on time priority and bids below the
 * floor. One per shopper: a shopper who wins with one bid is never nudged, and a shopper's lower
 * duplicate (`superseded`) is skipped in favour of their best bid. Bids without a hold are never
 * in the book (D8). With no winners there is no truthful cutoff to quote, so nobody is nudged.
 */
export function selectNudges(
  result: ClearResult,
  ctx: { targetQuantity: number; roundEndsAt: string | null },
): NudgeDraft[] {
  const cutoff = result.cutoffCents;
  if (cutoff === null) return [];
  const winnerIds = new Set(result.winners.map((b) => b.id));
  const winningShoppers = new Set(result.winners.map((b) => b.shopperId));
  const seen = new Set<string>();
  // reserve and belowFloor are already one best bid per shopper, in rank order.
  const below: ClearBid[] = [...result.reserve, ...result.belowFloor].filter(
    (b) => !winnerIds.has(b.id) && !winningShoppers.has(b.shopperId),
  );
  const drafts: NudgeDraft[] = [];
  for (const b of below) {
    if (seen.has(b.shopperId)) continue;
    seen.add(b.shopperId);
    drafts.push({
      bidId: b.id,
      shopperId: b.shopperId,
      isSimulated: b.isSimulated,
      cutoffCents: cutoff,
      yourBidCents: b.amountCents,
      targetQuantity: ctx.targetQuantity,
      roundEndsAt: ctx.roundEndsAt,
      suggestedCents: suggestedRaiseCents(cutoff, b.amountCents),
    });
  }
  return drafts;
}

// --- API (api.md §rounds) --------------------------------------------------------------------

/** Body of `POST /listings/:id/rounds/start` and `PATCH /listings/:id/rounds`. `Q ≤ quantity` is checked server-side (422). */
export const roundsTargetRequestSchema = z
  .object({ targetQuantity: z.number().int().min(1) })
  .strict();
export type RoundsTargetRequest = z.infer<typeof roundsTargetRequestSchema>;

/**
 * Body of `POST /listings/:id/rounds/next`. `fromRound` (optional) is the round the console showed:
 * a stale click after someone else advanced gets 409 `ROUND_ADVANCED` instead of skipping a round.
 */
export const roundsNextRequestSchema = z
  .object({ fromRound: z.number().int().min(1).optional() })
  .strict();
export type RoundsNextRequest = z.infer<typeof roundsNextRequestSchema>;

/** Response of every rounds endpoint: the listing's rounds state after the call. Floor-blind. */
export const roundsStateSchema = z.object({
  listingId: z.string(),
  status: z.enum(LISTING_STATUSES),
  round: z.number().int().nullable(),
  targetQuantity: z.number().int().nullable(),
  roundsStartedAt: z.string().nullable(),
  roundEndsAt: z.string().nullable(),
  roundsEndAt: z.string().nullable(),
  windowClosesAt: z.string().nullable(),
  clearDeadlineAt: z.string().nullable(),
  /** Nudges written by this call (start / next). */
  nudged: z.number().int(),
  /** Set when this call ended rounds (stop, or nobody below the cutoff). */
  endedReason: z.enum(ROUND_END_REASONS).nullable(),
});
export type RoundsState = z.infer<typeof roundsStateSchema>;

/** `reason` values of a 409 `STATE_CONFLICT` from the rounds endpoints. */
export const ROUNDS_CONFLICT_REASONS = [
  /** Start: the listing is not OPEN. */
  'NOT_OPEN',
  /** Start: rounds already ran on this listing (once only, D6). */
  'ROUNDS_ALREADY_STARTED',
  /** Start: the 6 h after the window closed have already passed, so rounds would end at once. */
  'ROUNDS_WINDOW_PASSED',
  /** Next / stop / PATCH: the listing is not in ROUNDS. */
  'NOT_IN_ROUNDS',
  /** Next / stop / PATCH: `rounds_end_at` has passed; the book is frozen (D7). */
  'ROUNDS_ENDED',
  /** Next: another "Next round" advanced this round first (conditional UPDATE, 0 rows). */
  'ROUND_ADVANCED',
] as const;
export type RoundsConflictReason = (typeof ROUNDS_CONFLICT_REASONS)[number];
