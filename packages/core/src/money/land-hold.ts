import {
  BID_SOURCES,
  isBiddable,
  isRaisable,
  type BidSource,
  type VoidReason,
} from '@holdfast/shared';
import type { Queryable, Tx } from '../db.js';
import type { Actor, MandateCheck, MandateRefusal, MoneyDeps } from './deps.js';
import { emit } from './emit.js';
import { lockBidsById, lockListing, lockMandate, type LockedListing } from './locks.js';
import type { BidRow } from './rows.js';
import { transition } from './transition.js';
import { callVoid, loadBid, markVoided, voidKey } from './void.js';

/** Why `landHold` refused to make a bid HELD. */
export type LandHoldFailure =
  /** The listing stopped accepting this bid (Clear, Cancel, Expire, window or rounds over). */
  | 'WINDOW_CLOSED'
  | MandateRefusal
  /** Raise: the old bid is no longer HELD (Clear, a watcher void, a cancel or a parallel raise won). */
  | 'REPLACED_BID_NOT_HELD'
  /** Raise: the old bid is on another listing or belongs to another shopper. */
  | 'REPLACED_BID_MISMATCH'
  /** Raise: another bid already replaces the old one (`UNIQUE(replaces_bid_id)`, B1). */
  | 'ALREADY_REPLACED'
  /** The shopper already has a HELD bid on this listing (`one_held_bid`, D3). */
  | 'ALREADY_BID'
  /** INV-5: the authorized amount differs from the bid amount. */
  | 'AMOUNT_MISMATCH'
  /** The bid is no longer PENDING_APPROVAL (e.g. the sweeper abandoned it). */
  | 'NOT_PENDING'
  /**
   * The transaction failed for an unexpected reason (a database error, a throwing hook). The new
   * authorization is still voided before `landHold` rethrows, so it never dangles (B2).
   */
  | 'INTERNAL_ERROR';

const VOID_REASON_FOR: Record<LandHoldFailure, VoidReason> = {
  WINDOW_CLOSED: 'WINDOW_CLOSED',
  MANDATE_PAUSED: 'MANDATE_PAUSED',
  MANDATE_CAP: 'MANDATE_PAUSED',
  REPLACED_BID_NOT_HELD: 'CANCELLED',
  REPLACED_BID_MISMATCH: 'CANCELLED',
  ALREADY_REPLACED: 'CANCELLED',
  ALREADY_BID: 'CANCELLED',
  AMOUNT_MISMATCH: 'CANCELLED',
  NOT_PENDING: 'CANCELLED',
  INTERNAL_ERROR: 'CANCELLED',
};

/** Deadlock / serialization failure: the transaction is safe to run again. */
const RETRYABLE_PG_CODES = new Set(['40P01', '40001']);
const MAX_TX_ATTEMPTS = 3;

export interface LandHoldInput {
  bidId: string;
  /** PayPal authorization id; the authorization must be `CREATED` (only that is a hold). */
  authorizationId: string;
  /** PayPal authorization `create_time` (D6): all hold-age math uses it. */
  authorizedAt: Date | string;
  authorizedAmountCents: number;
  authorizationExpiresAt?: Date | string | null;
  paypalOrderId?: string | null;
  /** Raise / roll: the HELD bid this one replaces (same listing, same shopper). */
  replacesBidId?: string | null;
  actor?: Actor;
}

export type LandHoldResult =
  | { ok: true; bid: BidRow; replaced: BidRow | null; alreadyHeld: boolean }
  | {
      ok: false;
      reason: LandHoldFailure;
      voidReason: VoidReason;
      /** VOIDED once PayPal confirmed the void; VOIDING if it is left for the sweeper. */
      bid: BidRow;
      voided: boolean;
    };

const MANDATE_LIVE_STATUSES = ['PENDING_APPROVAL', 'HELD', 'WON', 'LOST'] as const;

/**
 * D12 cap, used when no HF-017a check is supplied: the mandate is ACTIVE and not expired, the
 * bid is within `max_price_cents`, and live holds (`PENDING_APPROVAL`, `HELD`, `WON`, `LOST`,
 * the new bid included, the replaced bid excluded) stay within `total_hold_cap_cents`.
 */
export const defaultMandateCheck: MandateCheck = async (
  tx,
  { mandate, bid, replacesBidId, now },
) => {
  if (mandate.status !== 'ACTIVE') return 'MANDATE_PAUSED';
  if (mandate.expires_at && mandate.expires_at.getTime() <= now.getTime()) return 'MANDATE_PAUSED';
  if (bid.amount_cents > mandate.max_price_cents) return 'MANDATE_CAP';
  const res = await tx.query(
    `SELECT coalesce(sum(amount_cents), 0)::bigint AS live
       FROM bids
      WHERE mandate_id = $1 AND status = ANY($2::text[]) AND id IS DISTINCT FROM $3`,
    [mandate.id, MANDATE_LIVE_STATUSES, replacesBidId],
  );
  const live = Number((res.rows[0] as { live: string }).live);
  // The new bid is PENDING_APPROVAL, so `live` already includes it.
  return live > mandate.total_hold_cap_cents ? 'MANDATE_CAP' : null;
};

class Refused extends Error {
  constructor(readonly reason: LandHoldFailure) {
    super(reason);
  }
}

const SYSTEM: Actor = { type: 'SYSTEM' };

/**
 * The only way a bid becomes HELD (D1, INV-2). Call it **after** PayPal returned a `CREATED`
 * authorization; the bid row stays PENDING_APPROVAL during the PayPal call (INV-1).
 *
 * One short transaction, locks in the documented order (listing → mandate → bids by id):
 * 1. listing `FOR SHARE`, re-check `isBiddable` (new bid) or `isRaisable` (raise) on DB time (D7);
 * 2. mandate `FOR UPDATE` if `mandate_id` is set, re-check ACTIVE and the cap (D12);
 * 3. the new and replaced bids `FOR UPDATE` in id order; for a raise, old HELD→VOIDING
 *    (`REPLACED`, `void-<oldId>`);
 * 4. new PENDING_APPROVAL→HELD with the authorization id, `authorized_at` and
 *    `authorized_amount_cents` (= `amount_cents`, INV-5);
 * 5. `bid.held` (and `bid.raised`) via `emit`, so they fire only on COMMIT.
 *
 * If any check fails or touches 0 rows: ROLLBACK, void the **new** authorization with
 * `void-<bidId>`, and end the bid VOIDED with the reason (B2, B9). The caller voids the replaced
 * bid's hold after a successful swap (`voidBid(old, 'REPLACED')` with `from: ['VOIDING']`, or
 * leave it to the sweeper).
 */
export async function landHold(deps: MoneyDeps, input: LandHoldInput): Promise<LandHoldResult> {
  const actor = input.actor ?? SYSTEM;
  const replacesBidId = input.replacesBidId ?? null;
  const pending = await loadBid(deps.db.pool, input.bidId);

  if (pending.status === 'HELD' && pending.paypal_authorization_id === input.authorizationId) {
    return { ok: true, bid: pending, replaced: null, alreadyHeld: true };
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const landed = await deps.db.tx((tx) => land(deps, tx, pending, input, replacesBidId, actor));
      return { ok: true, ...landed, alreadyHeld: false };
    } catch (err) {
      const reason = refusalOf(err);
      if (reason) return refuse(deps, pending, input, reason, actor);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE_PG_CODES.has(code) && attempt < MAX_TX_ATTEMPTS) continue;
      if (err instanceof ForeignAuthorization) throw err;
      // Unexpected: still record and void the new authorization, then surface the error.
      try {
        await refuse(
          deps,
          pending,
          input,
          'INTERNAL_ERROR',
          actor,
          code ? `PG_${code}` : 'INTERNAL',
        );
      } catch (voidErr) {
        throw new AggregateError(
          [err, voidErr],
          `landHold failed and could not void ${voidKey(pending.id)}`,
        );
      }
      throw err;
    }
  }
}

/**
 * The authorization id is already stored on another bid (`bids_paypal_authorization_id_key`).
 * That row owns it and its own void key; voiding it as this bid could release a live hold, so
 * this is surfaced as a caller bug instead of being voided.
 */
export class ForeignAuthorization extends Error {
  constructor(
    readonly bidId: string,
    readonly authorizationId: string,
  ) {
    super(
      `landHold: authorization ${authorizationId} already belongs to another bid (bid ${bidId})`,
    );
    this.name = 'ForeignAuthorization';
  }
}

async function land(
  deps: MoneyDeps,
  tx: Tx,
  pending: BidRow,
  input: LandHoldInput,
  replacesBidId: string | null,
  actor: Actor,
): Promise<{ bid: BidRow; replaced: BidRow | null }> {
  if (input.authorizedAmountCents !== pending.amount_cents) throw new Refused('AMOUNT_MISMATCH');

  // 1. Listing FOR SHARE: blocks (and is blocked by) Clear / Cancel / Expire's conditional UPDATE.
  const listing = await lockListing(tx, pending.listing_id, 'share');
  if (!listing || !accepts(listing, replacesBidId !== null)) throw new Refused('WINDOW_CLOSED');

  // 2. Mandate FOR UPDATE.
  if (pending.mandate_id) {
    const mandate = await lockMandate(tx, pending.mandate_id);
    if (!mandate) throw new Refused('MANDATE_PAUSED');
    const check = deps.mandateCheck ?? defaultMandateCheck;
    const refusal = await check(tx, { mandate, bid: pending, replacesBidId, now: listing.db_now });
    if (refusal) throw new Refused(refusal);
  }

  // 3. Bids by id.
  const locked = await lockBidsById(tx, replacesBidId ? [pending.id, replacesBidId] : [pending.id]);
  const current = locked.find((b) => b.id === pending.id);
  if (!current || current.status !== 'PENDING_APPROVAL') throw new Refused('NOT_PENDING');

  let replaced: BidRow | null = null;
  if (replacesBidId) {
    const old = locked.find((b) => b.id === replacesBidId);
    if (!old || old.listing_id !== current.listing_id || old.shopper_id !== current.shopper_id) {
      throw new Refused('REPLACED_BID_MISMATCH');
    }
    replaced = await transition<'bids', BidRow>(tx, 'bids', replacesBidId, 'HELD', 'VOIDING', {
      void_reason: 'REPLACED',
      void_request_id: voidKey(replacesBidId),
    });
    if (!replaced) throw new Refused('REPLACED_BID_NOT_HELD');
  }

  // 4. New bid PENDING_APPROVAL → HELD. Unique violations surface as refusals.
  let bid: BidRow | null;
  try {
    bid = await transition<'bids', BidRow>(tx, 'bids', current.id, 'PENDING_APPROVAL', 'HELD', {
      paypal_authorization_id: input.authorizationId,
      authorized_at: new Date(input.authorizedAt),
      authorized_amount_cents: input.authorizedAmountCents,
      authorization_expires_at: input.authorizationExpiresAt
        ? new Date(input.authorizationExpiresAt)
        : undefined,
      paypal_order_id: input.paypalOrderId ?? undefined,
      replaces_bid_id: replacesBidId ?? undefined,
      needs_reconcile: false,
    });
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (
      pgErr.code === '23505' &&
      (pgErr.constraint === 'one_held_bid' || pgErr.constraint === 'bids_one_held_per_intent')
    ) {
      throw new Refused('ALREADY_BID');
    }
    if (pgErr.code === '23505' && pgErr.constraint === 'bids_paypal_authorization_id_key') {
      throw new ForeignAuthorization(current.id, input.authorizationId);
    }
    if (pgErr.code === '23505' && pgErr.constraint === 'bids_replaces_bid_id_key') {
      throw new Refused('ALREADY_REPLACED');
    }
    throw err;
  }
  if (!bid) throw new Refused('NOT_PENDING');

  // 5. Events, delivered on COMMIT only.
  await emitHeld(tx, bid, replaced);
  await deps.audit?.(tx, {
    actor,
    action: 'BID_HELD',
    entity: 'bid',
    entityId: bid.id,
    listingId: bid.listing_id,
    paypalId: input.authorizationId,
    data: { amountCents: bid.amount_cents, replacesBidId },
  });
  return { bid, replaced };
}

function accepts(listing: LockedListing, isRaise: boolean): boolean {
  if (!listing.window_closes_at) return false;
  const timing = {
    status: listing.status,
    windowClosesAt: listing.window_closes_at,
    roundsEndAt: listing.rounds_end_at,
  };
  return isRaise ? isRaisable(timing, listing.db_now) : isBiddable(timing, listing.db_now);
}

async function emitHeld(tx: Queryable, bid: BidRow, replaced: BidRow | null): Promise<void> {
  const res = await tx.query(`SELECT is_simulated FROM shoppers WHERE id = $1`, [bid.shopper_id]);
  const isSimulated = Boolean(
    (res.rows[0] as { is_simulated?: boolean } | undefined)?.is_simulated,
  );
  const source: BidSource = (BID_SOURCES as readonly string[]).includes(bid.source ?? '')
    ? (bid.source as BidSource)
    : 'OFFER_PAGE';
  // Opaque, non-PII label. HF-022 owns the per-listing "Shopper #n" sequence; clients re-fetch it.
  const shopperLabel = `Shopper #${bid.seq}`;
  const at = new Date().toISOString();
  await emit(tx, bid.listing_id, {
    type: 'bid.held',
    listingId: bid.listing_id,
    at,
    bidId: bid.id,
    shopperLabel,
    amountCents: bid.amount_cents,
    source,
    isSimulated,
    placedAt: bid.placed_at.toISOString(),
  });
  if (replaced) {
    await emit(tx, bid.listing_id, {
      type: 'bid.raised',
      listingId: bid.listing_id,
      at,
      bidId: bid.id,
      replacesBidId: replaced.id,
      oldCents: replaced.amount_cents,
      newCents: bid.amount_cents,
      shopperLabel,
      source,
      isSimulated,
    });
  }
}

function refusalOf(err: unknown): LandHoldFailure | null {
  if (err instanceof Refused) return err.reason;
  return null;
}

/**
 * The transaction rolled back. Record the new authorization on the bid and move it to VOIDING
 * (so the sweeper can finish if PayPal is down), void it with `void-<bidId>`, then VOIDED.
 */
async function refuse(
  deps: MoneyDeps,
  pending: BidRow,
  input: LandHoldInput,
  reason: LandHoldFailure,
  actor: Actor,
  errorCode: string = reason,
): Promise<LandHoldResult> {
  const voidReason = VOID_REASON_FOR[reason];
  const marked = await deps.db.tx(async (tx) => {
    const bid = await transition<'bids', BidRow>(
      tx,
      'bids',
      pending.id,
      ['PENDING_APPROVAL', 'ABANDONED'],
      'VOIDING',
      {
        paypal_authorization_id: input.authorizationId,
        paypal_order_id: input.paypalOrderId ?? undefined,
        void_reason: voidReason,
        void_request_id: voidKey(pending.id),
        error_code: errorCode,
      },
    );
    if (bid) {
      await deps.audit?.(tx, {
        actor,
        action: 'BID_HOLD_REJECTED',
        entity: 'bid',
        entityId: bid.id,
        listingId: bid.listing_id,
        paypalId: input.authorizationId,
        requestId: voidKey(bid.id),
        data: { reason, voidReason },
      });
    }
    return bid;
  });

  if (!marked) {
    const current = await loadBid(deps.db.pool, pending.id);
    if (current.paypal_authorization_id === input.authorizationId && current.status === 'HELD') {
      // A concurrent landHold with the same authorization won; this call is a replay.
      return { ok: true, bid: current, replaced: null, alreadyHeld: true };
    }
    if (
      current.paypal_authorization_id &&
      current.paypal_authorization_id !== input.authorizationId
    ) {
      // void-<bidId> belongs to the bid's own authorization; one bid never gets two (D4).
      throw new Error(
        `landHold: bid ${pending.id} already has another authorization; refusing to reuse ${voidKey(pending.id)}`,
      );
    }
  }

  // Void the new authorization even if the row moved on: it must not dangle (B2).
  const call = await callVoid(deps, pending.id, input.authorizationId);
  if (marked && call.done) {
    const bid = await markVoided(deps, pending.id, actor, { emitEvent: false });
    if (bid) return { ok: false, reason, voidReason, bid, voided: true };
  }
  return {
    ok: false,
    reason,
    voidReason,
    bid: await loadBid(deps.db.pool, pending.id),
    voided: call.done,
  };
}
