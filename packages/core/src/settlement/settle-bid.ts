import type { ErrorClass, SettlementAction, SettlementStatus } from '@holdfast/shared';
import { audit, auditHook, auditRequested } from '../audit.js';
import type { Db, Queryable } from '../db.js';
import { DEFAULT_VOID_BACKOFF_MS, type Actor, type MoneyDeps } from '../money/deps.js';
import { claim, DEFAULT_LEASE_SECONDS, release, renew, type Lease } from '../money/lease.js';
import type { BidRow } from '../money/rows.js';
import { SQL_NOW, transition, type TransitionExtra } from '../money/transition.js';
import {
  emitVoided,
  isReleased,
  loadBid,
  voidBid,
  voidKey,
  type VoidBidResult,
} from '../money/void.js';
import { captureInputFor } from '../paypal/orders.js';
import type {
  CaptureInput,
  CaptureResult,
  MockResponseCode,
  PayPalClient,
  VoidResult,
} from '../paypal/types.js';
import {
  promoteWithin as defaultPromoteWithin,
  type PromoteOutcome,
  type PromoteWithin,
} from './promote.js';
import { emitSettlementUpdated } from './view.js';

/**
 * `settleBid(settlementId)` (HF-029; features/11 §Workflow design): moves the money for one
 * settlement row. It is a pure function of the settlement id, so the in-process coordinator
 * (HF-030a) and the Render Workflows adapter (HF-030b) run the same code, and it can be retried,
 * replayed or taken over after a crash without double-charging:
 *
 * - the row is claimed under a 60 s lease (D11) and every write is fenced by that lease;
 * - capture uses `PayPal-Request-Id = settlement.id` and void `void-<bidId>` (D4, D5), so a
 *   second worker repeats the same PayPal call and gets the same answer;
 * - PayPal calls run with no transaction open (INV-1).
 *
 * This task is the only retry owner (Render-level retries are off): TRANSIENT failures are retried
 * here, 4 calls in total, then the row goes to RETRY for the coordinator.
 */

export const DEFAULT_SETTLE_BACKOFF_MS = DEFAULT_VOID_BACKOFF_MS;
/** When an exhausted RETRY row is due again (`next_attempt_at`). */
export const DEFAULT_RETRY_DELAY_SECONDS = 30;

const WORKFLOW: Actor = { type: 'WORKFLOW' };
const TEST_DECLINE_MOCK: MockResponseCode = 'INSTRUMENT_DECLINED';
/** Bid statuses a VOID settlement may release. Never WON or CAPTURED. */
const VOIDABLE = ['LOST', 'VOIDING', 'CAPTURE_FAILED'] as const;

export interface SettleBidDeps {
  db: Db;
  paypal: Pick<PayPalClient, 'capture' | 'void'>;
  /** Waits between PayPal calls (D11: 1 s, 4 s, 16 s → 4 calls in total). */
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  leaseSeconds?: number;
  retryDelaySeconds?: number;
  /** HF-031 `promoteWithin`; tests may wrap it. */
  promoteWithin?: PromoteWithin;
  /** HF-017a `mandates.onCaptured(bidId)`, called after the capture commits. */
  onCaptured?: (bidId: string) => Promise<void>;
  /**
   * `mockDeclinesAllowed(config)`: sandbox + DEMO_MODE + ALLOW_MOCK_DECLINE. Without it neither
   * `settlements.mock_response` nor `bids.test_decline` reaches PayPal. The PayPal client applies
   * the same gate again.
   */
  allowMockDecline?: boolean;
  actor?: Actor;
  /** Errors after the outcome committed (onCaptured); they never change the outcome. */
  onError?: (err: unknown, context: { settlementId: string; bidId: string; step: string }) => void;
}

export type SettleBidResult =
  /** Not claimable: finished, cancelled, or another worker holds a live lease. No-op. */
  | { outcome: 'SKIPPED'; status: SettlementStatus }
  | {
      outcome: 'SUCCEEDED';
      action: SettlementAction;
      paypalId: string | null;
      paypalStatus: string;
      reconciled: boolean;
      calls: number;
    }
  | {
      outcome: 'FAILED';
      action: SettlementAction;
      errorClass: ErrorClass;
      code: string;
      calls: number;
      promotion: PromoteOutcome | null;
      void: VoidBidResult['outcome'] | null;
    }
  | { outcome: 'RETRY'; action: SettlementAction; code: string; calls: number }
  /** The lease expired and another worker took the row over; nothing was written. */
  | { outcome: 'LEASE_LOST'; action: SettlementAction; calls: number };

interface SettlementDbRow {
  id: string;
  listing_id: string;
  bid_id: string;
  action: SettlementAction;
  amount_cents: number | null;
  mock_response: string | null;
  paypal_id: string | null;
  attempts: number;
}

type SettlementLease = Lease<SettlementDbRow> & { table: 'settlements' };

class LeaseLost extends Error {
  constructor() {
    super('settlement lease lost');
  }
}

interface Ctx {
  deps: SettleBidDeps;
  lease: SettlementLease;
  s: SettlementDbRow;
  bid: BidRow;
  actor: Actor;
}

export async function settleBid(
  deps: SettleBidDeps,
  settlementId: string,
): Promise<SettleBidResult> {
  const pool = deps.db.pool;
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const claimed = await claim<SettlementDbRow>(pool, 'settlements', settlementId, leaseSeconds);
  if (!claimed) {
    const res = await pool.query(`SELECT status FROM settlements WHERE id = $1`, [settlementId]);
    const row = res.rows[0] as { status: SettlementStatus } | undefined;
    if (!row) throw new Error(`settlement ${settlementId} not found`);
    return { outcome: 'SKIPPED', status: row.status };
  }
  const lease = claimed as SettlementLease;
  await pool.query(
    `UPDATE settlements SET started_at = coalesce(started_at, now())
      WHERE id = $1 AND status = 'RUNNING' AND attempts = $2`,
    [lease.id, lease.token],
  );
  const ctx: Ctx = {
    deps,
    lease,
    s: lease.row,
    bid: await loadBid(pool, lease.row.bid_id),
    actor: deps.actor ?? WORKFLOW,
  };
  try {
    return ctx.s.action === 'CAPTURE' ? await runCapture(ctx) : await runVoid(ctx);
  } catch (err) {
    if (err instanceof LeaseLost) return { outcome: 'LEASE_LOST', action: ctx.s.action, calls: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CAPTURE
// ---------------------------------------------------------------------------

async function runCapture(ctx: Ctx): Promise<SettleBidResult> {
  const { deps, s, bid } = ctx;
  if (bid.status !== 'WON') {
    // Only a WON bid is ever charged. Nothing to promote: this bid was not a live winner.
    return finishFailed(ctx, 'TERMINAL', `BID_${bid.status}`, 0, { alert: true });
  }
  const mock = deps.allowMockDecline
    ? (s.mock_response ?? (bid.test_decline === true ? TEST_DECLINE_MOCK : null))
    : null;
  let input: CaptureInput;
  try {
    // INV-5: settlement amount = bid amount = authorized amount, on the bid's own authorization.
    input = captureInputFor({ ...s, mock_response: mock }, bid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.startsWith('INV-5') ? 'INV5_VIOLATION' : 'PRECONDITION_FAILED';
    return finishFailed(ctx, 'TERMINAL', code, 0, { alert: true, error: msg });
  }

  await auditRequested(deps.db, {
    actorType: ctx.actor.type,
    actorId: ctx.actor.id ?? null,
    listingId: s.listing_id,
    entity: 'settlement',
    entityId: s.id,
    action: 'CAPTURE',
    requestId: input.requestId,
    data: { bidId: bid.id, amountCents: input.amountCents, attempt: ctx.lease.token },
  });

  const { result, calls } = await withRetries<CaptureResult>(
    ctx,
    () => deps.paypal.capture(input),
    (r) => !r.ok && r.errorClass === 'TRANSIENT',
    (code) => ({ ok: false, errorClass: 'TRANSIENT', code, http: 0, alert: false }),
  );

  if (result.ok) {
    // COMPLETED or PENDING (judged by the body). `reconciled`: a 422 "already captured" resolved
    // by GETting the authorization (RECONCILE, B4): success with the existing capture id.
    return finishSucceeded(ctx, {
      paypalId: result.captureId ?? s.paypal_id,
      paypalStatus: result.status,
      reconciled: result.reconciled,
      calls,
      requestId: input.requestId,
    });
  }
  if (result.errorClass === 'TRANSIENT') return finishRetry(ctx, result.code, calls);
  if (result.authorizationStatus === undefined && !result.code.startsWith('CAPTURE_')) {
    // PayPal never told us the authorization's state (e.g. our credentials were refused): the
    // buyer was not declined, so don't fail their bid or promote. Retry later and alert.
    return finishRetry(ctx, result.code, calls, { alert: true });
  }
  // TERMINAL: declined, authorization expired or voided. The authorization still needs a void.
  return finishCaptureFailed(ctx, result.code, calls, {
    authorizationStatus: result.authorizationStatus ?? null,
    alert: result.alert,
  });
}

// ---------------------------------------------------------------------------
// VOID
// ---------------------------------------------------------------------------

async function runVoid(ctx: Ctx): Promise<SettleBidResult> {
  const { deps, s, bid } = ctx;
  const authId = bid.paypal_authorization_id;
  if (bid.status === 'VOIDED' || !authId) {
    // Already released on another path (e.g. after a failed promoted capture), or never held.
    return finishSucceeded(ctx, {
      paypalId: authId,
      paypalStatus: 'VOIDED',
      reconciled: true,
      calls: 0,
      requestId: voidKey(bid.id),
    });
  }
  if (!(VOIDABLE as readonly string[]).includes(bid.status)) {
    // Never void a winner (WON / CAPTURED): the row is stale, e.g. its bid was promoted.
    return finishFailed(ctx, 'TERMINAL', `BID_${bid.status}`, 0, { alert: true });
  }

  const requestId = voidKey(bid.id);
  await auditRequested(deps.db, {
    actorType: ctx.actor.type,
    actorId: ctx.actor.id ?? null,
    listingId: s.listing_id,
    entity: 'settlement',
    entityId: s.id,
    action: 'VOID',
    requestId,
    data: { bidId: bid.id, attempt: ctx.lease.token },
  });

  const { result, calls } = await withRetries<VoidResult>(
    ctx,
    async () => {
      await deps.db.pool.query(
        `UPDATE bids SET void_attempts = void_attempts + 1, void_request_id = $2 WHERE id = $1`,
        [bid.id, requestId],
      );
      return deps.paypal.void(authId, requestId);
    },
    (r) => !isReleased(r) && !r.ok && r.errorClass === 'TRANSIENT',
    (code) => ({ ok: false, errorClass: 'TRANSIENT', code, http: 0, alert: false }),
  );

  if (isReleased(result)) {
    // VOIDED, or a 422 resolved to VOIDED / EXPIRED (RECONCILE): nothing is held any more.
    return finishSucceeded(ctx, {
      paypalId: authId,
      paypalStatus: 'VOIDED',
      reconciled: result.ok ? result.reconciled : true,
      calls,
      requestId,
    });
  }
  if (result.ok) throw new Error('unreachable: ok void not released');
  if (result.errorClass === 'TRANSIENT') return finishRetry(ctx, result.code, calls);
  // RECONCILE that found CAPTURED (money taken on a loser) or another terminal answer: a human
  // must look. The bid keeps its status.
  return finishFailed(ctx, result.errorClass, result.code, calls, {
    alert: true,
    authorizationStatus: result.authorizationStatus ?? null,
  });
}

// ---------------------------------------------------------------------------
// Retries (D11)
// ---------------------------------------------------------------------------

/**
 * Up to `1 + backoff.length` calls with the same request id, renewing the lease before each
 * retry. A thrown error (network, timeout) is TRANSIENT. Throws `LeaseLost` when another worker
 * took the row over while we were backing off.
 */
async function withRetries<R>(
  ctx: Ctx,
  call: () => Promise<R>,
  isTransient: (r: R) => boolean,
  networkFailure: (code: string) => R,
): Promise<{ result: R; calls: number }> {
  const { deps } = ctx;
  const backoff = deps.backoffMs ?? DEFAULT_SETTLE_BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let result = networkFailure('NOT_CALLED');
  let calls = 0;
  for (let i = 0; i <= backoff.length; i++) {
    if (i > 0) {
      await sleep(backoff[i - 1] ?? 0);
      if (!(await renew(deps.db.pool, ctx.lease, deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS))) {
        throw new LeaseLost();
      }
    }
    calls++;
    try {
      result = await call();
    } catch {
      result = networkFailure('NETWORK');
    }
    if (!isTransient(result)) break;
  }
  return { result, calls };
}

// ---------------------------------------------------------------------------
// Outcomes: one fenced transaction each
// ---------------------------------------------------------------------------

async function releaseOrThrow(
  tx: Queryable,
  ctx: Ctx,
  to: SettlementStatus,
  extra: TransitionExtra,
): Promise<void> {
  const row = await release(tx, ctx.lease, to, extra);
  if (!row) throw new LeaseLost();
}

function auditSettlement(
  tx: Queryable,
  ctx: Ctx,
  action: string,
  fields: { paypalId?: string | null; requestId?: string | null; data?: Record<string, unknown> },
) {
  return audit(tx, {
    actorType: ctx.actor.type,
    actorId: ctx.actor.id ?? null,
    listingId: ctx.s.listing_id,
    entity: 'settlement',
    entityId: ctx.s.id,
    action,
    paypalId: fields.paypalId ?? null,
    requestId: fields.requestId ?? null,
    data: { bidId: ctx.bid.id, ...fields.data },
  });
}

async function finishSucceeded(
  ctx: Ctx,
  out: {
    paypalId: string | null;
    paypalStatus: string;
    reconciled: boolean;
    calls: number;
    requestId: string;
  },
): Promise<SettleBidResult> {
  const { deps, s, bid } = ctx;
  const isCapture = s.action === 'CAPTURE';
  await deps.db.tx(async (tx) => {
    await releaseOrThrow(tx, ctx, 'SUCCEEDED', {
      paypal_id: out.paypalId,
      paypal_status: out.paypalStatus,
      error_class: null,
      error_code: null,
      next_attempt_at: null,
      finished_at: SQL_NOW,
    });
    const moved = isCapture
      ? await transition<'bids', BidRow>(tx, 'bids', bid.id, 'WON', 'CAPTURED')
      : await transition<'bids', BidRow>(tx, 'bids', bid.id, VOIDABLE, 'VOIDED', {
          voided_at: SQL_NOW,
          void_reason: bid.void_reason ?? 'LOST',
          void_request_id: voidKey(bid.id),
        });
    if (moved && !isCapture) await emitVoided(tx, moved);
    await auditSettlement(tx, ctx, `${s.action}_SUCCEEDED`, {
      paypalId: out.paypalId,
      requestId: out.requestId,
      data: {
        paypalStatus: out.paypalStatus,
        reconciled: out.reconciled,
        calls: out.calls,
        amountCents: isCapture ? bid.amount_cents : undefined,
        // The money moved but the bid had already left WON/LOST on another path: flag it.
        bidStatusMismatch: moved ? undefined : bid.status,
      },
    });
    await emitSettlementUpdated(tx, s.listing_id, s.id);
  });

  if (isCapture && deps.onCaptured) {
    try {
      await deps.onCaptured(bid.id);
    } catch (err) {
      deps.onError?.(err, { settlementId: s.id, bidId: bid.id, step: 'onCaptured' });
    }
  }
  return {
    outcome: 'SUCCEEDED',
    action: s.action,
    paypalId: out.paypalId,
    paypalStatus: out.paypalStatus,
    reconciled: out.reconciled,
    calls: out.calls,
  };
}

async function finishRetry(
  ctx: Ctx,
  code: string,
  calls: number,
  flags: { alert?: boolean } = {},
): Promise<SettleBidResult> {
  const { deps, s } = ctx;
  const delay = deps.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS;
  await deps.db.tx(async (tx) => {
    await releaseOrThrow(tx, ctx, 'RETRY', {
      error_class: flags.alert ? 'TERMINAL' : 'TRANSIENT',
      error_code: code,
      next_attempt_at: new Date(Date.now() + delay * 1000),
    });
    await auditSettlement(tx, ctx, `${s.action}_FAILED`, {
      requestId: requestIdOf(ctx),
      data: { errorClass: 'TRANSIENT', code, calls, willRetry: true, alert: flags.alert },
    });
    await emitSettlementUpdated(tx, s.listing_id, s.id);
  });
  return { outcome: 'RETRY', action: s.action, code, calls };
}

/** FAILED without touching the bid (stale row, INV-5 violation, void on a captured hold). */
async function finishFailed(
  ctx: Ctx,
  errorClass: ErrorClass,
  code: string,
  calls: number,
  data: Record<string, unknown>,
): Promise<SettleBidResult> {
  const { deps, s } = ctx;
  await deps.db.tx(async (tx) => {
    await releaseOrThrow(tx, ctx, 'FAILED', {
      error_class: errorClass,
      error_code: code,
      finished_at: SQL_NOW,
    });
    await auditSettlement(tx, ctx, `${s.action}_FAILED`, {
      requestId: requestIdOf(ctx),
      data: { errorClass, code, calls, ...data },
    });
    await emitSettlementUpdated(tx, s.listing_id, s.id);
  });
  return {
    outcome: 'FAILED',
    action: s.action,
    errorClass,
    code,
    calls,
    promotion: null,
    void: null,
  };
}

/**
 * Terminal capture failure (features/11, D9): in one transaction the settlement → FAILED, the bid
 * WON → CAPTURE_FAILED (conditional, so only one path wins) and `promoteWithin`; then, outside it,
 * void the failed authorization with `void-<bidId>` (already voided / expired counts as done).
 */
async function finishCaptureFailed(
  ctx: Ctx,
  code: string,
  calls: number,
  info: { authorizationStatus: string | null; alert: boolean },
): Promise<SettleBidResult> {
  const { deps, s, bid } = ctx;
  const promote = deps.promoteWithin ?? defaultPromoteWithin;
  const { failed, promotion } = await deps.db.tx(async (tx) => {
    // Lock order: listing → bids (data-model §Locking rule 3); promoteWithin locks it again.
    await tx.query(`SELECT id FROM listings WHERE id = $1 FOR UPDATE`, [s.listing_id]);
    await releaseOrThrow(tx, ctx, 'FAILED', {
      error_class: 'TERMINAL',
      error_code: code,
      paypal_status: info.authorizationStatus,
      finished_at: SQL_NOW,
    });
    const failedBid = await transition<'bids', BidRow>(
      tx,
      'bids',
      bid.id,
      'WON',
      'CAPTURE_FAILED',
      {
        error_code: code,
      },
    );
    await auditSettlement(tx, ctx, 'CAPTURE_FAILED', {
      requestId: requestIdOf(ctx),
      data: {
        errorClass: 'TERMINAL',
        code,
        calls,
        authorizationStatus: info.authorizationStatus,
        alert: info.alert,
      },
    });
    const promoted = failedBid ? await promote(tx, bid.id) : null;
    await emitSettlementUpdated(tx, s.listing_id, s.id);
    if (promoted?.settlementId) {
      await emitSettlementUpdated(tx, s.listing_id, promoted.settlementId);
    }
    return { failed: failedBid, promotion: promoted };
  });

  let voided: VoidBidResult['outcome'] | null = null;
  if (failed) {
    // Left VOIDING on persistent failure: the sweeper (HF-034) finishes it. A crash here leaves
    // no open settlement row, so `settleListing` re-runs this before it settles the listing.
    voided = (await voidFailedCapture(deps, bid.id, ctx.actor)).outcome;
  }
  return {
    outcome: 'FAILED',
    action: 'CAPTURE',
    errorClass: 'TERMINAL',
    code,
    calls,
    promotion,
    void: voided,
  };
}

/**
 * Release a failed winner's authorization (`void-<bidId>`): CAPTURE_FAILED → VOIDING → VOIDED.
 * With `resume`, a bid already VOIDING (its first attempt crashed or kept failing) is finished
 * too; the shared request id makes a repeated PayPal call return the same void.
 */
export function voidFailedCapture(
  deps: SettleBidDeps,
  bidId: string,
  actor: Actor,
  { resume = false }: { resume?: boolean } = {},
): Promise<VoidBidResult> {
  const moneyDeps: MoneyDeps = {
    db: deps.db,
    paypal: deps.paypal,
    audit: auditHook,
    voidBackoffMs: deps.backoffMs ?? DEFAULT_SETTLE_BACKOFF_MS,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  return voidBid(moneyDeps, bidId, 'CAPTURE_FAILED', actor, { from: ['CAPTURE_FAILED'], resume });
}

function requestIdOf(ctx: Ctx): string {
  return ctx.s.action === 'CAPTURE' ? ctx.s.id : voidKey(ctx.bid.id);
}
