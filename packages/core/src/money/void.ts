import type { BidStatus, VoidReason } from '@holdfast/shared';
import type { Queryable } from '../db.js';
import {
  DEFAULT_VOID_BACKOFF_MS,
  type Actor,
  type MoneyDeps,
  type PayPalVoidResult,
  type VoidRequestId,
} from './deps.js';
import { emit } from './emit.js';
import type { BidRow } from './rows.js';
import { SQL_NOW, transition } from './transition.js';

/** `void-<bidId>` (D4, D5): every void path for a bid uses this key, so PayPal voids it once. */
export function voidKey(bidId: string): VoidRequestId {
  return `void-${bidId}` as VoidRequestId;
}

/** TERMINAL codes that still mean "no money is held", so the void is done. */
const ALREADY_RELEASED_CODES = new Set(['AUTHORIZATION_VOIDED', 'AUTHORIZATION_EXPIRED']);
const ALREADY_RELEASED_STATUSES = new Set(['VOIDED', 'EXPIRED']);

export type VoidCallOutcome =
  { done: true; attempts: number } | { done: false; attempts: number; code: string };

/** Whether a void result means the authorization no longer holds money. */
export function isReleased(result: PayPalVoidResult): boolean {
  if (result.ok) return true;
  if (result.errorClass === 'RECONCILE') {
    // A 422 on void: already voided / expired. If the GET says CAPTURED, that is not a release.
    return (
      result.authorizationStatus === undefined ||
      ALREADY_RELEASED_STATUSES.has(result.authorizationStatus)
    );
  }
  return (
    result.errorClass === 'TERMINAL' && !!result.code && ALREADY_RELEASED_CODES.has(result.code)
  );
}

/**
 * Call `pp.void` outside any transaction (INV-1) with `void-<bidId>`, retrying TRANSIENT failures
 * with backoff (4 calls in total by default, D11). Counts every call in `bids.void_attempts`.
 */
export async function callVoid(
  deps: MoneyDeps,
  bidId: string,
  authorizationId: string,
): Promise<VoidCallOutcome> {
  const backoff = deps.voidBackoffMs ?? DEFAULT_VOID_BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const key = voidKey(bidId);
  let attempts = 0;
  let code = 'UNKNOWN';
  for (let i = 0; i <= backoff.length; i++) {
    if (i > 0) await sleep(backoff[i - 1] ?? 0);
    attempts++;
    await deps.db.pool.query(
      `UPDATE bids SET void_attempts = void_attempts + 1, void_request_id = $2 WHERE id = $1`,
      [bidId, key],
    );
    let result: PayPalVoidResult;
    try {
      result = await deps.paypal.void(authorizationId, key);
    } catch {
      // Network error or timeout: the same request id makes the retry safe.
      result = { ok: false, errorClass: 'TRANSIENT', code: 'NETWORK' };
    }
    if (isReleased(result)) return { done: true, attempts };
    code = (!result.ok && result.code) || (!result.ok ? result.errorClass : 'UNKNOWN');
    if (!result.ok && result.errorClass !== 'TRANSIENT') break;
  }
  return { done: false, attempts, code };
}

/** Finish a void: VOIDING → VOIDED with `voided_at`, and emit `bid.voided`. */
export async function markVoided(
  deps: MoneyDeps,
  bidId: string,
  actor: Actor,
  { emitEvent = true }: { emitEvent?: boolean } = {},
): Promise<BidRow | null> {
  return deps.db.tx(async (tx) => {
    const bid = await transition<'bids', BidRow>(tx, 'bids', bidId, 'VOIDING', 'VOIDED', {
      voided_at: SQL_NOW,
    });
    if (!bid) return null;
    if (emitEvent) await emitVoided(tx, bid);
    await deps.audit?.(tx, {
      actor,
      action: 'BID_VOIDED',
      entity: 'bid',
      entityId: bid.id,
      listingId: bid.listing_id,
      paypalId: bid.paypal_authorization_id,
      requestId: voidKey(bid.id),
      data: { reason: bid.void_reason, attempts: bid.void_attempts },
    });
    return bid;
  });
}

export async function emitVoided(tx: Queryable, bid: BidRow): Promise<void> {
  if (!bid.void_reason) return;
  await emit(tx, bid.listing_id, {
    type: 'bid.voided',
    listingId: bid.listing_id,
    at: new Date().toISOString(),
    bidId: bid.id,
    amountCents: bid.amount_cents,
    reason: bid.void_reason,
    status: bid.status,
  });
}

export interface VoidBidOptions {
  /** Statuses that may move to VOIDING. Default `['HELD']`. */
  from?: readonly BidStatus[];
  /**
   * Also finish a bid already in VOIDING (the sweeper, HF-034). Off by default so two callers
   * racing on one bid make one PayPal call: the loser of HELD→VOIDING does nothing.
   */
  resume?: boolean;
}

export type VoidBidResult =
  /** This call voided the bid (or found nothing to void). */
  | { outcome: 'VOIDED'; bid: BidRow }
  /** Already VOIDED before this call; no PayPal call made. */
  | { outcome: 'ALREADY_VOIDED'; bid: BidRow }
  /** PayPal still failing after retries: left VOIDING for the sweeper. */
  | { outcome: 'LEFT_VOIDING'; bid: BidRow; code: string }
  /** The bid was not in a voidable status (another path owns it, e.g. a concurrent void). */
  | { outcome: 'SKIPPED'; bid: BidRow };

/**
 * Release a bid's hold (D4): HELD → VOIDING in a short transaction (records `void_reason` and
 * `void_request_id = void-<bidId>`, emits `bid.voided`), then `pp.void(authId, void-<bidId>)`
 * outside it with retries, then VOIDING → VOIDED. "Already voided" (RECONCILE) counts as success.
 * On persistent failure the bid stays VOIDING for the sweeper (HF-034), which calls this with
 * `resume: true`. Never writes VOID settlement rows (those exist only for Clear).
 */
export async function voidBid(
  deps: MoneyDeps,
  bidId: string,
  reason: VoidReason,
  actor: Actor,
  opts: VoidBidOptions = {},
): Promise<VoidBidResult> {
  const from = opts.from ?? (['HELD'] as const);
  const flipped = await deps.db.tx(async (tx) => {
    const bid = await transition<'bids', BidRow>(tx, 'bids', bidId, from, 'VOIDING', {
      void_reason: reason,
      void_request_id: voidKey(bidId),
    });
    if (!bid) return null;
    await emitVoided(tx, bid);
    await deps.audit?.(tx, {
      actor,
      action: 'BID_VOID_REQUESTED',
      entity: 'bid',
      entityId: bid.id,
      listingId: bid.listing_id,
      paypalId: bid.paypal_authorization_id,
      requestId: voidKey(bid.id),
      data: { reason },
    });
    return bid;
  });

  let bid = flipped;
  if (!bid) {
    const current = await loadBid(deps.db.pool, bidId);
    if (current.status === 'VOIDED') return { outcome: 'ALREADY_VOIDED', bid: current };
    if (!(current.status === 'VOIDING' && opts.resume)) return { outcome: 'SKIPPED', bid: current };
    bid = current;
  }

  if (bid.paypal_authorization_id) {
    const call = await callVoid(deps, bidId, bid.paypal_authorization_id);
    if (!call.done) {
      await deps.db.pool.query(
        `UPDATE bids SET error_code = $2 WHERE id = $1 AND status = 'VOIDING'`,
        [bidId, call.code],
      );
      return { outcome: 'LEFT_VOIDING', bid: await loadBid(deps.db.pool, bidId), code: call.code };
    }
  }

  const done = await markVoided(deps, bidId, actor);
  if (done) return { outcome: 'VOIDED', bid: done };
  // Someone else (a concurrent resume) finished it first.
  const current = await loadBid(deps.db.pool, bidId);
  return current.status === 'VOIDED'
    ? { outcome: 'ALREADY_VOIDED', bid: current }
    : { outcome: 'SKIPPED', bid: current };
}

export async function loadBid(q: Queryable, bidId: string): Promise<BidRow> {
  const res = await q.query(`SELECT * FROM bids WHERE id = $1`, [bidId]);
  const bid = res.rows[0] as BidRow | undefined;
  if (!bid) throw new Error(`bid ${bidId} not found`);
  return bid;
}
