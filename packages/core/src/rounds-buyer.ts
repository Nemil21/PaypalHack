import {
  clear,
  decideAutoRaise,
  pendingHoldsWarning,
  suggestedRaiseCents,
  type AutoRaiseAskReason,
  type AutoRaiseOutcome,
  type Nudge,
} from '@holdfast/shared';
import { audit } from './audit.js';
import { agentRaiseCounts, agentRaiseLimit, raiseBid, type RaiseBidError } from './bid-raise.js';
import type { PlaceBidDeps } from './bids.js';
import { loadClearInput } from './clearInput.js';
import type { Queryable } from './db.js';
import { checkMandateLimits, liveHoldCents } from './mandates.js';
import type { Actor } from './money/deps.js';
import { nudgeFromRow, type NudgeRow } from './rounds/nudges.js';

/**
 * Buyer side of live rounds, full part (HF-038b; features/19 §Logic 4–5, features/05 §Logic 4).
 * The rounds runner (HF-036a/b) hands every new nudge to `onNudge` after its snapshot commits;
 * this consumer decides, in plain code, whether the shopper's agent raises:
 *
 * - re-read the bid: skip it when it is no longer HELD, the round moved on, or it already ranks
 *   in on the current book;
 * - `target = max(cutoff + minRaise(cutoff), current + minRaise(current))`;
 * - auto-raise only when an ACTIVE mandate covers the target, the shopper has a vault (card or
 *   wallet, S7 step 4), the M11 caps allow it (once per round, 3 per listing) and, with
 *   `release_if_cheaper` on, the target is not above `products.best_public_price_cents`;
 *   otherwise the shopper is asked through the M07 raise sheet;
 * - the raise is HF-018's `raiseBid` with `Idempotency-Key = raise:<nudgeId>`, actor
 *   `BUYER_AGENT` (`SIM` for simulated shoppers) and a vaulted merchant-initiated hold. `raiseBid`
 *   re-checks the mandate under `FOR UPDATE` (D12) and the caps, so the pre-check here can only
 *   be stricter, never looser.
 *
 * Each handled nudge leaves one `NUDGE_HANDLED` audit row (outcome, reason, target), which the bid
 * page reads to explain an ask and `sweep()` uses to pick up nudges a restart dropped. Work runs
 * on an in-process queue (concurrency 5), so the round tick never waits on PayPal.
 */

export const NUDGE_HANDLED_ACTION = 'NUDGE_HANDLED';
/** Written once per bid chain on the auto-raise that makes `raise_count` 5. */
export const PENDING_HOLDS_WARNED_ACTION = 'RAISE_HOLDS_WARNED';
export const NUDGE_CONSUMER_CONCURRENCY = 5;

/** Why a nudge needed no decision. */
export type NudgeSkipReason =
  | 'BID_NOT_FOUND'
  | 'BID_NOT_HELD'
  | 'NOT_IN_ROUNDS'
  | 'STALE_ROUND'
  | 'RANKS_IN'
  | 'ROUNDS_ENDED'
  | 'RAISE_IN_PROGRESS'
  | 'NEEDS_RECONCILE';

export interface NudgeHandled {
  nudgeId: string;
  bidId: string;
  outcome: AutoRaiseOutcome;
  reason: AutoRaiseAskReason | NudgeSkipReason | null;
  targetCents: number | null;
  /** RAISED: the new HELD bid. */
  newBidId?: string;
  /** RAISED: the new bid's `raise_count` reached 5, and the warning was written. */
  warnedPendingHolds?: boolean;
  /** Another delivery of the same nudge owns the outcome; nothing was recorded by this one. */
  duplicate?: boolean;
}

interface NudgeBidRow {
  id: string;
  status: string;
  shopper_id: string;
  listing_id: string;
  amount_cents: number;
  mandate_id: string | null;
  release_if_cheaper: boolean;
  is_simulated: boolean;
  paypal_vault_id: string | null;
  listing_status: string;
  current_round: number | null;
  target_quantity: number | null;
  quantity: number;
  product_id: string;
  best_public_price_cents: number | null;
}

/** The agent acting for this shopper: `SIM` labels simulated shoppers' raises everywhere. */
export function agentActor(shopperId: string, isSimulated: boolean): Actor {
  return { type: isSimulated ? 'SIM' : 'BUYER_AGENT', id: shopperId };
}

/** A `raiseBid` refusal → ask the shopper (with why), or skip (nothing for the shopper to do). */
export function outcomeForRaiseError(
  error: RaiseBidError,
):
  | { outcome: 'ASKED'; reason: AutoRaiseAskReason }
  | { outcome: 'SKIPPED'; reason: NudgeSkipReason } {
  const asked = (reason: AutoRaiseAskReason) => ({ outcome: 'ASKED' as const, reason });
  const skipped = (reason: NudgeSkipReason) => ({ outcome: 'SKIPPED' as const, reason });
  switch (error.code) {
    case 'ABOVE_MANDATE_MAX':
      return asked('ABOVE_MANDATE_MAX');
    case 'MANDATE_EXCEEDED':
      return asked(error.reason === 'PRODUCT_NOT_ALLOWED' ? 'MANDATE_INACTIVE' : 'MANDATE_CAP');
    case 'MANDATE_PAUSED':
      return asked('MANDATE_INACTIVE');
    case 'PRICE_DROPPED':
      return asked('ABOVE_PUBLIC_PRICE');
    case 'STATE_CONFLICT':
      if (error.reason.startsWith('AGENT_RAISE_LIMIT')) return asked('AGENT_LIMIT');
      if (error.reason === 'RAISE_IN_PROGRESS') return skipped('RAISE_IN_PROGRESS');
      return skipped('BID_NOT_HELD');
    case 'WINDOW_CLOSED':
      return skipped('ROUNDS_ENDED');
    case 'IN_PROGRESS':
      return skipped('RAISE_IN_PROGRESS');
    case 'PAYPAL_ERROR':
      // Unknown at PayPal: reconcile:holds (HF-034) settles it; the old bid stands meanwhile.
      return skipped('NEEDS_RECONCILE');
    case 'VALIDATION_ERROR':
      if (error.field === 'paymentMethod') return asked('NO_VAULT');
      return skipped('BID_NOT_HELD');
    default:
      return asked('RAISE_FAILED');
  }
}

/** Handle one nudge: decide, raise or ask, and record the outcome. Safe to call twice. */
export async function handleNudge(deps: PlaceBidDeps, nudge: Nudge): Promise<NudgeHandled> {
  const base = { nudgeId: nudge.id, bidId: nudge.bidId };
  const row = await loadNudgeBid(deps.db.pool, nudge.bidId);
  if (!row) return { ...base, outcome: 'SKIPPED', reason: 'BID_NOT_FOUND', targetCents: null };
  const actor = agentActor(row.shopper_id, row.is_simulated);
  const key = `raise:${nudge.id}`;
  const finish = async (h: NudgeHandled) => {
    if (!h.duplicate) await recordHandled(deps, nudge, row, actor, h);
    return h;
  };
  /**
   * A pre-check outcome. Another delivery of this nudge may already have started the raise (its
   * in-flight bid uses up the agent cap, or its swap already replaced the bid): then this one
   * follows that raise (a replay) instead of recording a different outcome.
   */
  const decided = async (h: NudgeHandled) => {
    const started = await raiseByKey(deps.db.pool, row.shopper_id, key);
    return started ? raise(started.amount_cents) : finish(h);
  };
  const skip = (reason: NudgeSkipReason, targetCents: number | null = null) =>
    decided({ ...base, outcome: 'SKIPPED', reason, targetCents });

  const raise = async (targetCents: number): Promise<NudgeHandled> => {
    const raised = await raiseBid(deps, {
      bidId: row.id,
      amountCents: targetCents,
      shopperId: row.shopper_id,
      idempotencyKey: key,
      actor,
      agentInitiated: true,
      initiator: 'MERCHANT',
    });
    if (!raised.ok) {
      const o = outcomeForRaiseError(raised.error);
      // A replay that is still in flight belongs to the first delivery; it records the outcome.
      const duplicate = raised.replayed && o.outcome === 'SKIPPED';
      return finish({ ...base, ...o, targetCents, duplicate });
    }
    const newBid = raised.bid;
    const warned =
      !!newBid.authorized_at &&
      pendingHoldsWarning(Number(newBid.raise_count ?? 0)) !== null &&
      (await warnPendingHolds(
        deps,
        newBid.id,
        newBid.listing_id,
        Number(newBid.raise_count),
        actor,
      ));
    return finish({
      ...base,
      outcome: 'RAISED',
      reason: null,
      targetCents,
      newBidId: newBid.id,
      warnedPendingHolds: warned,
    });
  };

  if (row.status !== 'HELD') return skip('BID_NOT_HELD');
  if (row.listing_status !== 'ROUNDS') return skip('NOT_IN_ROUNDS');
  if (row.current_round !== nudge.round) return skip('STALE_ROUND');
  if (await ranksIn(deps.db.pool, row)) return skip('RANKS_IN');

  const targetCents = suggestedRaiseCents(nudge.cutoffCents, row.amount_cents);
  const decision = decideAutoRaise({
    targetCents,
    hasMandate: !!row.mandate_id,
    vaulted: !!row.paypal_vault_id,
    mandateDenial: row.mandate_id ? await mandateDenial(deps.db.pool, row, targetCents) : null,
    releaseIfCheaper: row.release_if_cheaper,
    bestPublicPriceCents: row.best_public_price_cents,
    agentLimitReached:
      agentRaiseLimit(
        await agentRaiseCounts(deps.db.pool, row.listing_id, row.shopper_id, row.current_round),
      ) !== null,
  });
  if (decision.action === 'ASK') {
    return decided({ ...base, outcome: 'ASKED', reason: decision.reason, targetCents });
  }
  return raise(targetCents);
}

/** The bid a delivery of this nudge already created with `raise:<nudgeId>`, if any. */
async function raiseByKey(
  q: Queryable,
  shopperId: string,
  key: string,
): Promise<{ amount_cents: number } | null> {
  const res = await q.query(
    `SELECT amount_cents FROM bids WHERE shopper_id = $1 AND idempotency_key = $2`,
    [shopperId, key],
  );
  return (res.rows[0] as { amount_cents: number } | undefined) ?? null;
}

async function loadNudgeBid(q: Queryable, bidId: string): Promise<NudgeBidRow | null> {
  const res = await q.query(
    `SELECT b.id, b.status, b.shopper_id, b.listing_id, b.amount_cents, b.mandate_id,
            b.release_if_cheaper,
            (s.is_simulated OR b.source = 'SIM') IS TRUE AS is_simulated, s.paypal_vault_id,
            l.status AS listing_status, l.current_round, l.target_quantity, l.quantity,
            l.product_id, p.best_public_price_cents
       FROM bids b
       JOIN shoppers s ON s.id = b.shopper_id
       JOIN listings l ON l.id = b.listing_id
       JOIN products p ON p.id = l.product_id
      WHERE b.id = $1`,
    [bidId],
  );
  return (res.rows[0] as NudgeBidRow | undefined) ?? null;
}

/** On the live book, would this bid win at the round's Q? (A raise or a release may have moved it.) */
async function ranksIn(q: Queryable, row: NudgeBidRow): Promise<boolean> {
  const book = await loadClearInput(q, row.listing_id);
  if (!book) return false;
  const result = clear(book.bids, row.target_quantity ?? row.quantity, book.floorCents);
  return result.winners.some((b) => b.id === row.id);
}

/** The mandate's answer for `targetCents`, without locking (the raise re-checks FOR UPDATE). */
async function mandateDenial(q: Queryable, row: NudgeBidRow, targetCents: number) {
  const res = await q.query(
    `SELECT m.*, clock_timestamp() AS db_now FROM mandates m WHERE m.id = $1 AND m.shopper_id = $2`,
    [row.mandate_id, row.shopper_id],
  );
  const mandate = res.rows[0] as
    (Parameters<typeof checkMandateLimits>[0] & { db_now: Date }) | undefined;
  if (!mandate) return 'MANDATE_NOT_FOUND' as const;
  return checkMandateLimits(mandate, {
    newHoldCents: targetCents,
    liveCents: await liveHoldCents(q, row.mandate_id!, [row.id]),
    productId: row.product_id,
    now: mandate.db_now,
  });
}

/**
 * One `NUDGE_HANDLED` row per nudge: the first delivery to finish wins, except that a raise is
 * always recorded (it is what happened to the money). In the narrow race where a duplicate
 * delivery recorded an ask or skip before the raise it lost to landed, readers prefer `RAISED`.
 */
async function recordHandled(
  deps: PlaceBidDeps,
  nudge: Nudge,
  row: NudgeBidRow,
  actor: Actor,
  h: NudgeHandled,
): Promise<void> {
  await deps.db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`nudge:${nudge.id}`]);
    const seen = await tx.query(
      `SELECT data->>'outcome' AS outcome FROM audit_events
        WHERE listing_id = $1 AND action = $2 AND data->>'nudgeId' = $3`,
      [row.listing_id, NUDGE_HANDLED_ACTION, nudge.id],
    );
    const outcomes = (seen.rows as { outcome: string }[]).map((r) => r.outcome);
    if (outcomes.includes('RAISED') || (outcomes.length > 0 && h.outcome !== 'RAISED')) return;
    await audit(tx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      listingId: row.listing_id,
      entity: 'bid',
      entityId: row.id,
      action: NUDGE_HANDLED_ACTION,
      data: {
        nudgeId: nudge.id,
        round: nudge.round,
        outcome: h.outcome,
        reason: h.reason,
        cutoffCents: nudge.cutoffCents,
        targetCents: h.targetCents,
        newBidId: h.newBidId ?? null,
      },
    });
  });
}

/** The once-per-chain pending-holds warning on the new bid (exactly once: guarded per bid). */
async function warnPendingHolds(
  deps: PlaceBidDeps,
  bidId: string,
  listingId: string,
  raiseCount: number,
  actor: Actor,
): Promise<boolean> {
  return deps.db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`warn:${bidId}`]);
    const seen = await tx.query(
      `SELECT 1 FROM audit_events WHERE entity = 'bid' AND entity_id = $1 AND action = $2 LIMIT 1`,
      [bidId, PENDING_HOLDS_WARNED_ACTION],
    );
    if (seen.rows.length > 0) return false;
    await audit(tx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      listingId,
      entity: 'bid',
      entityId: bidId,
      action: PENDING_HOLDS_WARNED_ACTION,
      data: { raiseCount, message: pendingHoldsWarning(raiseCount) },
    });
    return true;
  });
}

/**
 * Nudges of the current round in listings still in ROUNDS that have no `NUDGE_HANDLED` row yet:
 * what a restart (or a dropped delivery) left behind.
 */
export async function unhandledNudges(q: Queryable): Promise<Nudge[]> {
  const res = await q.query(
    `SELECT n.* FROM nudges n
       JOIN listings l ON l.id = n.listing_id
      WHERE l.status = 'ROUNDS' AND n.round = l.current_round
        AND (l.rounds_end_at IS NULL OR l.rounds_end_at > clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM audit_events a
                         WHERE a.listing_id = n.listing_id AND a.action = $1
                           AND a.data->>'nudgeId' = n.id::text)
      ORDER BY n.sent_at, n.id`,
    [NUDGE_HANDLED_ACTION],
  );
  return (res.rows as NudgeRow[]).map(nudgeFromRow);
}

export interface NudgeConsumerOptions {
  /** Nudges handled at once (default 5). */
  concurrency?: number;
  onHandled?: (h: NudgeHandled) => void;
  onError?: (err: unknown, nudge: Nudge) => void;
}

export interface NudgeConsumer {
  /** The `OnNudge` hook for `RoundsDeps`: queues and returns at once. */
  onNudge(nudge: Nudge): void;
  /** Queue every unhandled nudge of a live round (restart recovery). Returns how many. */
  sweep(): Promise<number>;
  /** Resolves when the queue is empty and nothing is running. */
  drain(): Promise<void>;
  readonly pending: number;
}

/**
 * The queue behind `onNudge` (`core/rounds-buyer.ts#onNudge`). One nudge id is queued once per
 * process; across instances `raise:<nudgeId>` keeps it to one raise.
 */
export function createNudgeConsumer(
  deps: PlaceBidDeps,
  opts: NudgeConsumerOptions = {},
): NudgeConsumer {
  const concurrency = Math.max(1, opts.concurrency ?? NUDGE_CONSUMER_CONCURRENCY);
  const queue: Nudge[] = [];
  const known = new Set<string>();
  let active = 0;
  let idle: Array<() => void> = [];

  const settle = () => {
    if (active > 0 || queue.length > 0) return;
    const waiters = idle;
    idle = [];
    for (const w of waiters) w();
  };
  const pump = () => {
    while (active < concurrency && queue.length > 0) {
      const nudge = queue.shift()!;
      active++;
      void handleNudge(deps, nudge)
        .then((h) => opts.onHandled?.(h))
        .catch((err) => opts.onError?.(err, nudge))
        .finally(() => {
          active--;
          known.delete(nudge.id);
          pump();
          settle();
        });
    }
  };
  const onNudge = (nudge: Nudge) => {
    if (known.has(nudge.id)) return;
    known.add(nudge.id);
    queue.push(nudge);
    pump();
  };

  return {
    onNudge,
    async sweep() {
      const found = await unhandledNudges(deps.db.pool);
      for (const n of found) onNudge(n);
      return found.length;
    },
    drain: () =>
      active === 0 && queue.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => idle.push(resolve)),
    get pending() {
      return queue.length + active;
    },
  };
}
