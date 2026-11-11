import { audit } from '../audit.js';
import type { Db, Queryable } from '../db.js';
import type { Actor } from '../money/deps.js';
import type { AuthorizationView, CaptureView, PayPalClient } from '../paypal/types.js';
import { runLimited } from '../settlement/settle-listing.js';

/**
 * Nightly capture / void reconcile (HF-058; features/15 §Logic 5, D19). For every settlement that
 * finished in the last 24 h, GET the authorization (and, for captures, its order: S7 shows the
 * authorization has no capture link) and compare PayPal with what the database recorded. It only
 * **flags**: each disagreement is audited `RECONCILE_MISMATCH` (alert) on the settlement, and the
 * run is summed up in one `CAPTURE_RECONCILE_RUN` row that W20's health panel reads. It never
 * captures or voids; the hold sweeper and `reconcile:holds` (HF-034) own releasing holds.
 *
 * What agrees with PayPal:
 *   CAPTURE SUCCEEDED  authorization CAPTURED; the order shows a COMPLETED / PENDING capture with
 *                      the recorded capture id and the settlement amount
 *   CAPTURE FAILED     authorization not CAPTURED (CREATED, VOIDED, EXPIRED…)
 *   VOID SUCCEEDED     authorization VOIDED (or EXPIRED: nothing is held either way)
 *   VOID FAILED        authorization not CAPTURED (a still-CREATED hold is the sweeper's job)
 * QUEUED / RUNNING / RETRY rows are in flight and skipped; CANCELLED rows never called PayPal.
 */

export const CAPTURE_RECONCILE_WINDOW_HOURS = 24;
/** The hourly job runs a reconcile only when the last one is at least this old. */
export const CAPTURE_RECONCILE_EVERY_HOURS = 23;
export const CAPTURE_RECONCILE_CHECK_INTERVAL_MS = 60 * 60_000;
const CONCURRENCY = 5;

export const CAPTURE_RECONCILE_ACTOR: Actor = { type: 'SYSTEM', id: 'reconcile:captures' };

export interface CaptureReconcileDeps {
  db: Db;
  paypal: Pick<PayPalClient, 'getAuthorization' | 'getOrder'>;
}

export type MismatchReason =
  | 'NO_AUTHORIZATION'
  | 'NOT_CAPTURED'
  | 'CAPTURE_MISSING'
  | 'CAPTURE_ID_MISMATCH'
  | 'CAPTURE_AMOUNT_MISMATCH'
  | 'CAPTURE_NOT_COMPLETED'
  | 'CAPTURED_AFTER_FAILED_CAPTURE'
  | 'HOLD_STILL_LIVE'
  | 'CAPTURED_ON_VOID'
  | 'VOID_NOT_CONFIRMED';

export interface ReconcileMismatch {
  settlementId: string;
  listingId: string;
  bidId: string;
  action: 'CAPTURE' | 'VOID';
  settlementStatus: 'SUCCEEDED' | 'FAILED';
  authorizationId: string | null;
  reason: MismatchReason;
  expected: string;
  actual: {
    authorizationStatus: string | null;
    captureId?: string | null;
    captureStatus?: string | null;
    captureAmountCents?: number | null;
  };
}

export interface CaptureReconcileResult {
  /** Settlements compared with PayPal. */
  checked: number;
  matched: number;
  /** PayPal GETs that failed (retried next night). */
  failed: number;
  mismatches: ReconcileMismatch[];
}

export interface CaptureReconcileOptions {
  windowHours?: number;
  /** Only these listings (default: every listing). */
  listingIds?: readonly string[];
  concurrency?: number;
  onError?: (err: unknown, settlementId: string) => void;
}

interface Row {
  id: string;
  listing_id: string;
  bid_id: string;
  action: 'CAPTURE' | 'VOID';
  status: 'SUCCEEDED' | 'FAILED';
  amount_cents: number | null;
  paypal_id: string | null;
  authorization_id: string | null;
  order_id: string | null;
}

const isCaptured = (s: string | null) => s === 'CAPTURED' || s === 'PARTIALLY_CAPTURED';

export async function reconcileCaptures(
  deps: CaptureReconcileDeps,
  opts: CaptureReconcileOptions = {},
): Promise<CaptureReconcileResult> {
  const windowHours = opts.windowHours ?? CAPTURE_RECONCILE_WINDOW_HOURS;
  const rows = (
    await deps.db.pool.query(
      `SELECT s.id, s.listing_id, s.bid_id, s.action, s.status, s.amount_cents, s.paypal_id,
              b.paypal_authorization_id AS authorization_id, b.paypal_order_id AS order_id
         FROM settlements s JOIN bids b ON b.id = s.bid_id
        WHERE s.status IN ('SUCCEEDED', 'FAILED')
          AND coalesce(s.finished_at, s.updated_at) > now() - make_interval(hours => $1)
          AND ($2::uuid[] IS NULL OR s.listing_id = ANY($2::uuid[]))
        ORDER BY s.id`,
      [windowHours, opts.listingIds ? [...opts.listingIds] : null],
    )
  ).rows as Row[];

  const out: CaptureReconcileResult = { checked: 0, matched: 0, failed: 0, mismatches: [] };
  await runLimited(rows, opts.concurrency ?? CONCURRENCY, async (row) => {
    let mismatch: ReconcileMismatch | null;
    try {
      mismatch = await compare(deps, row);
    } catch (err) {
      out.failed++;
      opts.onError?.(err, row.id);
      return;
    }
    out.checked++;
    if (mismatch) out.mismatches.push(mismatch);
    else out.matched++;
  });

  // Flag every mismatch, then the run summary, in one transaction.
  await deps.db.tx(async (tx) => {
    for (const m of out.mismatches) await flag(tx, m);
    await audit(tx, {
      actorType: CAPTURE_RECONCILE_ACTOR.type,
      actorId: CAPTURE_RECONCILE_ACTOR.id,
      entity: 'reconcile',
      action: 'CAPTURE_RECONCILE_RUN',
      data: {
        windowHours,
        checked: out.checked,
        matched: out.matched,
        failed: out.failed,
        mismatches: out.mismatches.length,
        alert: out.mismatches.length > 0,
      },
    });
  });
  return out;
}

async function compare(deps: CaptureReconcileDeps, row: Row): Promise<ReconcileMismatch | null> {
  const base = {
    settlementId: row.id,
    listingId: row.listing_id,
    bidId: row.bid_id,
    action: row.action,
    settlementStatus: row.status,
    authorizationId: row.authorization_id,
  };
  if (!row.authorization_id) {
    // A FAILED row may never have reached PayPal; a SUCCEEDED one must have an authorization.
    if (row.status === 'FAILED') return null;
    return {
      ...base,
      reason: 'NO_AUTHORIZATION',
      expected: 'an authorization id on the bid',
      actual: { authorizationStatus: null },
    };
  }
  const auth: AuthorizationView = await deps.paypal.getAuthorization(row.authorization_id);
  const status = auth.status ?? null;
  const miss = (
    reason: MismatchReason,
    expected: string,
    extra: Partial<ReconcileMismatch['actual']> = {},
  ): ReconcileMismatch => ({
    ...base,
    reason,
    expected,
    actual: { authorizationStatus: status, ...extra },
  });

  if (row.action === 'VOID') {
    if (isCaptured(status)) return miss('CAPTURED_ON_VOID', 'authorization not captured');
    if (row.status === 'FAILED') return null;
    if (status === 'VOIDED' || status === 'EXPIRED') return null;
    if (status === 'CREATED') return miss('HOLD_STILL_LIVE', 'authorization VOIDED');
    return miss('VOID_NOT_CONFIRMED', 'authorization VOIDED');
  }

  if (row.status === 'FAILED') {
    return isCaptured(status)
      ? miss('CAPTURED_AFTER_FAILED_CAPTURE', 'authorization not captured')
      : null;
  }
  if (status !== 'CAPTURED') return miss('NOT_CAPTURED', 'authorization CAPTURED');

  const orderId = auth.orderId ?? row.order_id;
  const capture = orderId ? await captureOf(deps, orderId, row.authorization_id) : null;
  if (!capture) return miss('CAPTURE_MISSING', 'a capture on the order');
  const seen = {
    captureId: capture.id,
    captureStatus: capture.status,
    captureAmountCents: capture.amountCents,
  };
  if (row.paypal_id && capture.id !== row.paypal_id) {
    return miss('CAPTURE_ID_MISMATCH', `capture ${row.paypal_id}`, seen);
  }
  if (row.amount_cents !== null && capture.amountCents !== row.amount_cents) {
    return miss('CAPTURE_AMOUNT_MISMATCH', `capture of ${row.amount_cents} cents`, seen);
  }
  if (capture.status !== 'COMPLETED' && capture.status !== 'PENDING') {
    return miss('CAPTURE_NOT_COMPLETED', 'capture COMPLETED or PENDING', seen);
  }
  return null;
}

/** The capture made from `authorizationId`, read from its order (as the client's `findCapture`). */
async function captureOf(
  deps: CaptureReconcileDeps,
  orderId: string,
  authorizationId: string,
): Promise<CaptureView | null> {
  const order = await deps.paypal.getOrder(orderId);
  const mine = order.captures.filter((c) => c.authorizationId === authorizationId);
  if (mine.length) return mine[0] ?? null;
  return order.captures.length === 1 ? (order.captures[0] ?? null) : null;
}

async function flag(tx: Queryable, m: ReconcileMismatch): Promise<void> {
  await audit(tx, {
    actorType: CAPTURE_RECONCILE_ACTOR.type,
    actorId: CAPTURE_RECONCILE_ACTOR.id,
    listingId: m.listingId,
    entity: 'settlement',
    entityId: m.settlementId,
    action: 'RECONCILE_MISMATCH',
    paypalId: m.actual.captureId ?? m.authorizationId,
    data: {
      bidId: m.bidId,
      settlementAction: m.action,
      settlementStatus: m.settlementStatus,
      authorizationId: m.authorizationId,
      reason: m.reason,
      expected: m.expected,
      actual: m.actual,
      alert: true,
    },
  });
}

export type NightlyCaptureReconcileResult =
  | { skipped: true; lastRunAt: Date }
  | (Omit<CaptureReconcileResult, 'mismatches'> & { skipped: false; mismatches: number });

/**
 * The hourly cron entry: reconciles only when the last `CAPTURE_RECONCILE_RUN` is at least 23 h
 * old (or there is none), so a restart never skips a night and never doubles one. Runs under the
 * scheduler's advisory lock, so only one instance reconciles.
 */
export async function runNightlyCaptureReconcile(
  deps: CaptureReconcileDeps,
  opts: CaptureReconcileOptions & { everyHours?: number } = {},
): Promise<NightlyCaptureReconcileResult> {
  const last = await lastCaptureReconcile(deps.db.pool);
  const every = opts.everyHours ?? CAPTURE_RECONCILE_EVERY_HOURS;
  if (last && last.ageSeconds < every * 3600) return { skipped: true, lastRunAt: last.at };
  const res = await reconcileCaptures(deps, opts);
  return { ...res, skipped: false, mismatches: res.mismatches.length };
}

export interface LastCaptureReconcile {
  at: Date;
  ageSeconds: number;
  checked: number;
  matched: number;
  failed: number;
  mismatches: number;
}

export async function lastCaptureReconcile(q: Queryable): Promise<LastCaptureReconcile | null> {
  const r = (
    await q.query(
      `SELECT at, extract(epoch FROM now() - at)::float8 AS age, data
         FROM audit_events
        WHERE entity = 'reconcile' AND action = 'CAPTURE_RECONCILE_RUN'
        ORDER BY id DESC LIMIT 1`,
    )
  ).rows[0] as { at: Date; age: number; data: Record<string, unknown> } | undefined;
  if (!r) return null;
  const n = (k: string) => (typeof r.data[k] === 'number' ? (r.data[k] as number) : 0);
  return {
    at: r.at,
    ageSeconds: r.age,
    checked: n('checked'),
    matched: n('matched'),
    failed: n('failed'),
    mismatches: n('mismatches'),
  };
}
