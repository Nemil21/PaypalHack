import { isBiddable, isRaisable, type ListingStatus, type VoidReason } from '@holdfast/shared';
import { audit } from '../audit.js';
import { authorizeAndLand } from '../bids-authorize.js';
import {
  isTwoStep,
  markHoldFailed,
  paymentSourceFor,
  type BidPaymentMethod,
  type PlaceBidDeps,
  type PlaceBidInput,
} from '../bids.js';
import type { Queryable } from '../db.js';
import type { Actor } from '../money/deps.js';
import type { BidRow } from '../money/rows.js';
import { SQL_NOW, transition } from '../money/transition.js';
import { callVoid, loadBid, voidBid, voidKey, type VoidBidResult } from '../money/void.js';
import { orderRequestId } from '../paypal/ids.js';
import type { HoldResult, OrderView } from '../paypal/types.js';

/**
 * The hold sweeper (HF-034; B11 / INV-9, data-model rule 11). Every 5 min, under its advisory
 * lock (see `scheduler.ts`), it makes sure no hold outlives the reason for it. Every void goes
 * through `voidBid` / `callVoid` with `void-<bidId>` (D4), so racing another void path makes at
 * most one release at PayPal. Each pass makes **one** PayPal call per bid (no in-pass backoff:
 * the next pass is the retry); after `maxVoidRetries` failed passes the bid is audited
 * `VOID_STUCK` (alert) and left for a human.
 *
 * Cases:
 * 1. HELD bids on listings that no longer take bids: EXPIRED, CANCELLED, SETTLED, PAID_OUT,
 *    PAYOUT_FAILED, or CLEARING (a late hold after Clear's snapshot, `authorized_at` older than
 *    the grace period). VOIDING bids quiet for the grace period, on any listing.
 * 2. Clear's VOID settlements that FAILED (or RETRY rows on a listing no longer CLEARING), unless
 *    the failure is RECONCILE (money captured on a loser: already alerted, a human decides).
 * 3. CAPTURE_FAILED bids whose authorization is still there (GET first; a CAPTURED one alerts).
 * 4. LOST bids after the listing settled (or closed).
 * 5. PENDING_APPROVAL with an unknown outcome, per path:
 *    - card / vault create timed out (`needs_reconcile`): replay the create with the same request
 *      id (or GET the order when its id is known); void any hold found; then ABANDONED;
 *    - wallet / card-fields orders older than 30 min (or `needs_reconcile`): GET the order.
 *      APPROVED (or authorized) and the listing still biddable → `authorizeAndLand` (replays
 *      `authz-<bidId>`, lands via `landHold`); otherwise void any authorization and ABANDONED.
 */

export const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Don't touch rows another path may still be finishing. */
export const SWEEP_GRACE_SECONDS = 120;
/** A PENDING_APPROVAL bid with no approval after this is abandoned (features/03). */
export const ABANDON_AFTER_SECONDS = 30 * 60;
/** Failed sweeper passes on one bid before `VOID_STUCK`. */
export const SWEEP_MAX_VOID_RETRIES = 5;
const SWEEP_LIMIT = 200;

const SYSTEM: Actor = { type: 'SYSTEM', id: 'cron:hold-sweeper' };

export type SweepDeps = PlaceBidDeps;

export interface SweepOptions {
  graceSeconds?: number;
  abandonAfterSeconds?: number;
  maxVoidRetries?: number;
  limit?: number;
  onError?: (err: unknown, context: { bidId: string; step: string }) => void;
}

export interface SweepResult {
  /** Holds released (bid ended VOIDED, or ABANDONED after its authorization was voided). */
  voided: number;
  /** Voids PayPal still refused this pass (retried next pass). */
  voidFailed: number;
  /** Bids newly marked `VOID_STUCK`. */
  stuck: number;
  /** PENDING_APPROVAL bids whose approved order landed HELD. */
  landed: number;
  /** PENDING_APPROVAL bids ended ABANDONED with no hold. */
  abandoned: number;
  holdFailed: number;
  errors: number;
}

interface Ctx {
  deps: SweepDeps;
  grace: number;
  abandonAfter: number;
  maxRetries: number;
  limit: number;
  out: SweepResult;
  onError?: SweepOptions['onError'];
}

/** Bids already given up on (a human must look). */
const NOT_STUCK = `NOT EXISTS (SELECT 1 FROM audit_events a
                                 WHERE a.entity = 'bid' AND a.entity_id = b.id
                                   AND a.action = 'VOID_STUCK')`;

export async function sweepHolds(deps: SweepDeps, opts: SweepOptions = {}): Promise<SweepResult> {
  const ctx: Ctx = {
    // One PayPal call per bid per pass: the next pass is the retry.
    deps: { ...deps, voidBackoffMs: [] },
    grace: opts.graceSeconds ?? SWEEP_GRACE_SECONDS,
    abandonAfter: opts.abandonAfterSeconds ?? ABANDON_AFTER_SECONDS,
    maxRetries: opts.maxVoidRetries ?? SWEEP_MAX_VOID_RETRIES,
    limit: opts.limit ?? SWEEP_LIMIT,
    out: {
      voided: 0,
      voidFailed: 0,
      stuck: 0,
      landed: 0,
      abandoned: 0,
      holdFailed: 0,
      errors: 0,
    },
    onError: opts.onError,
  };
  await sweepClosedAndVoiding(ctx);
  await sweepFailedVoidSettlements(ctx);
  await sweepCaptureFailed(ctx);
  await sweepLostAfterSettled(ctx);
  await sweepPendingApprovals(ctx);
  return ctx.out;
}

// ---------------------------------------------------------------------------------------------
// 1. HELD on a closed listing; VOIDING left behind
// ---------------------------------------------------------------------------------------------

function closedReason(listingStatus: ListingStatus): VoidReason {
  if (listingStatus === 'EXPIRED') return 'WINDOW_EXPIRED';
  if (listingStatus === 'CANCELLED') return 'CANCELLED';
  return 'WINDOW_CLOSED';
}

async function sweepClosedAndVoiding(ctx: Ctx): Promise<void> {
  const rows = (
    await ctx.deps.db.pool.query(
      `SELECT b.id, b.status, b.void_reason, l.status AS listing_status
         FROM bids b JOIN listings l ON l.id = b.listing_id
        WHERE ((b.status = 'HELD'
                AND (l.status IN ('EXPIRED', 'CANCELLED', 'SETTLED', 'PAID_OUT', 'PAYOUT_FAILED')
                     OR (l.status = 'CLEARING'
                         AND b.authorized_at < now() - make_interval(secs => $1))))
               OR (b.status = 'VOIDING' AND b.updated_at < now() - make_interval(secs => $1)))
          AND ${NOT_STUCK}
        ORDER BY b.id LIMIT $2`,
      [ctx.grace, ctx.limit],
    )
  ).rows as Array<{
    id: string;
    status: string;
    void_reason: VoidReason | null;
    listing_status: ListingStatus;
  }>;
  for (const r of rows) {
    const reason =
      r.status === 'HELD' ? closedReason(r.listing_status) : (r.void_reason ?? 'CANCELLED');
    await sweepVoid(ctx, r.id, 'closed-or-voiding', () =>
      voidBid(ctx.deps, r.id, reason, SYSTEM, { from: ['HELD'], resume: true }),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 2. FAILED / RETRY VOID settlements
// ---------------------------------------------------------------------------------------------

async function sweepFailedVoidSettlements(ctx: Ctx): Promise<void> {
  const rows = (
    await ctx.deps.db.pool.query(
      `SELECT DISTINCT b.id, b.status, b.void_reason
         FROM settlements s
         JOIN bids b ON b.id = s.bid_id
         JOIN listings l ON l.id = s.listing_id
        WHERE s.action = 'VOID'
          AND (s.status = 'FAILED' OR (s.status = 'RETRY' AND l.status <> 'CLEARING'))
          AND s.error_class IS DISTINCT FROM 'RECONCILE'
          AND b.status IN ('LOST', 'CAPTURE_FAILED')
          AND ${NOT_STUCK}
        ORDER BY b.id LIMIT $1`,
      [ctx.limit],
    )
  ).rows as Array<{
    id: string;
    status: 'LOST' | 'CAPTURE_FAILED';
    void_reason: VoidReason | null;
  }>;
  for (const r of rows) {
    const reason = r.void_reason ?? (r.status === 'LOST' ? 'LOST' : 'CAPTURE_FAILED');
    await sweepVoid(ctx, r.id, 'failed-void-settlement', () =>
      voidBid(ctx.deps, r.id, reason, SYSTEM, { from: [r.status], resume: true }),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 3. CAPTURE_FAILED with a live authorization
// ---------------------------------------------------------------------------------------------

async function sweepCaptureFailed(ctx: Ctx): Promise<void> {
  const rows = (
    await ctx.deps.db.pool.query(
      `SELECT b.id, b.listing_id, b.paypal_authorization_id
         FROM bids b
        WHERE b.status = 'CAPTURE_FAILED' AND b.updated_at < now() - make_interval(secs => $1)
          AND ${NOT_STUCK}
        ORDER BY b.id LIMIT $2`,
      [ctx.grace, ctx.limit],
    )
  ).rows as Array<{ id: string; listing_id: string; paypal_authorization_id: string | null }>;
  for (const r of rows) {
    if (r.paypal_authorization_id) {
      let status: string;
      try {
        status = (await ctx.deps.paypal.getAuthorization(r.paypal_authorization_id)).status;
      } catch (err) {
        ctx.out.errors++;
        ctx.onError?.(err, { bidId: r.id, step: 'capture-failed:get' });
        continue;
      }
      if (status === 'CAPTURED' || status === 'PARTIALLY_CAPTURED') {
        // Money was taken although the capture "failed": never void, alert once.
        await markStuck(ctx, r.id, r.listing_id, r.paypal_authorization_id, {
          reason: 'CAPTURED_AFTER_CAPTURE_FAILED',
          authorizationStatus: status,
        });
        continue;
      }
    }
    await sweepVoid(ctx, r.id, 'capture-failed', () =>
      voidBid(ctx.deps, r.id, 'CAPTURE_FAILED', SYSTEM, { from: ['CAPTURE_FAILED'], resume: true }),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 4. LOST after SETTLED
// ---------------------------------------------------------------------------------------------

async function sweepLostAfterSettled(ctx: Ctx): Promise<void> {
  const rows = (
    await ctx.deps.db.pool.query(
      `SELECT b.id FROM bids b JOIN listings l ON l.id = b.listing_id
        WHERE b.status = 'LOST'
          AND l.status IN ('SETTLED', 'PAID_OUT', 'PAYOUT_FAILED', 'EXPIRED', 'CANCELLED')
          AND ${NOT_STUCK}
        ORDER BY b.id LIMIT $1`,
      [ctx.limit],
    )
  ).rows as Array<{ id: string }>;
  for (const r of rows) {
    await sweepVoid(ctx, r.id, 'lost-after-settled', () =>
      voidBid(ctx.deps, r.id, 'LOST', SYSTEM, { from: ['LOST'], resume: true }),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 5. PENDING_APPROVAL with an unknown outcome
// ---------------------------------------------------------------------------------------------

async function sweepPendingApprovals(ctx: Ctx): Promise<void> {
  const rows = (
    await ctx.deps.db.pool.query(
      `SELECT b.*, (b.placed_at < now() - make_interval(secs => $2)) AS overdue
         FROM bids b
        WHERE b.status = 'PENDING_APPROVAL'
          AND ((b.needs_reconcile AND b.placed_at < now() - make_interval(secs => $1))
               OR b.placed_at < now() - make_interval(secs => $2))
          AND ${NOT_STUCK}
        ORDER BY b.placed_at, b.id LIMIT $3`,
      [ctx.grace, ctx.abandonAfter, ctx.limit],
    )
  ).rows as Array<BidRow & { overdue: boolean; payment_method: string | null }>;
  for (const bid of rows) {
    try {
      if (isTwoStep(bid.payment_method) && bid.paypal_order_id) {
        await pollOrder(ctx, bid, bid.overdue);
      } else {
        await reconcileCreate(ctx, bid, bid.overdue);
      }
    } catch (err) {
      ctx.out.errors++;
      ctx.onError?.(err, { bidId: bid.id, step: 'pending' });
    }
  }
}

/**
 * Card / vault create (or a two-step create) whose outcome is unknown. The ticket's rule: replay
 * with the same request id, void a hold if one exists, then ABANDONED. A two-step create that
 * replays to an order waiting for the buyer just records the order (the order poll takes over).
 */
async function reconcileCreate(ctx: Ctx, bid: BidRow, overdue: boolean): Promise<void> {
  const { deps } = ctx;
  if (bid.paypal_order_id) {
    const order = await deps.paypal.getOrder(bid.paypal_order_id);
    const hold = order.authorizations.find((a) => a.status === 'CREATED');
    if (hold) {
      await voidAndAbandon(ctx, bid, hold.id, order.id, 'RECONCILED_VOIDED');
      return;
    }
    const other = order.authorizations[0]?.id ?? null;
    // A PENDING authorization may still turn into a hold: wait until the bid is overdue.
    if (order.authorizations.some((a) => a.status === 'PENDING') && !overdue) return;
    await abandon(ctx, bid, 'RECONCILED_NO_HOLD', other);
    return;
  }

  let result: HoldResult;
  const source = await paymentSourceFor(deps, {
    shopperId: bid.shopper_id,
    listingId: bid.listing_id,
    amountCents: bid.amount_cents,
    paymentMethod: (bid.payment_method ?? 'VAULT') as BidPaymentMethod,
    initiator: bid.mandate_id ? 'MERCHANT' : 'CUSTOMER',
  } as PlaceBidInput);
  if ('error' in source) {
    result = { kind: 'unknown', orderId: null, code: 'NO_PAYMENT_SOURCE', errorClass: 'RECONCILE' };
  } else {
    try {
      result = await deps.paypal.createAuthOrder({
        requestId: orderRequestId(bid.id),
        amountCents: bid.amount_cents,
        paymentSource: source.paymentSource,
        description: 'Holdfast held bid',
      });
    } catch (err) {
      result = {
        kind: 'unknown',
        orderId: null,
        code: err instanceof Error ? `CLIENT_${err.name}` : 'CLIENT_ERROR',
        errorClass: 'RECONCILE',
      };
    }
  }

  switch (result.kind) {
    case 'held':
      await voidAndAbandon(ctx, bid, result.authorizationId, result.orderId, 'RECONCILED_VOIDED');
      return;
    case 'needs_approval':
      if (isTwoStep(bid.payment_method)) {
        // The order exists and waits for the buyer: the order poll handles it from here.
        await deps.db.pool.query(
          `UPDATE bids SET paypal_order_id = $2, needs_reconcile = false
            WHERE id = $1 AND status = 'PENDING_APPROVAL'`,
          [bid.id, result.orderId],
        );
        return;
      }
      await abandon(ctx, bid, `PAYER_ACTION_REQUIRED:${result.status}`, null, result.orderId);
      return;
    case 'denied':
      await markHoldFailed(deps, bid, result.code, result.orderId, SYSTEM);
      ctx.out.holdFailed++;
      return;
    case 'pending':
      if (!overdue) {
        await recordOrder(ctx, bid.id, result.orderId);
        return;
      }
      await abandon(
        ctx,
        bid,
        `AUTHORIZATION_${result.status}`,
        result.authorizationId,
        result.orderId,
      );
      return;
    case 'unknown':
      if (result.orderId) await recordOrder(ctx, bid.id, result.orderId);
      if (!overdue) return;
      // Nothing PayPal will tell us: give up on the bid and alert (reconcile:holds is the backstop).
      await abandon(ctx, bid, 'RECONCILE_UNRESOLVED', null, result.orderId, { alert: true });
      return;
  }
}

/**
 * Wallet / card-fields order poll (the fallback for a missed wallet return before HF-033).
 */
async function pollOrder(ctx: Ctx, bid: BidRow, overdue: boolean): Promise<void> {
  const { deps } = ctx;
  const order: OrderView = await deps.paypal.getOrder(bid.paypal_order_id!);
  const hold = order.authorizations.find((a) => a.status === 'CREATED');
  const approved = order.status === 'APPROVED' || !!hold;

  if (approved && (await stillAccepts(deps.db.pool, bid))) {
    const res = await authorizeAndLand(deps, { bidId: bid.id, actor: SYSTEM, via: 'CRON' });
    if (res.ok) {
      ctx.out.landed++;
      return;
    }
    // The listing closed between our check and the landing. `authorizeAndLand` voids an
    // authorization `landHold` refused; if it abandoned before authorizing, make sure an
    // authorization made earlier is not left behind.
    const after = await loadBid(deps.db.pool, bid.id);
    if (
      hold &&
      !after.paypal_authorization_id &&
      ['ABANDONED', 'PENDING_APPROVAL'].includes(after.status)
    ) {
      await voidAndAbandon(ctx, after, hold.id, order.id, 'WINDOW_CLOSED');
    } else if (after.status === 'ABANDONED') {
      ctx.out.abandoned++;
    } else if (after.status === 'VOIDED') {
      ctx.out.voided++;
    }
    return;
  }
  if (hold) {
    await voidAndAbandon(ctx, bid, hold.id, order.id, 'WINDOW_CLOSED');
    return;
  }
  if (approved) {
    // Approved but the listing stopped taking bids: never authorize. Nothing is held.
    await abandon(ctx, bid, 'WINDOW_CLOSED', null);
    return;
  }
  if (overdue) await abandon(ctx, bid, 'NOT_APPROVED', order.authorizations[0]?.id ?? null);
}

/** D7 on DB time: a new bid needs `isBiddable`; a replacement needs `isRaisable`. */
async function stillAccepts(q: Queryable, bid: BidRow): Promise<boolean> {
  const l = (
    await q.query(
      `SELECT status, window_closes_at, rounds_end_at, clock_timestamp() AS db_now
         FROM listings WHERE id = $1`,
      [bid.listing_id],
    )
  ).rows[0] as
    | {
        status: ListingStatus;
        window_closes_at: Date | null;
        rounds_end_at: Date | null;
        db_now: Date;
      }
    | undefined;
  if (!l?.window_closes_at) return false;
  const timing = {
    status: l.status,
    windowClosesAt: l.window_closes_at,
    roundsEndAt: l.rounds_end_at,
  };
  return bid.replaces_bid_id ? isRaisable(timing, l.db_now) : isBiddable(timing, l.db_now);
}

async function recordOrder(ctx: Ctx, bidId: string, orderId: string | null): Promise<void> {
  if (!orderId) return;
  await ctx.deps.db.pool.query(
    `UPDATE bids SET paypal_order_id = $2 WHERE id = $1 AND status = 'PENDING_APPROVAL'
        AND paypal_order_id IS NULL`,
    [bidId, orderId],
  );
}

/**
 * PENDING_APPROVAL → ABANDONED: no hold exists. A non-CREATED authorization id (PENDING, EXPIRED)
 * is recorded so `reconcile:holds` can still check it later.
 */
async function abandon(
  ctx: Ctx,
  bid: BidRow,
  code: string,
  authorizationId: string | null,
  orderId?: string | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const row = await ctx.deps.db.tx(async (tx) => {
    const r = await transition<'bids', BidRow>(
      tx,
      'bids',
      bid.id,
      'PENDING_APPROVAL',
      'ABANDONED',
      {
        error_code: code,
        needs_reconcile: false,
        paypal_order_id: orderId ?? undefined,
        paypal_authorization_id: bid.paypal_authorization_id
          ? undefined
          : (authorizationId ?? undefined),
      },
    );
    if (r) {
      await ctx.deps.audit?.(tx, {
        actor: SYSTEM,
        action: 'BID_ABANDONED',
        entity: 'bid',
        entityId: r.id,
        listingId: r.listing_id,
        paypalId: r.paypal_order_id,
        data: { reason: code, held: false, ...extra },
      });
    }
    return r;
  });
  if (row) ctx.out.abandoned++;
}

/**
 * A hold exists that must not land: record it on the bid (so a crash leaves it findable), void it
 * with `void-<bidId>`, then end the bid ABANDONED (ticket: "void if a hold exists, then
 * ABANDONED"; `voided_at` says the authorization was released).
 */
async function voidAndAbandon(
  ctx: Ctx,
  bid: BidRow,
  authorizationId: string,
  orderId: string | null,
  code: string,
): Promise<void> {
  const { deps } = ctx;
  let recorded: BidRow | undefined;
  try {
    recorded = (
      await deps.db.pool.query(
        `UPDATE bids SET paypal_authorization_id = $2,
                         paypal_order_id = COALESCE($3, paypal_order_id),
                         void_request_id = $4, needs_reconcile = true
          WHERE id = $1 AND status IN ('PENDING_APPROVAL', 'ABANDONED')
            AND (paypal_authorization_id IS NULL OR paypal_authorization_id = $2)
          RETURNING *`,
        [bid.id, authorizationId, orderId, voidKey(bid.id)],
      )
    ).rows[0] as BidRow | undefined;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      // Another bid owns this authorization and its own void key; never void it as this bid (D4).
      await markStuck(ctx, bid.id, bid.listing_id, authorizationId, {
        reason: 'FOREIGN_AUTHORIZATION',
      });
      return;
    }
    throw err;
  }
  if (!recorded) return;

  const call = await callVoid(deps, bid.id, authorizationId);
  if (!call.done) {
    await recordVoidFailure(ctx, bid.id, bid.listing_id, authorizationId, call.code);
    return;
  }
  const ended = await deps.db.tx(async (tx) => {
    let r = await transition<'bids', BidRow>(tx, 'bids', bid.id, 'PENDING_APPROVAL', 'ABANDONED', {
      error_code: code,
      needs_reconcile: false,
      voided_at: SQL_NOW,
    });
    if (!r) {
      r =
        ((
          await tx.query(
            `UPDATE bids SET needs_reconcile = false, voided_at = coalesce(voided_at, now())
            WHERE id = $1 AND status = 'ABANDONED' RETURNING *`,
            [bid.id],
          )
        ).rows[0] as BidRow | undefined) ?? null;
    }
    if (r) {
      await deps.audit?.(tx, {
        actor: SYSTEM,
        action: 'BID_ABANDONED',
        entity: 'bid',
        entityId: r.id,
        listingId: r.listing_id,
        paypalId: authorizationId,
        requestId: voidKey(r.id),
        data: { reason: code, held: true, voided: true },
      });
    }
    return r;
  });
  if (ended) {
    ctx.out.voided++;
    ctx.out.abandoned++;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

async function sweepVoid(
  ctx: Ctx,
  bidId: string,
  step: string,
  run: () => Promise<VoidBidResult>,
): Promise<void> {
  let res: VoidBidResult;
  try {
    res = await run();
  } catch (err) {
    ctx.out.errors++;
    ctx.onError?.(err, { bidId, step });
    return;
  }
  if (res.outcome === 'VOIDED' || res.outcome === 'ALREADY_VOIDED') ctx.out.voided++;
  else if (res.outcome === 'LEFT_VOIDING') {
    await recordVoidFailure(
      ctx,
      bidId,
      res.bid.listing_id,
      res.bid.paypal_authorization_id,
      res.code,
    );
  }
}

async function recordVoidFailure(
  ctx: Ctx,
  bidId: string,
  listingId: string,
  authorizationId: string | null,
  code: string,
): Promise<void> {
  ctx.out.voidFailed++;
  await audit(ctx.deps.db.pool, {
    actorType: SYSTEM.type,
    actorId: SYSTEM.id,
    listingId,
    entity: 'bid',
    entityId: bidId,
    action: 'SWEEP_VOID_FAILED',
    paypalId: authorizationId,
    requestId: voidKey(bidId),
    data: { code },
  });
  const n = (
    await ctx.deps.db.pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity = 'bid' AND entity_id = $1 AND action = 'SWEEP_VOID_FAILED'`,
      [bidId],
    )
  ).rows[0] as { n: number };
  if (n.n >= ctx.maxRetries) {
    await markStuck(ctx, bidId, listingId, authorizationId, {
      reason: 'VOID_RETRIES_EXHAUSTED',
      code,
      attempts: n.n,
    });
  }
}

/** `VOID_STUCK` (alert): the sweeper stops touching this bid; ops (HF-058) shows it. */
async function markStuck(
  ctx: Ctx,
  bidId: string,
  listingId: string,
  authorizationId: string | null,
  data: Record<string, unknown>,
): Promise<void> {
  ctx.out.stuck++;
  await audit(ctx.deps.db.pool, {
    actorType: SYSTEM.type,
    actorId: SYSTEM.id,
    listingId,
    entity: 'bid',
    entityId: bidId,
    action: 'VOID_STUCK',
    paypalId: authorizationId,
    requestId: voidKey(bidId),
    data: { ...data, alert: true },
  });
}
