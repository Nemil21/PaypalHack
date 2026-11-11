import {
  centsToDecimal,
  feeCents,
  type ListingStatus,
  type PayoutStatus,
  type PayoutView,
} from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Db, Queryable } from '../db.js';
import type { Actor } from '../money/deps.js';
import { emit } from '../money/emit.js';
import { SQL_NOW, transition } from '../money/transition.js';
import { payoutRequestId, type PayoutRequestId } from '../paypal/ids.js';
import type { PayoutBatchView, PayoutResult, PayPalClient } from '../paypal/types.js';

/**
 * HF-032 `payoutBrand(listingId)` (features/12 §Money math, §Logic 1–2; data-model §payouts):
 * pay the brand once, net of the platform fee, from the money actually captured.
 *
 * - **Gross** = sum of COMPLETED real captures (`settlements` CAPTURE SUCCEEDED with
 *   `paypal_status = 'COMPLETED'`, not a simulated shopper or a `SIM` bid). PENDING captures and
 *   simulated money are never paid out (B7, D8). Fee = the shared `feeCents` (HF-022), net =
 *   gross − fee. Gross 0 → no payout; the listing stays SETTLED with "nothing to pay".
 * - **Attempts** (D5, M4): a `payouts` row per attempt, at most one live (`status <> 'FAILED'`) per
 *   listing. `sender_batch_id` = `PayPal-Request-Id` = `<payout.id>:<attempt>`.
 * - **Ambiguous** (timeout, no answer, 5xx, duplicate-batch error) → `PENDING_UNKNOWN`. The poll
 *   re-POSTs the **same** id, which PayPal replays to the original batch. A new attempt is minted
 *   only once PayPal confirmed the old one failed (item DENIED / FAILED / UNCLAIMED, or
 *   `INSUFFICIENT_FUNDS` at POST, where S7 showed no batch is created).
 * - **Poll** (`pollPayouts`, run by the HF-034 minute cron, never an in-process timer): GET the
 *   batch and read the **item** status. SUCCESS → listing PAID_OUT; failed → PAYOUT_FAILED.
 * - **Admin retry** (`retryPayout`) for PAYOUT_FAILED mints attempt + 1; its success moves the
 *   listing PAYOUT_FAILED → PAID_OUT.
 *
 * Every state change is a conditional `transition()` under the listing lock (lock order: listing,
 * then payout), so a poll racing a webhook or another poll resolves a payout once. PayPal calls
 * are never made inside a transaction.
 */

/** PENDING payouts younger than this are polled (features/12, A-money review). */
export const PAYOUT_POLL_WINDOW_MS = 30 * 60_000;
/** An unsent or ambiguous attempt is re-POSTed once it has been quiet this long. */
export const PAYOUT_RESEND_AFTER_SECONDS = 60;
/** Wait between automatic retries after `INSUFFICIENT_FUNDS` (S7: retry later + alert). */
export const PAYOUT_FUNDS_RETRY_AFTER_SECONDS = 5 * 60;
/** After this many `INSUFFICIENT_FUNDS` attempts the listing goes PAYOUT_FAILED (admin retry). */
export const PAYOUT_MAX_FUNDS_ATTEMPTS = 6;

/** Reasons the brand and the console see (`PayoutView.failureReason`). */
const FAILURE_REASONS: Record<string, string> = {
  UNCLAIMED: 'brand payout email is not a PayPal account',
  INSUFFICIENT_FUNDS: 'PayPal balance too low for the payout; retrying',
  SELF_PAY_NOT_ALLOWED: 'payout email is the merchant account itself',
  DUPLICATE_BATCH: 'PayPal already has this batch; waiting for its status',
};

export function payoutFailureReason(code: string | null): string | null {
  if (!code) return null;
  return FAILURE_REASONS[code] ?? code;
}

export type PayoutDeps = {
  db: Db;
  paypal: Pick<PayPalClient, 'payout' | 'getPayoutBatch'>;
  actor?: Actor;
  onError?: (err: unknown, ctx: { payoutId?: string; listingId?: string; step: string }) => void;
};

export interface PayoutRow {
  id: string;
  listing_id: string;
  brand_id: string | null;
  attempt: number;
  status: PayoutStatus;
  gross_cents: number | null;
  gross_real_cents: number | null;
  gross_simulated_cents: number | null;
  fee_cents: number | null;
  net_cents: number | null;
  payout_email: string | null;
  paypal_batch_id: string | null;
  paypal_batch_status: string | null;
  paypal_item_id: string | null;
  item_status: string | null;
  error_code: string | null;
  sent_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const WORKFLOW: Actor = { type: 'WORKFLOW' };
const LIVE: PayoutStatus[] = ['PENDING', 'PENDING_UNKNOWN'];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** `sender_batch_id` = `PayPal-Request-Id` = `<payout.id>:<attempt>` (D5). */
export function senderBatchId(payoutId: string, attempt: number): PayoutRequestId {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be >= 1');
  return payoutRequestId(`${payoutId}:${attempt}`);
}

/** Inverse of `senderBatchId`, for the HF-033 `PAYMENT.PAYOUTSBATCH.*` webhook. */
export function parseSenderBatchId(id: string): { payoutId: string; attempt: number } | null {
  const m = /^([0-9a-f-]{36}):(\d+)$/i.exec(id);
  return m ? { payoutId: m[1]!.toLowerCase(), attempt: Number(m[2]) } : null;
}

export interface PayoutAmounts {
  grossCents: number;
  feeCents: number;
  netCents: number;
}

/** Fee and net from the real gross, with the shared rounding (round half up, HF-022). */
export function payoutAmounts(grossRealCents: number, feeBps: number): PayoutAmounts {
  const fee = feeCents(grossRealCents, feeBps);
  return { grossCents: grossRealCents, feeCents: fee, netCents: grossRealCents - fee };
}

/**
 * The note on the payout (D14, Q#3): units and the average, never a single price.
 * "Holdfast: Aurel A7, 240 units cleared, average $226.00".
 */
export function payoutNote(productTitle: string, units: number, grossCents: number): string {
  const title = productTitle.trim().slice(0, 120) || 'listing';
  const avg = units > 0 ? Math.round(grossCents / units) : 0;
  return `Holdfast: ${title}, ${units} ${units === 1 ? 'unit' : 'units'} cleared, average $${centsToDecimal(avg)}`;
}

/** What a POST answer means for the attempt. */
export type PostOutcome =
  | { kind: 'SENT'; batchId: string; batchStatus: string }
  /** No answer, 5xx, malformed 2xx, duplicate batch: PayPal may have the batch. Same id again. */
  | { kind: 'UNKNOWN'; code: string }
  /** `INSUFFICIENT_FUNDS` at POST: no batch was created (S7). New attempt later + alert. */
  | { kind: 'FUNDS'; code: string }
  /** PayPal refused it outright (validation, receiver): PAYOUT_FAILED. */
  | { kind: 'REFUSED'; code: string };

/**
 * PayPal's duplicate-batch answers: a reused `sender_batch_id` ("Batch with given sender_batch_id
 * already exists") or a reused `PayPal-Request-Id` with another body. Either means a batch may
 * exist under our id, so it is ambiguous, never a failure.
 */
export function isDuplicateBatch(code: string): boolean {
  return (
    /DUPLICATE_REQUEST_ID|SENDER_BATCH_ID_ALREADY_EXISTS/i.test(code) ||
    /sender_batch_id.*already exists/i.test(code)
  );
}

export function classifyPayoutPost(res: PayoutResult): PostOutcome {
  if (res.ok) return { kind: 'SENT', batchId: res.batchId, batchStatus: res.batchStatus };
  if (isDuplicateBatch(res.code)) return { kind: 'UNKNOWN', code: 'DUPLICATE_BATCH' };
  if (res.retryWithNewAttempt) return { kind: 'FUNDS', code: res.code };
  if (res.errorClass === 'TRANSIENT' || res.errorClass === 'RECONCILE') {
    return { kind: 'UNKNOWN', code: res.code };
  }
  return { kind: 'REFUSED', code: res.code };
}

export type BatchResolution =
  | { kind: 'SUCCESS'; itemId: string | null; itemStatus: string }
  | { kind: 'FAILED'; itemId: string | null; itemStatus: string | null; code: string }
  | { kind: 'PENDING'; itemId: string | null; itemStatus: string | null };

const BATCH_FAILED = new Set(['DENIED', 'FAILED', 'CANCELED', 'CANCELLED']);

/**
 * Status mapping (features/12 §Logic 2): the **item** decides. SUCCESS → PAID_OUT; FAILED, DENIED,
 * RETURNED, BLOCKED, … and `UNCLAIMED` (the receiver has no PayPal account) → PAYOUT_FAILED.
 * A batch DENIED with no item is a failure too. Anything else is still pending.
 */
export function resolveBatch(view: PayoutBatchView): BatchResolution {
  const item = view.items[0];
  if (item) {
    const itemId = item.itemId || null;
    if (item.outcome === 'SUCCESS') {
      return { kind: 'SUCCESS', itemId, itemStatus: item.transactionStatus };
    }
    if (item.outcome === 'FAILED') {
      const code =
        item.transactionStatus === 'UNCLAIMED'
          ? 'UNCLAIMED'
          : (item.errorName ?? item.transactionStatus);
      return { kind: 'FAILED', itemId, itemStatus: item.transactionStatus, code };
    }
    if (!BATCH_FAILED.has(view.batchStatus)) {
      return { kind: 'PENDING', itemId, itemStatus: item.transactionStatus };
    }
    return {
      kind: 'FAILED',
      itemId,
      itemStatus: item.transactionStatus,
      code: `BATCH_${view.batchStatus}`,
    };
  }
  if (BATCH_FAILED.has(view.batchStatus)) {
    return { kind: 'FAILED', itemId: null, itemStatus: null, code: `BATCH_${view.batchStatus}` };
  }
  return { kind: 'PENDING', itemId: null, itemStatus: null };
}

export function toPayoutView(p: PayoutRow): PayoutView {
  return {
    payoutId: p.id,
    attempt: p.attempt,
    status: p.status,
    grossCents: p.gross_cents ?? 0,
    feeCents: p.fee_cents ?? 0,
    netCents: p.net_cents ?? 0,
    paypalBatchId: p.paypal_batch_id,
    itemStatus: p.item_status,
    failureReason: payoutFailureReason(p.error_code),
    createdAt: p.created_at.toISOString(),
    completedAt: p.completed_at?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface PayoutTotals {
  /** COMPLETED real captures: what the payout is computed from. */
  grossRealCents: number;
  /** SUCCEEDED captures of simulated shoppers / SIM bids: shown, never paid. */
  grossSimulatedCents: number;
  /** Units behind `grossRealCents`. */
  units: number;
}

export async function payoutTotals(q: Queryable, listingId: string): Promise<PayoutTotals> {
  const r = (
    await q.query(
      `WITH c AS (
         SELECT s.amount_cents, s.paypal_status,
                (coalesce(sh.is_simulated, false) OR b.source = 'SIM') IS TRUE AS sim
           FROM settlements s
           JOIN bids b ON b.id = s.bid_id
           LEFT JOIN shoppers sh ON sh.id = b.shopper_id
          WHERE s.listing_id = $1 AND s.action = 'CAPTURE' AND s.status = 'SUCCEEDED')
       SELECT coalesce(sum(amount_cents) FILTER (WHERE NOT sim AND paypal_status = 'COMPLETED'), 0)::bigint
                AS gross_real,
              count(*) FILTER (WHERE NOT sim AND paypal_status = 'COMPLETED')::int AS units,
              coalesce(sum(amount_cents) FILTER (WHERE sim), 0)::bigint AS gross_sim
         FROM c`,
      [listingId],
    )
  ).rows[0] as { gross_real: string; units: number; gross_sim: string };
  return {
    grossRealCents: Number(r.gross_real),
    grossSimulatedCents: Number(r.gross_sim),
    units: r.units,
  };
}

interface ListingForPayout {
  id: string;
  status: ListingStatus;
  brand_id: string;
  payout_email: string;
  fee_bps: number;
  title: string;
}

/** The listing, locked `FOR UPDATE` (lock order: listing before its payouts). */
async function lockListing(q: Queryable, listingId: string): Promise<ListingForPayout | null> {
  const row = (
    await q.query(
      `SELECT l.id, l.status, l.brand_id,
              -- The snapshot taken at Clear (features/12 edge case); the brand's email only if a
              -- listing predates the snapshot column being filled.
              coalesce(l.payout_email_snapshot, br.payout_email) AS payout_email,
              br.fee_bps, coalesce(p.title, '') AS title
         FROM listings l
         JOIN brands br ON br.id = l.brand_id
         LEFT JOIN products p ON p.id = l.product_id
        WHERE l.id = $1
          FOR UPDATE OF l`,
      [listingId],
    )
  ).rows[0] as ListingForPayout | undefined;
  return row ?? null;
}

async function latestPayout(q: Queryable, listingId: string): Promise<PayoutRow | null> {
  return (
    ((
      await q.query(`SELECT * FROM payouts WHERE listing_id = $1 ORDER BY attempt DESC LIMIT 1`, [
        listingId,
      ])
    ).rows[0] as PayoutRow | undefined) ?? null
  );
}

export async function loadPayout(q: Queryable, payoutId: string): Promise<PayoutRow | null> {
  return (
    ((await q.query(`SELECT * FROM payouts WHERE id = $1`, [payoutId])).rows[0] as
      PayoutRow | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function emitPayout(tx: Queryable, p: PayoutRow): Promise<void> {
  await emit(tx, p.listing_id, {
    type: 'payout.updated',
    listingId: p.listing_id,
    at: new Date().toISOString(),
    payout: toPayoutView(p),
  });
}

/**
 * Insert attempt `attempt` for a locked listing, computed from the captures as they are now.
 * Null when there is nothing to pay or a live attempt already exists.
 */
async function mintAttempt(
  tx: Queryable,
  listing: ListingForPayout,
  attempt: number,
  actor: Actor,
): Promise<PayoutRow | 'NOTHING_TO_PAY' | null> {
  const totals = await payoutTotals(tx, listing.id);
  const amounts = payoutAmounts(totals.grossRealCents, listing.fee_bps);
  if (amounts.netCents <= 0) return 'NOTHING_TO_PAY';
  const row = (
    await tx.query(
      `INSERT INTO payouts (listing_id, brand_id, attempt, status, gross_cents, gross_real_cents,
                            gross_simulated_cents, fee_cents, net_cents, payout_email)
       VALUES ($1, $2, $3, 'PENDING', $4, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        listing.id,
        listing.brand_id,
        attempt,
        totals.grossRealCents,
        totals.grossSimulatedCents,
        amounts.feeCents,
        amounts.netCents,
        listing.payout_email,
      ],
    )
  ).rows[0] as PayoutRow | undefined;
  if (!row) return null;
  await audit(tx, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    listingId: listing.id,
    entity: 'payout',
    entityId: row.id,
    action: 'PAYOUT_CREATED',
    requestId: senderBatchId(row.id, row.attempt),
    data: {
      attempt,
      grossCents: amounts.grossCents,
      grossSimulatedCents: totals.grossSimulatedCents,
      feeCents: amounts.feeCents,
      netCents: amounts.netCents,
      feeBps: listing.fee_bps,
      units: totals.units,
    },
  });
  await emitPayout(tx, row);
  return row;
}

export type PayoutBrandResult =
  /** The listing isn't SETTLED (not settled yet, or already past the payout). */
  | { outcome: 'NOT_SETTLED'; status: ListingStatus | null }
  /** Gross of COMPLETED real captures is 0: the listing stays SETTLED, nothing to pay. */
  | { outcome: 'NOTHING_TO_PAY' }
  /** A payout already exists for this listing (a re-run): nothing new was created. */
  | { outcome: 'EXISTS'; payout: PayoutRow }
  /** A new attempt was created and POSTed; `payout.status` says how that went. */
  | { outcome: 'CREATED'; payout: PayoutRow; post: PostOutcome['kind'] };

/**
 * Called by the winner of `CLEARING → SETTLED` (HF-030a), and again only after a crash. Re-running
 * it never creates a second payout: an existing attempt (live or failed) is returned as is; new
 * attempts come from `retryPayout` (admin) or the poll's `INSUFFICIENT_FUNDS` retry.
 */
export async function payoutBrand(deps: PayoutDeps, listingId: string): Promise<PayoutBrandResult> {
  const actor = deps.actor ?? WORKFLOW;
  const created = await deps.db.tx(async (tx): Promise<PayoutBrandResult> => {
    const listing = await lockListing(tx, listingId);
    if (!listing) return { outcome: 'NOT_SETTLED', status: null };
    const existing = await latestPayout(tx, listingId);
    if (existing) return { outcome: 'EXISTS', payout: existing };
    if (listing.status !== 'SETTLED') return { outcome: 'NOT_SETTLED', status: listing.status };
    const row = await mintAttempt(tx, listing, 1, actor);
    if (row === 'NOTHING_TO_PAY') {
      await auditOnce(tx, listingId, 'PAYOUT_NOTHING_TO_PAY', {
        reason: 'No completed real captures: nothing to pay.',
      });
      return { outcome: 'NOTHING_TO_PAY' };
    }
    if (!row) {
      const live = await latestPayout(tx, listingId);
      if (live) return { outcome: 'EXISTS', payout: live };
      throw new Error(`payoutBrand: could not create a payout for ${listingId}`);
    }
    return { outcome: 'CREATED', payout: row, post: 'SENT' };
  });
  if (created.outcome !== 'CREATED') return created;
  const sent = await sendAttempt(deps, created.payout.id);
  return { outcome: 'CREATED', payout: sent.payout, post: sent.post };
}

/** `PayoutBrand` for the settlement coordinator (`SettleListingDeps.payoutBrand`). */
export function makePayoutBrand(
  deps: PayoutDeps,
): (listingId: string) => Promise<PayoutBrandResult> {
  return (listingId) => payoutBrand(deps, listingId);
}

async function auditOnce(
  q: Queryable,
  listingId: string,
  action: string,
  data: Record<string, unknown>,
  entityId: string = listingId,
): Promise<void> {
  const prior = await q.query(
    `SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = $2 AND entity_id = $3 LIMIT 1`,
    [listingId, action, entityId],
  );
  if (prior.rowCount) return;
  await audit(q, {
    actorType: 'WORKFLOW',
    listingId,
    entity: entityId === listingId ? 'listing' : 'payout',
    entityId,
    action,
    data,
  });
}

/**
 * POST the attempt (`PayPal-Request-Id` = `sender_batch_id` = `<id>:<attempt>`) and record what
 * PayPal said. Safe to repeat for an attempt that has no batch id yet: PayPal replays the same id.
 */
export async function sendAttempt(
  deps: PayoutDeps,
  payoutId: string,
): Promise<{ payout: PayoutRow; post: PostOutcome['kind'] }> {
  const ctx = (
    await deps.db.pool.query(
      `SELECT p.*, coalesce(pr.title, '') AS title
         FROM payouts p
         JOIN listings l ON l.id = p.listing_id
         LEFT JOIN products pr ON pr.id = l.product_id
        WHERE p.id = $1`,
      [payoutId],
    )
  ).rows[0] as (PayoutRow & { title: string }) | undefined;
  if (!ctx) throw new Error(`payout ${payoutId} not found`);
  if (!LIVE.includes(ctx.status) || ctx.paypal_batch_id) {
    return { payout: ctx, post: 'SENT' };
  }
  if (!ctx.payout_email || !ctx.net_cents) throw new Error(`payout ${payoutId} has no email/net`);
  const totals = await payoutTotals(deps.db.pool, ctx.listing_id);
  const requestId = senderBatchId(ctx.id, ctx.attempt);
  let res: PayoutResult;
  try {
    res = await deps.paypal.payout({
      attemptId: requestId,
      email: ctx.payout_email,
      amountCents: ctx.net_cents,
      note: payoutNote(ctx.title, totals.units, ctx.gross_cents ?? totals.grossRealCents),
      emailSubject: 'Your Holdfast payout',
    });
  } catch (err) {
    // The client never throws for a timeout; anything else (credentials) is not an answer about
    // this batch either: leave it ambiguous so the poll asks again with the same id.
    deps.onError?.(err, { payoutId, listingId: ctx.listing_id, step: 'payout' });
    res = {
      ok: false,
      errorClass: 'TRANSIENT',
      code: err instanceof Error ? err.message.slice(0, 120) : 'ERROR',
      http: 0,
      retryWithNewAttempt: false,
      alert: true,
    };
  }
  const post = classifyPayoutPost(res);
  const actor = deps.actor ?? WORKFLOW;
  const payout = await deps.db.tx(async (tx) => {
    await lockListing(tx, ctx.listing_id);
    const now = await loadPayout(tx, payoutId);
    // Someone resolved it meanwhile (another poll, the webhook): keep their answer.
    if (!now || !LIVE.includes(now.status) || now.paypal_batch_id) return now ?? ctx;
    const base = {
      actorType: actor.type,
      actorId: actor.id ?? null,
      listingId: ctx.listing_id,
      entity: 'payout',
      entityId: payoutId,
      requestId,
    };
    let row: PayoutRow | null;
    switch (post.kind) {
      case 'SENT':
        row = await transition<'payouts', PayoutRow>(tx, 'payouts', payoutId, LIVE, 'PENDING', {
          paypal_batch_id: post.batchId,
          paypal_batch_status: post.batchStatus,
          error_code: null,
          sent_at: SQL_NOW,
        });
        if (row) {
          await audit(tx, {
            ...base,
            action: 'PAYOUT_REQUESTED',
            paypalId: post.batchId,
            data: {
              attempt: row.attempt,
              netCents: row.net_cents,
              batchStatus: post.batchStatus,
              replayed: res.ok && now.status === 'PENDING_UNKNOWN',
            },
          });
        }
        break;
      case 'UNKNOWN':
        row = await transition<'payouts', PayoutRow>(
          tx,
          'payouts',
          payoutId,
          LIVE,
          'PENDING_UNKNOWN',
          { error_code: post.code },
        );
        if (row) {
          await audit(tx, {
            ...base,
            action: 'PAYOUT_PENDING_UNKNOWN',
            data: { attempt: row.attempt, code: post.code, alert: post.code === 'DUPLICATE_BATCH' },
          });
        }
        break;
      case 'FUNDS':
      case 'REFUSED': {
        row = await transition<'payouts', PayoutRow>(tx, 'payouts', payoutId, LIVE, 'FAILED', {
          error_code: post.code,
          completed_at: SQL_NOW,
        });
        if (!row) break;
        // INSUFFICIENT_FUNDS: no batch was created; the poll retries with a new attempt and the
        // listing stays SETTLED until the attempts run out (S7, M4).
        const givesUp = post.kind === 'REFUSED' || row.attempt >= PAYOUT_MAX_FUNDS_ATTEMPTS;
        const moved = givesUp ? await failListing(tx, ctx.listing_id) : false;
        await audit(tx, {
          ...base,
          action: post.kind === 'FUNDS' && !givesUp ? 'PAYOUT_FUNDS_SHORT' : 'PAYOUT_FAILED',
          data: {
            attempt: row.attempt,
            code: post.code,
            reason: payoutFailureReason(post.code),
            netCents: row.net_cents,
            listingMoved: moved,
            alert: true,
          },
        });
        break;
      }
    }
    if (row) await emitPayout(tx, row);
    return row ?? now;
  });
  return { payout, post: post.kind };
}

/** SETTLED → PAYOUT_FAILED (a retry's failure leaves PAYOUT_FAILED as it is). */
async function failListing(tx: Queryable, listingId: string): Promise<boolean> {
  const moved = await transition(tx, 'listings', listingId, 'SETTLED', 'PAYOUT_FAILED');
  if (!moved) return false;
  await emit(tx, listingId, {
    type: 'listing.status',
    listingId,
    at: new Date().toISOString(),
    from: 'SETTLED',
    to: 'PAYOUT_FAILED',
  });
  return true;
}

/**
 * Apply a batch status read from PayPal (the poll's GET, or the HF-033 webhook's resource) to one
 * attempt. Resolves it at most once: the conditional transition loses to whoever got there first.
 */
export async function applyPayoutBatch(
  deps: Pick<PayoutDeps, 'db' | 'actor'>,
  payoutId: string,
  view: PayoutBatchView,
): Promise<{ resolved: BatchResolution['kind'] | 'ALREADY'; payout: PayoutRow | null }> {
  const r = resolveBatch(view);
  const actor = deps.actor ?? WORKFLOW;
  return deps.db.tx(async (tx) => {
    const head = (await tx.query(`SELECT listing_id FROM payouts WHERE id = $1`, [payoutId]))
      .rows[0] as { listing_id: string } | undefined;
    if (!head) return { resolved: 'ALREADY' as const, payout: null };
    await lockListing(tx, head.listing_id);
    const now = await loadPayout(tx, payoutId);
    if (!now || !LIVE.includes(now.status)) return { resolved: 'ALREADY' as const, payout: now };
    const fields = {
      paypal_batch_id: now.paypal_batch_id ?? view.batchId,
      paypal_batch_status: view.batchStatus,
      paypal_item_id: r.itemId ?? now.paypal_item_id,
      item_status: r.itemStatus ?? now.item_status,
    };
    const base = {
      actorType: actor.type,
      actorId: actor.id ?? null,
      listingId: now.listing_id,
      entity: 'payout',
      entityId: payoutId,
      paypalId: fields.paypal_batch_id,
      requestId: senderBatchId(now.id, now.attempt),
    };
    if (r.kind === 'PENDING') {
      const changed =
        fields.paypal_batch_status !== now.paypal_batch_status ||
        fields.item_status !== now.item_status ||
        fields.paypal_batch_id !== now.paypal_batch_id;
      if (!changed) return { resolved: 'PENDING' as const, payout: now };
      // A PENDING_UNKNOWN attempt PayPal turns out to have: it is simply PENDING now.
      const row = await transition<'payouts', PayoutRow>(tx, 'payouts', payoutId, LIVE, 'PENDING', {
        ...fields,
        error_code: null,
      });
      if (row) await emitPayout(tx, row);
      return { resolved: 'PENDING' as const, payout: row ?? now };
    }
    if (r.kind === 'SUCCESS') {
      const row = await transition<'payouts', PayoutRow>(tx, 'payouts', payoutId, LIVE, 'SUCCESS', {
        ...fields,
        error_code: null,
        completed_at: SQL_NOW,
      });
      if (!row) return { resolved: 'ALREADY' as const, payout: now };
      const listing = (
        await tx.query(`SELECT status FROM listings WHERE id = $1`, [now.listing_id])
      ).rows[0] as { status: ListingStatus };
      const moved = await transition(
        tx,
        'listings',
        now.listing_id,
        ['SETTLED', 'PAYOUT_FAILED'],
        'PAID_OUT',
      );
      await audit(tx, {
        ...base,
        action: 'PAYOUT_SUCCEEDED',
        data: {
          attempt: row.attempt,
          netCents: row.net_cents,
          itemStatus: r.itemStatus,
          itemId: r.itemId,
        },
      });
      await emitPayout(tx, row);
      if (moved) {
        await emit(tx, now.listing_id, {
          type: 'listing.status',
          listingId: now.listing_id,
          at: new Date().toISOString(),
          from: listing.status,
          to: 'PAID_OUT',
        });
      }
      return { resolved: 'SUCCESS' as const, payout: row };
    }
    const row = await transition<'payouts', PayoutRow>(tx, 'payouts', payoutId, LIVE, 'FAILED', {
      ...fields,
      error_code: r.code,
      completed_at: SQL_NOW,
    });
    if (!row) return { resolved: 'ALREADY' as const, payout: now };
    const moved = await failListing(tx, now.listing_id);
    await audit(tx, {
      ...base,
      action: 'PAYOUT_FAILED',
      data: {
        attempt: row.attempt,
        code: r.code,
        reason: payoutFailureReason(r.code),
        itemStatus: r.itemStatus,
        listingMoved: moved,
        alert: true,
      },
    });
    await emitPayout(tx, row);
    return { resolved: 'FAILED' as const, payout: row };
  });
}

// ---------------------------------------------------------------------------
// Poll (HF-034 minute cron)
// ---------------------------------------------------------------------------

export interface PollPayoutsOptions {
  /** Default 30 min. */
  windowMs?: number;
  /** Default 60 s. Tests pass 0. */
  resendAfterSeconds?: number;
  /** Default 5 min. Tests pass 0. */
  fundsRetryAfterSeconds?: number;
  /** Max payouts handled per pass. Default 50. */
  limit?: number;
}

export interface PollPayoutsResult {
  /** Attempts POSTed again with the same id (unsent or PENDING_UNKNOWN). */
  resent: number;
  /** Batches read. */
  polled: number;
  succeeded: number;
  failed: number;
  /** New attempts after INSUFFICIENT_FUNDS. */
  retried: number;
  /** Live attempts older than the window (alerted once; the webhook or an admin resolves them). */
  stale: number;
}

/**
 * One pass of the payout poll. Run it from the HF-034 minute cron (never an in-process timer, so
 * a deploy can't lose it). Safe to run concurrently: resends are claimed by a conditional update
 * and resolutions are conditional transitions.
 *
 * 1. Live attempts with no batch id (a crash after POST, a timeout, a duplicate-batch answer),
 *    quiet for `resendAfterSeconds`: mark PENDING_UNKNOWN and re-POST the **same** id.
 * 2. Live attempts with a batch id: GET the batch, apply the item status.
 * 3. `INSUFFICIENT_FUNDS` attempts on a SETTLED listing: mint attempt + 1 and send it.
 * 4. Live attempts older than the window: one `PAYOUT_STUCK` alert each.
 */
export async function pollPayouts(
  deps: PayoutDeps,
  opts: PollPayoutsOptions = {},
): Promise<PollPayoutsResult> {
  const pool = deps.db.pool;
  const windowSec = Math.round((opts.windowMs ?? PAYOUT_POLL_WINDOW_MS) / 1000);
  const resendAfter = opts.resendAfterSeconds ?? PAYOUT_RESEND_AFTER_SECONDS;
  const fundsAfter = opts.fundsRetryAfterSeconds ?? PAYOUT_FUNDS_RETRY_AFTER_SECONDS;
  const limit = opts.limit ?? 50;
  const out: PollPayoutsResult = {
    resent: 0,
    polled: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    stale: 0,
  };
  const guard = async (
    payoutId: string,
    listingId: string,
    step: string,
    fn: () => Promise<void>,
  ) => {
    try {
      await fn();
    } catch (err) {
      deps.onError?.(err, { payoutId, listingId, step });
    }
  };

  // 1. Unsent / ambiguous: claim (bumps updated_at, so an overlapping poll skips it) and re-POST.
  const unsent = (
    await pool.query(
      `UPDATE payouts SET status = 'PENDING_UNKNOWN'
        WHERE id IN (SELECT id FROM payouts
                      WHERE status IN ('PENDING', 'PENDING_UNKNOWN') AND paypal_batch_id IS NULL
                        AND created_at > now() - make_interval(secs => $1)
                        AND updated_at <= now() - make_interval(secs => $2)
                      ORDER BY created_at LIMIT $3
                        FOR UPDATE SKIP LOCKED)
          AND status IN ('PENDING', 'PENDING_UNKNOWN') AND paypal_batch_id IS NULL
        RETURNING id, listing_id`,
      [windowSec, resendAfter, limit],
    )
  ).rows as Array<{ id: string; listing_id: string }>;
  for (const p of unsent) {
    await guard(p.id, p.listing_id, 'payout:resend', async () => {
      await sendAttempt(deps, p.id);
      out.resent++;
    });
  }

  // 2. Sent: GET the batch and read the item.
  const sent = (
    await pool.query(
      `SELECT id, listing_id, paypal_batch_id FROM payouts
        WHERE status IN ('PENDING', 'PENDING_UNKNOWN') AND paypal_batch_id IS NOT NULL
          AND created_at > now() - make_interval(secs => $1)
        ORDER BY created_at LIMIT $2`,
      [windowSec, limit],
    )
  ).rows as Array<{ id: string; listing_id: string; paypal_batch_id: string }>;
  for (const p of sent) {
    await guard(p.id, p.listing_id, 'payout:poll', async () => {
      const view = await deps.paypal.getPayoutBatch(p.paypal_batch_id);
      out.polled++;
      const { resolved } = await applyPayoutBatch(deps, p.id, view);
      if (resolved === 'SUCCESS') out.succeeded++;
      if (resolved === 'FAILED') out.failed++;
    });
  }

  // 3. INSUFFICIENT_FUNDS: a new attempt once the last one has been quiet long enough.
  const short = (
    await pool.query(
      `SELECT p.listing_id, p.attempt FROM payouts p
         JOIN listings l ON l.id = p.listing_id
        WHERE l.status = 'SETTLED' AND p.status = 'FAILED' AND p.error_code = 'INSUFFICIENT_FUNDS'
          AND p.attempt < $3
          AND p.updated_at <= now() - make_interval(secs => $1)
          AND p.attempt = (SELECT max(attempt) FROM payouts WHERE listing_id = p.listing_id)
        ORDER BY p.updated_at LIMIT $2`,
      [fundsAfter, limit, PAYOUT_MAX_FUNDS_ATTEMPTS],
    )
  ).rows as Array<{ listing_id: string; attempt: number }>;
  for (const s of short) {
    await guard('', s.listing_id, 'payout:funds-retry', async () => {
      const minted = await deps.db.tx(async (tx) => {
        const listing = await lockListing(tx, s.listing_id);
        const last = await latestPayout(tx, s.listing_id);
        if (!listing || listing.status !== 'SETTLED' || !last || last.attempt !== s.attempt) {
          return null;
        }
        if (last.status !== 'FAILED' || last.error_code !== 'INSUFFICIENT_FUNDS') return null;
        const row = await mintAttempt(tx, listing, last.attempt + 1, deps.actor ?? WORKFLOW);
        return row && row !== 'NOTHING_TO_PAY' ? row : null;
      });
      if (!minted) return;
      out.retried++;
      await sendAttempt(deps, minted.id);
    });
  }

  // 4. Stale: past the window and still unresolved. Alert once; HF-033's webhook or an admin
  //    resolves it.
  const stale = (
    await pool.query(
      `SELECT id, listing_id, status, paypal_batch_id FROM payouts
        WHERE status IN ('PENDING', 'PENDING_UNKNOWN')
          AND created_at <= now() - make_interval(secs => $1)
        LIMIT $2`,
      [windowSec, limit],
    )
  ).rows as Array<{
    id: string;
    listing_id: string;
    status: string;
    paypal_batch_id: string | null;
  }>;
  for (const p of stale) {
    await guard(p.id, p.listing_id, 'payout:stale', async () => {
      await auditOnce(
        pool,
        p.listing_id,
        'PAYOUT_STUCK',
        { status: p.status, batchId: p.paypal_batch_id, alert: true },
        p.id,
      );
      out.stale++;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admin retry
// ---------------------------------------------------------------------------

export type RetryPayoutOutcome =
  | { ok: true; listingId: string; payoutId: string; attempt: number; status: PayoutStatus }
  | { ok: false; code: 'NOT_FOUND' }
  | {
      ok: false;
      code: 'STATE_CONFLICT';
      reason: 'NOT_PAYOUT_FAILED' | 'PAYOUT_IN_FLIGHT' | 'NOTHING_TO_PAY';
      status: ListingStatus;
    };

/**
 * `POST /api/admin/listings/:id/retry-payout`: a new attempt (attempt + 1, new `sender_batch_id`)
 * for a listing whose last attempt PayPal confirmed failed. Allowed on PAYOUT_FAILED, and on
 * SETTLED when the last attempt failed with `INSUFFICIENT_FUNDS` (to retry before the poll does).
 * The listing stays PAYOUT_FAILED until this attempt succeeds (→ PAID_OUT).
 */
export async function retryPayout(
  deps: PayoutDeps,
  input: { listingId: string; actor: Actor },
): Promise<RetryPayoutOutcome> {
  const minted = await deps.db.tx(async (tx) => {
    const listing = await lockListing(tx, input.listingId);
    if (!listing) return { ok: false as const, code: 'NOT_FOUND' as const };
    const conflict = (reason: 'NOT_PAYOUT_FAILED' | 'PAYOUT_IN_FLIGHT' | 'NOTHING_TO_PAY') => ({
      ok: false as const,
      code: 'STATE_CONFLICT' as const,
      reason,
      status: listing.status,
    });
    const last = await latestPayout(tx, input.listingId);
    if (last && last.status !== 'FAILED') return conflict('PAYOUT_IN_FLIGHT');
    const retryable =
      listing.status === 'PAYOUT_FAILED' ||
      (listing.status === 'SETTLED' && last?.error_code === 'INSUFFICIENT_FUNDS');
    if (!retryable || !last) return conflict('NOT_PAYOUT_FAILED');
    const row = await mintAttempt(tx, listing, last.attempt + 1, input.actor);
    if (row === 'NOTHING_TO_PAY') return conflict('NOTHING_TO_PAY');
    if (!row) return conflict('PAYOUT_IN_FLIGHT');
    await audit(tx, {
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      listingId: input.listingId,
      entity: 'payout',
      entityId: row.id,
      action: 'PAYOUT_RETRY',
      requestId: senderBatchId(row.id, row.attempt),
      data: { attempt: row.attempt, previousPayoutId: last.id, previousCode: last.error_code },
    });
    return { ok: true as const, row };
  });
  if (!minted.ok) return minted;
  const { payout } = await sendAttempt(deps, minted.row.id);
  return {
    ok: true,
    listingId: input.listingId,
    payoutId: payout.id,
    attempt: payout.attempt,
    status: payout.status,
  };
}

/** For HF-033: the attempt a `PAYMENT.PAYOUTSBATCH.*` webhook's `sender_batch_id` names. */
export async function findPayoutBySenderBatchId(
  q: Queryable,
  id: string,
): Promise<PayoutRow | null> {
  const parsed = parseSenderBatchId(id);
  if (!parsed) return null;
  const row = await loadPayout(q, parsed.payoutId);
  return row && row.attempt === parsed.attempt ? row : null;
}
