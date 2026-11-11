import { audit, auditHook } from '../audit.js';
import type { Db, Queryable } from '../db.js';
import { DEFAULT_VOID_BACKOFF_MS, type Actor, type MoneyDeps } from '../money/deps.js';
import type { BidRow } from '../money/rows.js';
import { SQL_NOW, transition } from '../money/transition.js';
import { emitVoided, voidBid, voidKey } from '../money/void.js';
import { payoutItemOutcome } from '../paypal/payouts.js';
import type { PayoutBatchView, PayoutItemView, PayPalClient } from '../paypal/types.js';
import { applyPayoutBatch, findPayoutBySenderBatchId, resolveBatch } from '../payouts/index.js';
import type { KickSettlement } from '../settlement/outbox.js';
import {
  promoteWithin as defaultPromoteWithin,
  type PromoteWithin,
} from '../settlement/promote.js';
import { emitSettlementUpdated } from '../settlement/view.js';
import {
  markWebhookFailed,
  markWebhookProcessed,
  pendingWebhookEvents,
  type WebhookEventRow,
} from '../webhooks.js';

/**
 * HF-033: PayPal's own events back up every money state (api.md §`POST /webhooks/paypal`,
 * features/11 §Idempotency, data-model §Locking rules 1 and 7). A task that died after PayPal
 * succeeded still ends correct.
 *
 * - Mapping: a capture's `supplementary_data.related_ids.authorization_id` (an authorization's own
 *   `id`), falling back to `custom_id` = `invoice_id` = bid id (D5) → bid → its CAPTURE
 *   settlement. Payout batches map by `sender_batch_id` (= payout attempt, HF-032).
 * - Every change is a conditional transition under the listing lock (lock order listing → bids,
 *   as `settleBid` and `promoteWithin`), so an event racing `settleBid` (HF-029), the sweeper or a
 *   redelivery of itself changes a state once, and a promotion starts at most once: only the
 *   caller whose `WON → CAPTURE_FAILED` moved the bid promotes.
 * - A handler that throws rolls its transaction back and leaves the event unprocessed
 *   (`processed_at IS NULL`); the redelivery or the minute cron (`reprocessPayPalWebhooks`)
 *   runs it again.
 *
 * `PAYMENT.AUTHORIZATION.CREATED` is deliberately not handled (a missed wallet return is caught
 * by the HF-034 sweeper GETting the order); `CUSTOMER.DISPUTE.CREATED` is P2 (README only).
 */

export const PAYPAL_WEBHOOK_EVENTS = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
] as const;
export type PayPalWebhookEventType = (typeof PAYPAL_WEBHOOK_EVENTS)[number];

/** The parts of a PayPal webhook body we read. */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
}

export interface PayPalWebhookDeps {
  db: Db;
  /** `void` for a declined capture's authorization; `getPayoutBatch` for the item status. */
  paypal: Pick<PayPalClient, 'void' | 'getPayoutBatch'>;
  /** HF-031; tests may wrap it. */
  promoteWithin?: PromoteWithin;
  /** `mandates.onCaptured` (as `SettleBidDeps.onCaptured`), after a capture commits. */
  onCaptured?: (bidId: string) => Promise<void>;
  /** Re-kick the listing's coordinator after a capture changed, so SETTLED follows promptly. */
  kickSettlement?: KickSettlement;
  /** Void retries (D11). */
  voidBackoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  actor?: Actor;
  /** Follow-up steps that never change the outcome (onCaptured, kick, void left VOIDING). */
  onError?: (err: unknown, ctx: { eventId: string; step: string }) => void;
}

export type PayPalWebhookOutcome =
  /** A state moved. */
  | 'APPLIED'
  /** The state already said so (our own task, or an earlier delivery, got there first). */
  | 'ALREADY'
  /** Recorded for a human (audit `alert`), no state change: e.g. DENIED after SETTLED. */
  | 'FLAGGED'
  /** No bid / payout of ours matches (another app on the same sandbox account, spikes). */
  | 'UNMATCHED'
  /** An event type we don't handle. */
  | 'IGNORED';

export interface PayPalWebhookResult {
  outcome: PayPalWebhookOutcome;
  eventType: string;
  bidId?: string;
  payoutId?: string;
  /** Promoted bid when a DENIED capture promoted (at most once per failed bid). */
  promotedBidId?: string | null;
  detail?: string;
}

const WEBHOOK_ACTOR: Actor = { type: 'SYSTEM', id: 'paypal-webhook' };
const OPEN_OR_FAILED = ['QUEUED', 'RUNNING', 'RETRY', 'FAILED'] as const;
const OPEN = ['QUEUED', 'RUNNING', 'RETRY'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parse a webhook body; null when it is not a PayPal event (no id / event_type). */
export function parsePayPalEvent(body: unknown): PayPalWebhookEvent | null {
  const b = obj(body);
  const id = str(b.id);
  const type = str(b.event_type);
  if (!id || !type) return null;
  return { id, event_type: type, resource: obj(b.resource) };
}

/** The authorization a capture or authorization resource belongs to. */
export function authorizationIdOf(event: PayPalWebhookEvent): string | null {
  const r = event.resource;
  if (event.event_type.startsWith('PAYMENT.AUTHORIZATION.')) return str(r.id);
  return str(obj(obj(r.supplementary_data).related_ids).authorization_id);
}

/** `custom_id` (else `invoice_id`): the bid id we sent at order create (D5). */
export function bidIdOf(event: PayPalWebhookEvent): string | null {
  const id = str(event.resource.custom_id) ?? str(event.resource.invoice_id);
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

/**
 * The bid an event is about: by authorization id, else by `custom_id` when that bid has no other
 * authorization stored.
 */
export async function findBidForEvent(
  q: Queryable,
  event: PayPalWebhookEvent,
): Promise<BidRow | null> {
  const authId = authorizationIdOf(event);
  if (authId) {
    const res = await q.query(`SELECT * FROM bids WHERE paypal_authorization_id = $1`, [authId]);
    if (res.rows[0]) return res.rows[0] as BidRow;
  }
  const bidId = bidIdOf(event);
  if (!bidId) return null;
  const bid = (await q.query(`SELECT * FROM bids WHERE id = $1`, [bidId])).rows[0] as
    BidRow | undefined;
  if (!bid) return null;
  if (authId && bid.paypal_authorization_id && bid.paypal_authorization_id !== authId) return null;
  return bid;
}

/** Process one event. Throws (after rolling back) on a database or PayPal read failure. */
export async function processPayPalEvent(
  deps: PayPalWebhookDeps,
  event: PayPalWebhookEvent,
): Promise<PayPalWebhookResult> {
  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      return captureCompleted(deps, event);
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      return captureDenied(deps, event);
    case 'PAYMENT.AUTHORIZATION.VOIDED':
      return authorizationVoided(deps, event);
    case 'PAYMENT.PAYOUTSBATCH.SUCCESS':
    case 'PAYMENT.PAYOUTSBATCH.DENIED':
      return payoutBatch(deps, event);
    default:
      return { outcome: 'IGNORED', eventType: event.event_type };
  }
}

/**
 * Process a recorded `webhook_events` row, then set `processed_at`. On failure the row stays
 * unprocessed with `last_error` (reprocessable) and the error is rethrown.
 */
export async function processPayPalWebhookRow(
  deps: PayPalWebhookDeps,
  row: Pick<WebhookEventRow, 'id' | 'payload'>,
): Promise<PayPalWebhookResult> {
  const event = parsePayPalEvent(row.payload);
  if (!event) {
    await markWebhookProcessed(deps.db.pool, row.id);
    return { outcome: 'IGNORED', eventType: 'UNPARSABLE' };
  }
  let result: PayPalWebhookResult;
  try {
    result = await processPayPalEvent(deps, event);
  } catch (err) {
    await markWebhookFailed(deps.db.pool, row.id, err);
    throw err;
  }
  await markWebhookProcessed(deps.db.pool, row.id);
  return result;
}

export interface ReprocessResult {
  processed: number;
  failed: number;
}

/**
 * The minute cron (and boot): PayPal rows still unprocessed after `olderThanMs` (default 1 min,
 * so an in-flight async run is not raced needlessly), oldest first.
 */
export async function reprocessPayPalWebhooks(
  deps: PayPalWebhookDeps,
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<ReprocessResult> {
  const rows = await pendingWebhookEvents(deps.db.pool, {
    provider: 'PAYPAL',
    olderThanMs: opts.olderThanMs ?? 60_000,
    limit: opts.limit ?? 100,
  });
  const out: ReprocessResult = { processed: 0, failed: 0 };
  for (const row of rows) {
    try {
      await processPayPalWebhookRow(deps, row);
      out.processed++;
    } catch (err) {
      out.failed++;
      deps.onError?.(err, { eventId: row.id, step: 'reprocess' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface CaptureSettlementRow {
  id: string;
  listing_id: string;
  status: string;
  paypal_id: string | null;
  paypal_status: string | null;
}

function base(deps: PayPalWebhookDeps, event: PayPalWebhookEvent, bid: BidRow) {
  const actor = deps.actor ?? WEBHOOK_ACTOR;
  return {
    actorType: actor.type,
    actorId: actor.id ?? null,
    listingId: bid.listing_id,
    eventData: { via: 'PAYPAL_WEBHOOK', eventId: event.id, eventType: event.event_type },
  };
}

async function lockListing(tx: Queryable, listingId: string): Promise<string> {
  const res = await tx.query(`SELECT status FROM listings WHERE id = $1 FOR UPDATE`, [listingId]);
  return (res.rows[0] as { status: string }).status;
}

async function captureSettlement(
  tx: Queryable,
  bidId: string,
): Promise<CaptureSettlementRow | null> {
  const res = await tx.query(
    `SELECT id, listing_id, status, paypal_id, paypal_status FROM settlements
      WHERE bid_id = $1 AND action = 'CAPTURE' FOR UPDATE`,
    [bidId],
  );
  return (res.rows[0] as CaptureSettlementRow | undefined) ?? null;
}

/**
 * `PAYMENT.CAPTURE.COMPLETED`: settlement `QUEUED|RUNNING|RETRY|FAILED → SUCCEEDED`, bid
 * WON → CAPTURED. Never promotes. A RUNNING row's worker loses its lease fence and writes nothing.
 * A capture PayPal completed after we recorded a failure also moves the failed bid to CAPTURED
 * (the shopper was charged) with an alert: the unit may be oversold.
 */
async function captureCompleted(
  deps: PayPalWebhookDeps,
  event: PayPalWebhookEvent,
): Promise<PayPalWebhookResult> {
  const bid = await findBidForEvent(deps.db.pool, event);
  if (!bid) return { outcome: 'UNMATCHED', eventType: event.event_type };
  const captureId = str(event.resource.id);
  const status = str(event.resource.status) ?? 'COMPLETED';
  const b = base(deps, event, bid);
  const res = await deps.db.tx(async (tx) => {
    await lockListing(tx, bid.listing_id);
    const s = await captureSettlement(tx, bid.id);
    const auditRow = (action: string, data: Json, settlementId: string | null = s?.id ?? null) =>
      audit(tx, {
        actorType: b.actorType,
        actorId: b.actorId,
        listingId: b.listingId,
        entity: settlementId ? 'settlement' : 'bid',
        entityId: settlementId ?? bid.id,
        action,
        paypalId: captureId,
        requestId: settlementId,
        data: { ...b.eventData, bidId: bid.id, ...data },
      });
    if (!s) {
      // Money taken on a bid we never settled: a human must look.
      await auditRow('CAPTURE_UNEXPECTED', { bidStatus: bid.status, alert: true }, null);
      return { outcome: 'FLAGGED' as const, captured: false, detail: 'NO_SETTLEMENT' };
    }
    if (s.status === 'SUCCEEDED') {
      // A PENDING capture (eCheck-like) is finalized here (features/11 §Edge cases).
      if (s.paypal_status !== status || !s.paypal_id) {
        await tx.query(
          `UPDATE settlements SET paypal_status = $2, paypal_id = coalesce(paypal_id, $3)
            WHERE id = $1 AND status = 'SUCCEEDED'`,
          [s.id, status, captureId],
        );
        await auditRow('CAPTURE_FINALIZED', { from: s.paypal_status, to: status });
        await emitSettlementUpdated(tx, s.listing_id, s.id);
      }
      return { outcome: 'ALREADY' as const, captured: false };
    }
    const wasFailed = s.status === 'FAILED';
    const moved = await transition(tx, 'settlements', s.id, OPEN_OR_FAILED, 'SUCCEEDED', {
      paypal_id: captureId,
      paypal_status: status,
      error_class: null,
      error_code: null,
      lease_until: null,
      next_attempt_at: null,
      finished_at: SQL_NOW,
    });
    if (!moved) return { outcome: 'ALREADY' as const, captured: false };
    const current = (
      await tx.query(`SELECT status, void_reason FROM bids WHERE id = $1 FOR UPDATE`, [bid.id])
    ).rows[0] as Pick<BidRow, 'status' | 'void_reason'>;
    const from =
      current.status === 'WON' ||
      current.status === 'CAPTURE_FAILED' ||
      (current.status === 'VOIDING' && current.void_reason === 'CAPTURE_FAILED')
        ? current.status
        : null;
    const capturedBid = from ? await transition(tx, 'bids', bid.id, from, 'CAPTURED') : null;
    await auditRow('CAPTURE_SUCCEEDED', {
      paypalStatus: status,
      reconciled: true,
      previousStatus: s.status,
      amountCents: bid.amount_cents,
      bidStatusMismatch: capturedBid ? undefined : current.status,
      // Charged after we recorded a failure (and maybe promoted): the unit may be oversold.
      alert: wasFailed || from !== 'WON' || undefined,
    });
    await emitSettlementUpdated(tx, s.listing_id, s.id);
    return { outcome: 'APPLIED' as const, captured: !!capturedBid };
  });
  if (res.captured && deps.onCaptured) {
    await deps
      .onCaptured(bid.id)
      .catch((err: unknown) => deps.onError?.(err, { eventId: event.id, step: 'onCaptured' }));
  }
  if (res.outcome === 'APPLIED') await kick(deps, event, bid.listing_id);
  return {
    outcome: res.outcome,
    eventType: event.event_type,
    bidId: bid.id,
    ...('detail' in res ? { detail: res.detail } : {}),
  };
}

/**
 * `PAYMENT.CAPTURE.DENIED` / `DECLINED`. Before SETTLED, on an open CAPTURE row: the terminal
 * failure path of `settleBid` (settlement → FAILED, conditional WON → CAPTURE_FAILED, then
 * `promoteWithin` in the same transaction, then void the authorization outside it). After
 * SETTLED, or on a SUCCEEDED row: audit + flag only.
 */
async function captureDenied(
  deps: PayPalWebhookDeps,
  event: PayPalWebhookEvent,
): Promise<PayPalWebhookResult> {
  const bid = await findBidForEvent(deps.db.pool, event);
  if (!bid) return { outcome: 'UNMATCHED', eventType: event.event_type };
  const captureId = str(event.resource.id);
  const code = str(event.resource.status) ?? 'DENIED';
  const b = base(deps, event, bid);
  const promote = deps.promoteWithin ?? defaultPromoteWithin;
  const res = await deps.db.tx(async (tx) => {
    const listingStatus = await lockListing(tx, bid.listing_id);
    const s = await captureSettlement(tx, bid.id);
    const auditRow = (action: string, data: Json) =>
      audit(tx, {
        actorType: b.actorType,
        actorId: b.actorId,
        listingId: b.listingId,
        entity: s ? 'settlement' : 'bid',
        entityId: s?.id ?? bid.id,
        action,
        paypalId: captureId,
        requestId: s?.id ?? null,
        data: { ...b.eventData, bidId: bid.id, ...data },
      });
    if (!s || s.status === 'SUCCEEDED' || listingStatus !== 'CLEARING') {
      await auditRow('CAPTURE_DENIED_FLAGGED', {
        code,
        listingStatus,
        settlementStatus: s?.status ?? null,
        bidStatus: bid.status,
        flag: 'CAPTURE_DENIED_AFTER_SUCCESS',
        alert: true,
      });
      return { outcome: 'FLAGGED' as const, failed: false, promoted: null };
    }
    if (!(OPEN as readonly string[]).includes(s.status)) {
      // FAILED / CANCELLED: settleBid's own failure path already ran (and promoted).
      return { outcome: 'ALREADY' as const, failed: false, promoted: null };
    }
    await transition(tx, 'settlements', s.id, OPEN, 'FAILED', {
      error_class: 'TERMINAL',
      error_code: `CAPTURE_${code}`,
      paypal_status: code,
      lease_until: null,
      next_attempt_at: null,
      finished_at: SQL_NOW,
    });
    const failed = await transition<'bids', BidRow>(tx, 'bids', bid.id, 'WON', 'CAPTURE_FAILED', {
      error_code: `CAPTURE_${code}`,
    });
    await auditRow('CAPTURE_FAILED', {
      errorClass: 'TERMINAL',
      code: `CAPTURE_${code}`,
      bidMoved: !!failed,
      alert: !failed || undefined,
    });
    const promoted = failed ? await promote(tx, bid.id) : null;
    await emitSettlementUpdated(tx, s.listing_id, s.id);
    if (promoted?.settlementId) {
      await emitSettlementUpdated(tx, s.listing_id, promoted.settlementId);
    }
    return { outcome: 'APPLIED' as const, failed: !!failed, promoted };
  });
  if (res.failed) {
    const moneyDeps: MoneyDeps = {
      db: deps.db,
      paypal: deps.paypal,
      audit: auditHook,
      voidBackoffMs: deps.voidBackoffMs ?? DEFAULT_VOID_BACKOFF_MS,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    };
    // Left VOIDING on persistent failure: the sweeper (HF-034) finishes it.
    await voidBid(moneyDeps, bid.id, 'CAPTURE_FAILED', deps.actor ?? WEBHOOK_ACTOR, {
      from: ['CAPTURE_FAILED'],
    }).catch((err: unknown) => deps.onError?.(err, { eventId: event.id, step: 'void' }));
  }
  if (res.outcome === 'APPLIED') await kick(deps, event, bid.listing_id);
  return {
    outcome: res.outcome,
    eventType: event.event_type,
    bidId: bid.id,
    promotedBidId: res.promoted?.promotedBidId ?? null,
  };
}

/** Bid statuses whose hold we were releasing anyway: the event confirms it. */
const RELEASING = ['VOIDING', 'LOST', 'CAPTURE_FAILED'] as const;

/**
 * `PAYMENT.AUTHORIZATION.VOIDED`: confirm VOIDED for a bid we were releasing (VOIDING, LOST,
 * CAPTURE_FAILED); a HELD bid we didn't void → VOIDED (`void_reason=EXPIRED`), which removes it
 * from the book (`bid.voided`). A winner (WON / CAPTURED) is never touched: its capture outcome
 * decides (a capture on a voided authorization fails TERMINAL and promotes in `settleBid`).
 */
async function authorizationVoided(
  deps: PayPalWebhookDeps,
  event: PayPalWebhookEvent,
): Promise<PayPalWebhookResult> {
  const bid = await findBidForEvent(deps.db.pool, event);
  if (!bid) return { outcome: 'UNMATCHED', eventType: event.event_type };
  const b = base(deps, event, bid);
  const outcome = await deps.db.tx(async (tx) => {
    await lockListing(tx, bid.listing_id);
    const current = (await tx.query(`SELECT * FROM bids WHERE id = $1 FOR UPDATE`, [bid.id]))
      .rows[0] as BidRow;
    const auditRow = (action: string, data: Json) =>
      audit(tx, {
        actorType: b.actorType,
        actorId: b.actorId,
        listingId: b.listingId,
        entity: 'bid',
        entityId: bid.id,
        action,
        paypalId: current.paypal_authorization_id,
        requestId: voidKey(bid.id),
        data: { ...b.eventData, ...data },
      });
    if (current.status === 'VOIDED') return 'ALREADY' as const;
    let moved: BidRow | null = null;
    if (current.status === 'HELD') {
      moved = await transition<'bids', BidRow>(tx, 'bids', bid.id, 'HELD', 'VOIDED', {
        void_reason: 'EXPIRED',
        voided_at: SQL_NOW,
      });
    } else if ((RELEASING as readonly string[]).includes(current.status)) {
      moved = await transition<'bids', BidRow>(tx, 'bids', bid.id, RELEASING, 'VOIDED', {
        void_reason: current.void_reason ?? (current.status === 'LOST' ? 'LOST' : 'CAPTURE_FAILED'),
        void_request_id: current.void_request_id ?? voidKey(bid.id),
        voided_at: SQL_NOW,
      });
    }
    if (!moved) {
      await auditRow('AUTHORIZATION_VOIDED_FLAGGED', {
        bidStatus: current.status,
        alert: current.status === 'WON' || current.status === 'CAPTURED' || undefined,
      });
      return 'FLAGGED' as const;
    }
    await emitVoided(tx, moved);
    await auditRow('BID_VOIDED', {
      from: current.status,
      reason: moved.void_reason,
      unexpected: current.status === 'HELD' || undefined,
    });
    return 'APPLIED' as const;
  });
  return { outcome, eventType: event.event_type, bidId: bid.id };
}

/**
 * `PAYMENT.PAYOUTSBATCH.SUCCESS` / `DENIED`: resolve the attempt `sender_batch_id` names (incl.
 * PENDING_UNKNOWN) through HF-032's `applyPayoutBatch`. The batch event carries no item, and the
 * item decides (SUCCESS vs UNCLAIMED), so a batch that doesn't already resolve is read with
 * `GET /v1/payments/payouts/{batch_id}`.
 */
async function payoutBatch(
  deps: PayPalWebhookDeps,
  event: PayPalWebhookEvent,
): Promise<PayPalWebhookResult> {
  const header = obj(event.resource.batch_header);
  const senderBatchId = str(obj(header.sender_batch_header).sender_batch_id);
  const batchId = str(header.payout_batch_id);
  const payout = senderBatchId
    ? await findPayoutBySenderBatchId(deps.db.pool, senderBatchId)
    : null;
  if (!payout || !batchId) return { outcome: 'UNMATCHED', eventType: event.event_type };
  let view: PayoutBatchView = {
    batchId,
    senderBatchId,
    batchStatus: str(header.batch_status) ?? 'UNKNOWN',
    amountCents: null,
    feesCents: null,
    items: Array.isArray(event.resource.items) ? event.resource.items.map(readItem) : [],
  };
  if (resolveBatch(view).kind === 'PENDING') view = await deps.paypal.getPayoutBatch(batchId);
  const r = await applyPayoutBatch(
    { db: deps.db, actor: deps.actor ?? WEBHOOK_ACTOR },
    payout.id,
    view,
  );
  return {
    // PENDING: PayPal's item is not final yet; the payout poll (HF-034) keeps reading it.
    outcome: r.resolved === 'SUCCESS' || r.resolved === 'FAILED' ? 'APPLIED' : 'ALREADY',
    eventType: event.event_type,
    payoutId: payout.id,
    detail: r.resolved,
  };
}

function readItem(raw: unknown): PayoutItemView {
  const i = obj(raw);
  const status = str(i.transaction_status) ?? 'UNKNOWN';
  return {
    itemId: str(i.payout_item_id) ?? '',
    batchId: str(i.payout_batch_id),
    transactionStatus: status,
    outcome: payoutItemOutcome(status),
    errorName: str(obj(i.errors).name),
    amountCents: null,
    feeCents: null,
  };
}

async function kick(deps: PayPalWebhookDeps, event: PayPalWebhookEvent, listingId: string) {
  if (!deps.kickSettlement) return;
  try {
    const run = (
      await deps.db.pool.query(
        `SELECT id FROM settlement_runs WHERE listing_id = $1 AND status <> 'DONE'`,
        [listingId],
      )
    ).rows[0] as { id: string } | undefined;
    if (run) await deps.kickSettlement({ runId: run.id, listingId });
  } catch (err) {
    deps.onError?.(err, { eventId: event.id, step: 'kick' });
  }
}
