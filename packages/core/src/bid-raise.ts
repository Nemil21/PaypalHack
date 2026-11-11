import {
  isRaisable,
  minRaiseCents,
  raisedMessage,
  raiseFailedMessage,
  ROUNDS_ENDED_COPY,
  severalHoldsWarning,
  pendingHoldsWarning,
  formatUsd,
} from '@holdfast/shared';
import { audit } from './audit.js';
import {
  actorFor,
  awaitApproval,
  bidErrorResponse,
  denialError,
  findByKey,
  isTwoStep,
  landingError,
  markHoldFailed,
  markNeedsReconcile,
  paymentSourceFor,
  refusalFromVoid,
  type BidPaymentMethod,
  type PlaceBidDeps,
  type PlaceBidError,
  type PlaceBidInput,
} from './bids.js';
import type { Queryable, Tx } from './db.js';
import { errorBody, type IdempotentResponse } from './idempotency.js';
import { authorize } from './mandates.js';
import { landHold } from './money/land-hold.js';
import { lockBidsById } from './money/locks.js';
import type { Actor } from './money/deps.js';
import type { BidRow } from './money/rows.js';
import { voidBid } from './money/void.js';
import { orderRequestId } from './paypal/ids.js';
import type { HoldResult, PaymentSource } from './paypal/types.js';

/**
 * Raise a held bid (HF-018; api.md §`POST /bids/:id/raise`, features/05 §Logic 4, features/19
 * §Logic 4–5, data-model §Locking rule 3). PayPal can't grow a hold in place, so a raise is a new
 * bid with a new hold that replaces the old one:
 *
 * 1. The old bid is HELD and the listing is raisable (D7, `isRaisable`), else `WINDOW_CLOSED`.
 * 2. Minimum raise: $1 or 1% of the current bid (`minRaiseCents`), else `VALIDATION_ERROR`.
 * 3. `release_if_cheaper` on and the new amount above `products.best_public_price_cents` →
 *    `PRICE_DROPPED`, before any hold (M11: agents never raise above the public price).
 * 4. One transaction (serialized per shopper and listing): `mandates.authorize` with the old bid
 *    excluded (D12) when the bid has a mandate; agent caps (M11); insert the new bid
 *    PENDING_APPROVAL with `replaces_bid_id = old.id`, inheriting the old bid's fields, a fresh
 *    `placed_at` (the raise time ranks it) and `raise_count + 1`. A second concurrent raise of the
 *    same bid is refused here with `STATE_CONFLICT`, before any PayPal call.
 * 5. The hold, outside any transaction (INV-1), with `PayPal-Request-Id = <newBidId>`: VAULT if
 *    the shopper has one (CIT, or MIT for an agent's rounds auto-raise); otherwise the old bid's
 *    method, so a wallet-only shopper gets `PENDING_APPROVAL` + `approveUrl` and the swap
 *    completes in `authorizeAndLand` (HF-014b).
 * 6. `landHold` swaps atomically (D1): old HELD→VOIDING (`REPLACED`), new →HELD, `bid.raised` and
 *    `bid.held` on COMMIT. If Clear, a watcher void, a cancel, a pause or a parallel raise won, the
 *    **new** authorization is voided and the old bid stands.
 * 7. After COMMIT the old hold is voided with `void-<oldBidId>`; on PayPal failure it stays
 *    VOIDING for the HF-034 sweeper.
 *
 * A declined new hold ends the new bid HOLD_FAILED and leaves the old bid HELD:
 * "Couldn't raise. Your $229 bid still stands."
 */

/** M11: an agent raises at most once per round… */
export const AGENT_RAISES_PER_ROUND = 1;
/** …and at most 3 times per listing. Manual (shopper) raises are uncapped. */
export const AGENT_RAISES_PER_LISTING = 3;

/** Audit action written in the insert transaction; also the record the M11 agent caps count. */
export const RAISE_REQUESTED_ACTION = 'BID_RAISE_REQUESTED';

export interface RaiseBidInput {
  /** The HELD bid being raised. */
  bidId: string;
  /** The new total amount (not the increment). */
  amountCents: number;
  /** The bid must belong to this shopper (else NOT_FOUND). */
  shopperId: string;
  idempotencyKey: string;
  /** Audit actor. Default: the shopper. */
  actor?: Actor;
  /**
   * An agent decided this raise (rounds auto-raise, buyer agent under a mandate): the M11 caps
   * apply. Default: `actor.type === 'BUYER_AGENT'`. Shopper-confirmed raises are uncapped.
   */
  agentInitiated?: boolean;
  /**
   * VAULT `stored_credential.payment_initiator`. Default `MERCHANT` for agent-initiated raises
   * (no shopper present) and `CUSTOMER` otherwise.
   */
  initiator?: 'CUSTOMER' | 'MERCHANT';
  /**
   * The channel the raise came through (HF-044b: `MCP` for `raise_bid`), so the console's raises
   * feed and `bid.raised` show it. Default: the old bid's source.
   */
  source?: PlaceBidInput['source'];
}

export type RaiseBidError =
  | PlaceBidError
  /** Over the public price while `release_if_cheaper` is on. Nothing was held. */
  | { code: 'PRICE_DROPPED'; bidId: string; publicPriceCents: number };

export type RaiseBidResult =
  | {
      ok: true;
      /** The new bid: HELD, or PENDING_APPROVAL waiting for wallet approval / card fields. */
      bid: BidRow;
      /** The bid that was raised: VOIDED (or VOIDING for the sweeper) once the swap landed. */
      oldBid: BidRow;
      replayed: boolean;
      /** PAYPAL raises waiting for the buyer: the `rel=payer-action` link. */
      approveUrl?: string | null;
    }
  | {
      ok: false;
      error: RaiseBidError;
      /** The new bid, when one was created (HOLD_FAILED, VOIDED, needs_reconcile …). */
      bid: BidRow | null;
      /** The bid that was to be raised, as it is now. Null only when it was not found. */
      oldBid: BidRow | null;
      replayed: boolean;
    };

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested)
// ---------------------------------------------------------------------------------------------

/** The smallest allowed raise target for a bid of `currentCents` ($1 or 1%, 05 §Logic 4). */
export function minRaiseTargetCents(currentCents: number): number {
  return currentCents + minRaiseCents(currentCents);
}

/** Null when `newCents` is a valid raise of `currentCents`, else the shopper-facing reason. */
export function raiseAmountProblem(currentCents: number, newCents: number): string | null {
  const min = minRaiseTargetCents(currentCents);
  return newCents >= min ? null : `Raise to at least ${formatUsd(min)}.`;
}

/** `release_if_cheaper` on and above the public price: the raise would be released anyway. */
export function aboveRaisePriceGuard(
  releaseIfCheaper: boolean,
  newCents: number,
  publicPriceCents: number | null,
): boolean {
  return releaseIfCheaper && publicPriceCents != null && newCents > publicPriceCents;
}

export interface AgentRaiseCounts {
  /** Landed or in-flight agent raises on this listing by this shopper. */
  onListing: number;
  /** Of those, in the current round (0 outside ROUNDS). */
  thisRound: number;
}

/** M11 caps for agent-initiated raises. Null when allowed. */
export function agentRaiseLimit(
  counts: AgentRaiseCounts,
): 'AGENT_RAISE_LIMIT_ROUND' | 'AGENT_RAISE_LIMIT_LISTING' | null {
  if (counts.onListing >= AGENT_RAISES_PER_LISTING) return 'AGENT_RAISE_LIMIT_LISTING';
  if (counts.thisRound >= AGENT_RAISES_PER_ROUND) return 'AGENT_RAISE_LIMIT_ROUND';
  return null;
}

/**
 * The payment method of the new hold: the shopper's vault when there is one (one call, no buyer
 * step), otherwise the old bid's method (a wallet-only shopper approves again).
 */
export function raisePaymentMethod(
  oldMethod: string | null,
  hasVault: boolean,
): BidPaymentMethod | null {
  if (hasVault) return 'VAULT';
  if (oldMethod === 'PAYPAL' || oldMethod === 'CARD' || oldMethod === 'TEST_CARD') return oldMethod;
  return null;
}

// ---------------------------------------------------------------------------------------------
// raiseBid
// ---------------------------------------------------------------------------------------------

interface RaiseListing {
  status: string;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  current_round: number | null;
  product_id: string;
  best_public_price_cents: number | null;
  db_now: Date;
}

const raisable = (l: RaiseListing) =>
  !!l.window_closes_at &&
  isRaisable(
    { status: l.status as never, windowClosesAt: l.window_closes_at, roundsEndAt: l.rounds_end_at },
    l.db_now,
  );

/** Thrown inside the insert transaction to roll it back. */
class RaiseRefused extends Error {
  constructor(readonly error: RaiseBidError) {
    super(error.code);
  }
}

export async function raiseBid(deps: PlaceBidDeps, input: RaiseBidInput): Promise<RaiseBidResult> {
  const actor: Actor = input.actor ?? { type: 'SHOPPER', id: input.shopperId };
  const agentInitiated = input.agentInitiated ?? actor.type === 'BUYER_AGENT';

  const old = await findBid(deps.db.pool, input.bidId);
  if (!old || old.shopper_id !== input.shopperId) {
    return {
      ok: false,
      error: { code: 'NOT_FOUND', what: 'bid' },
      bid: null,
      oldBid: null,
      replayed: false,
    };
  }
  const fail = (error: RaiseBidError, bid: BidRow | null = null, oldBid: BidRow = old) =>
    ({ ok: false, error, bid, oldBid, replayed: false }) as const;

  // Idempotency: the new bid row is the record of what this key did.
  const prior = await findByKey(deps.db.pool, input.shopperId, input.idempotencyKey);
  if (prior) return replay(deps, input, old, prior, actor, agentInitiated);

  // 1. Old bid HELD, listing raisable (D7). No PayPal call.
  if (old.status !== 'HELD') {
    return fail({
      code: 'STATE_CONFLICT',
      bidId: old.id,
      reason: `BID_${old.status}`,
      released: false,
    });
  }
  const listing = await loadListing(deps.db.pool, old.listing_id);
  if (!listing || !raisable(listing)) {
    return fail({
      code: 'WINDOW_CLOSED',
      bidId: null,
      amountCents: input.amountCents,
      released: false,
      roundsEnded: listing?.status === 'ROUNDS',
    });
  }

  // 2. Minimum raise.
  const problem = raiseAmountProblem(old.amount_cents, input.amountCents);
  if (problem) return fail({ code: 'VALIDATION_ERROR', field: 'amountCents', message: problem });

  // 3. Over the public price while release_if_cheaper is on: refuse before any hold.
  if (
    aboveRaisePriceGuard(
      Boolean(old.release_if_cheaper),
      input.amountCents,
      listing.best_public_price_cents,
    )
  ) {
    return fail({
      code: 'PRICE_DROPPED',
      bidId: old.id,
      publicPriceCents: listing.best_public_price_cents!,
    });
  }

  // The payment source is decided before the bid row exists, like placeBid.
  const placeInput = await placeInputFor(deps, input, old, agentInitiated);
  if ('error' in placeInput) return fail(placeInput.error);
  const source = await paymentSourceFor(deps, placeInput);
  if ('error' in source) return fail(source.error);

  // 4. Insert transaction.
  let inserted: { kind: 'placed'; bid: BidRow } | { kind: 'existing'; bid: BidRow };
  try {
    inserted = await deps.db.tx((tx) =>
      insertRaise(deps, tx, input, old, placeInput.paymentMethod, actor, agentInitiated),
    );
  } catch (err) {
    if (err instanceof RaiseRefused) {
      return fail(err.error, null, (await findBid(deps.db.pool, old.id)) ?? old);
    }
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'bids_replaces_bid_id_key') {
      // Backstop for the UNIQUE(replaces_bid_id) race (D3).
      return fail({
        code: 'STATE_CONFLICT',
        bidId: old.id,
        reason: 'RAISE_IN_PROGRESS',
        released: false,
      });
    }
    if (pgErr.code === '23505' && pgErr.constraint === 'bids_shopper_idempotency_key') {
      const other = await findByKey(deps.db.pool, input.shopperId, input.idempotencyKey);
      if (other) return replay(deps, input, old, other, actor, agentInitiated);
    }
    throw err;
  }
  if (inserted.kind === 'existing') {
    return replay(deps, input, old, inserted.bid, actor, agentInitiated);
  }

  return holdRaise(deps, placeInput, inserted.bid, source.paymentSource, actor);
}

async function placeInputFor(
  deps: PlaceBidDeps,
  input: RaiseBidInput,
  old: BidRow,
  agentInitiated: boolean,
): Promise<PlaceBidInput | { error: PlaceBidError }> {
  const res = await deps.db.pool.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [
    old.shopper_id,
  ]);
  const shopper = res.rows[0] as { paypal_vault_id: string | null } | undefined;
  if (!shopper) return { error: { code: 'NOT_FOUND', what: 'shopper' } };
  const paymentMethod = raisePaymentMethod(
    old.payment_method as string | null,
    !!shopper.paypal_vault_id,
  );
  if (!paymentMethod) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        field: 'paymentMethod',
        message: 'There is no saved payment method to raise with.',
      },
    };
  }
  return {
    shopperId: old.shopper_id,
    listingId: old.listing_id,
    amountCents: input.amountCents,
    paymentMethod,
    mandateId: old.mandate_id,
    intentId: old.intent_id,
    releaseIfCheaper: Boolean(old.release_if_cheaper),
    source: input.source ?? ((old.source ?? 'OFFER_PAGE') as PlaceBidInput['source']),
    idempotencyKey: input.idempotencyKey,
    initiator: input.initiator ?? (agentInitiated ? 'MERCHANT' : 'CUSTOMER'),
    actor: input.actor ?? { type: 'SHOPPER', id: old.shopper_id },
  };
}

async function insertRaise(
  deps: PlaceBidDeps,
  tx: Tx,
  input: RaiseBidInput,
  old: BidRow,
  paymentMethod: BidPaymentMethod,
  actor: Actor,
  agentInitiated: boolean,
): Promise<{ kind: 'placed'; bid: BidRow } | { kind: 'existing'; bid: BidRow }> {
  // Same advisory lock as placeBid: one placement or raise per (shopper, listing) at a time.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `bid:${old.shopper_id}:${old.listing_id}`,
  ]);
  const same = await findByKey(tx, old.shopper_id, input.idempotencyKey);
  if (same) return { kind: 'existing', bid: same };

  const listing = await loadListing(tx, old.listing_id);
  if (!listing || !raisable(listing)) {
    throw new RaiseRefused({
      code: 'WINDOW_CLOSED',
      bidId: null,
      amountCents: input.amountCents,
      released: false,
      roundsEnded: listing?.status === 'ROUNDS',
    });
  }

  // Lock order: (listing, not locked here) → mandate → bids. D12: the old hold is excluded.
  if (old.mandate_id) {
    const authorized = await authorize(tx, old.mandate_id, {
      newHoldCents: input.amountCents,
      replacedBidId: old.id,
      productId: listing.product_id,
      shopperId: old.shopper_id,
    });
    if (!authorized.ok) {
      throw new RaiseRefused(
        denialError(authorized.denial, authorized.mandate?.max_price_cents ?? 0),
      );
    }
  }

  const [current] = await lockBidsById(tx, [old.id]);
  if (!current || current.status !== 'HELD') {
    throw new RaiseRefused({
      code: 'STATE_CONFLICT',
      bidId: old.id,
      reason: `BID_${current?.status ?? 'MISSING'}`,
      released: false,
    });
  }
  // Re-check the minimum against the locked row (a raise may have landed meanwhile).
  const problem = raiseAmountProblem(current.amount_cents, input.amountCents);
  if (problem) {
    throw new RaiseRefused({ code: 'VALIDATION_ERROR', field: 'amountCents', message: problem });
  }

  // UNIQUE(replaces_bid_id): a raise that never held (declined, abandoned, refused by landHold)
  // gives the slot back, so the shopper can try again. A live one (in flight, waiting for the
  // wallet) keeps it: this raise is refused before any PayPal call.
  const rival = await tx.query(
    `SELECT id, status, authorized_at FROM bids WHERE replaces_bid_id = $1 FOR UPDATE`,
    [old.id],
  );
  const other = rival.rows[0] as
    { id: string; status: string; authorized_at: Date | null } | undefined;
  if (other) {
    const deadEnd =
      other.authorized_at === null &&
      ['HOLD_FAILED', 'ABANDONED', 'VOIDING', 'VOIDED'].includes(other.status);
    if (!deadEnd) {
      throw new RaiseRefused({
        code: 'STATE_CONFLICT',
        bidId: old.id,
        reason: 'RAISE_IN_PROGRESS',
        released: false,
      });
    }
    await tx.query(`UPDATE bids SET replaces_bid_id = NULL WHERE id = $1`, [other.id]);
  }

  // M11: agent-initiated raises, at most once per round and 3 times per listing.
  const round = listing.status === 'ROUNDS' ? listing.current_round : null;
  if (agentInitiated) {
    const counts = await agentRaiseCounts(tx, old.listing_id, old.shopper_id, round);
    const limit = agentRaiseLimit(counts);
    if (limit) {
      throw new RaiseRefused({
        code: 'STATE_CONFLICT',
        bidId: old.id,
        reason: limit,
        released: false,
      });
    }
  }

  const res = await tx.query(
    `INSERT INTO bids (listing_id, shopper_id, intent_id, mandate_id, amount_cents, payment_method,
                       source, public_price_at_placement, release_if_cheaper, raise_count,
                       nudges_muted, utm_source, idempotency_key, replaces_bid_id, placed_at)
     SELECT o.listing_id, o.shopper_id, o.intent_id, o.mandate_id, $2, $3,
            coalesce($5, o.source), p.best_public_price_cents, o.release_if_cheaper, o.raise_count + 1,
            o.nudges_muted, o.utm_source, $4, o.id, clock_timestamp()
       FROM bids o
       JOIN listings l ON l.id = o.listing_id
       JOIN products p ON p.id = l.product_id
      WHERE o.id = $1
     RETURNING *`,
    [old.id, input.amountCents, paymentMethod, input.idempotencyKey, input.source ?? null],
  );
  const bid = res.rows[0] as BidRow;

  // Always written (not only through deps.audit): the M11 caps count these rows.
  await audit(tx, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    listingId: bid.listing_id,
    entity: 'bid',
    entityId: bid.id,
    action: RAISE_REQUESTED_ACTION,
    requestId: bid.id,
    data: {
      replacesBidId: old.id,
      oldCents: old.amount_cents,
      newCents: bid.amount_cents,
      paymentMethod,
      agentInitiated,
      round,
      raiseCount: bid.raise_count,
    },
  });
  return { kind: 'placed', bid };
}

/** Agent raises that landed or are still in flight (a declined one doesn't use the allowance). */
export async function agentRaiseCounts(
  q: Queryable,
  listingId: string,
  shopperId: string,
  round: number | null,
): Promise<AgentRaiseCounts> {
  const res = await q.query(
    `SELECT count(*)::int AS on_listing,
            count(*) FILTER (WHERE $3::int IS NOT NULL
                               AND (a.data->>'round')::int = $3::int)::int AS this_round
       FROM audit_events a
       JOIN bids b ON b.id = a.entity_id
      WHERE a.listing_id = $1 AND a.action = $4 AND b.shopper_id = $2
        AND (a.data->>'agentInitiated')::boolean
        AND (b.authorized_at IS NOT NULL OR b.status = 'PENDING_APPROVAL')`,
    [listingId, shopperId, round, RAISE_REQUESTED_ACTION],
  );
  const row = res.rows[0] as { on_listing: number; this_round: number };
  return { onListing: row.on_listing, thisRound: row.this_round };
}

/** Steps 5–7: the hold outside any transaction, then the `landHold` swap and the old void. */
async function holdRaise(
  deps: PlaceBidDeps,
  placeInput: PlaceBidInput,
  bid: BidRow,
  paymentSource: PaymentSource,
  actor: Actor,
): Promise<RaiseBidResult> {
  const oldId = bid.replaces_bid_id!;
  const result = async (error: RaiseBidError, row: BidRow | null): Promise<RaiseBidResult> => ({
    ok: false,
    error,
    bid: row,
    oldBid: await findBid(deps.db.pool, oldId),
    replayed: false,
  });

  let hold: HoldResult;
  try {
    hold = await deps.paypal.createAuthOrder({
      requestId: orderRequestId(bid.id),
      amountCents: bid.amount_cents,
      paymentSource,
      description: 'Holdfast held bid (raise)',
    });
  } catch (err) {
    hold = {
      kind: 'unknown',
      orderId: null,
      code: err instanceof Error ? `CLIENT_${err.name}` : 'CLIENT_ERROR',
      errorClass: 'RECONCILE',
    };
  }

  // Wallet / card fields: the buyer acts next; `authorizeAndLand` finishes the swap.
  if (hold.kind === 'needs_approval' && isTwoStep(bid.payment_method)) {
    const waiting = await awaitApproval(deps, bid, hold, actorFor(placeInput), null);
    const oldBid = (await findBid(deps.db.pool, oldId))!;
    return waiting.ok
      ? { ok: true, bid: waiting.bid, oldBid, replayed: false, approveUrl: waiting.approveUrl }
      : { ok: false, error: waiting.error, bid: waiting.bid, oldBid, replayed: false };
  }

  switch (hold.kind) {
    case 'held': {
      const landed = await landHold(deps, {
        bidId: bid.id,
        authorizationId: hold.authorizationId,
        authorizedAt: hold.authorizedAt,
        authorizedAmountCents: hold.amountCents,
        authorizationExpiresAt: hold.expiresAt,
        paypalOrderId: hold.orderId,
        replacesBidId: oldId,
        actor,
      });
      if (!landed.ok) return result(await landingError(deps, landed), landed.bid);
      return finishSwap(deps, landed.bid, landed.replaced, oldId, actor);
    }
    case 'needs_approval':
    case 'denied': {
      // The old bid is untouched: it was never locked or changed outside the swap.
      const code = hold.kind === 'denied' ? hold.code : `PAYER_ACTION_REQUIRED:${hold.status}`;
      const failed = await markHoldFailed(deps, bid, code, hold.orderId, actor);
      return result({ code: 'HOLD_FAILED', bidId: bid.id, paypalCode: code }, failed);
    }
    case 'pending':
    case 'unknown': {
      const code = hold.kind === 'pending' ? `AUTHORIZATION_${hold.status}` : hold.code;
      const row = await markNeedsReconcile(deps, bid, code, hold.orderId, actor);
      return result(
        { code: 'PAYPAL_ERROR', bidId: bid.id, paypalCode: code, needsReconcile: true },
        row,
      );
    }
  }
}

/**
 * After a successful swap: void the old hold (`void-<oldBidId>`, left VOIDING for the sweeper on
 * failure) and audit `BID_RAISED`. Shared with the wallet path through `authorizeAndLand`.
 */
export async function finishSwap(
  deps: PlaceBidDeps,
  bid: BidRow,
  replaced: BidRow | null,
  oldId: string,
  actor: Actor,
): Promise<Extract<RaiseBidResult, { ok: true }>> {
  let oldBid = replaced;
  if (replaced) {
    const v = await voidBid(deps, replaced.id, 'REPLACED', actor, { from: ['VOIDING'] });
    oldBid = v.bid;
    if (deps.audit) {
      await deps.db.tx((tx) =>
        deps.audit!(tx, {
          actor,
          action: 'BID_RAISED',
          entity: 'bid',
          entityId: bid.id,
          listingId: bid.listing_id,
          paypalId: bid.paypal_authorization_id,
          requestId: bid.id,
          data: {
            replacesBidId: replaced.id,
            oldCents: replaced.amount_cents,
            newCents: bid.amount_cents,
            raiseCount: bid.raise_count,
            oldVoid: v.outcome,
          },
        }),
      );
    }
  }
  return {
    ok: true,
    bid,
    oldBid: oldBid ?? (await findBid(deps.db.pool, oldId))!,
    replayed: false,
  };
}

/** The key was used before: answer with what that raise became. */
async function replay(
  deps: PlaceBidDeps,
  input: RaiseBidInput,
  old: BidRow,
  prior: BidRow,
  actor: Actor,
  agentInitiated: boolean,
): Promise<RaiseBidResult> {
  const oldBid =
    (prior.replaces_bid_id && (await findBid(deps.db.pool, prior.replaces_bid_id))) || old;
  const fail = (error: RaiseBidError) =>
    ({ ok: false, error, bid: prior, oldBid, replayed: true }) as const;
  if (
    prior.listing_id !== old.listing_id ||
    prior.amount_cents !== input.amountCents ||
    Number(prior.raise_count ?? 0) < 1 ||
    (prior.replaces_bid_id !== null && prior.replaces_bid_id !== old.id)
  ) {
    return fail({ code: 'IDEMPOTENCY_MISMATCH' });
  }
  if (prior.authorized_at) return { ok: true, bid: prior, oldBid, replayed: true };

  switch (prior.status) {
    case 'PENDING_APPROVAL': {
      if (isTwoStep(prior.payment_method) && prior.paypal_order_id) {
        let approveUrl: string | null = null;
        if (prior.payment_method === 'PAYPAL') {
          try {
            approveUrl = (await deps.paypal.getOrder(prior.paypal_order_id)).approveUrl;
          } catch {
            approveUrl = null;
          }
        }
        return { ok: true, bid: prior, oldBid, replayed: true, approveUrl };
      }
      if (!prior.needs_reconcile) return fail({ code: 'IN_PROGRESS', bidId: prior.id });
      // Replay the create with the same request id (VAULT and no-source orders replay, S7).
      if (prior.payment_method === 'VAULT' || isTwoStep(prior.payment_method)) {
        const placeInput = await placeInputFor(deps, input, old, agentInitiated);
        if (!('error' in placeInput)) {
          placeInput.paymentMethod = prior.payment_method as BidPaymentMethod;
          const source = await paymentSourceFor(deps, placeInput);
          if (!('error' in source)) {
            const again = await holdRaise(deps, placeInput, prior, source.paymentSource, actor);
            return { ...again, replayed: true };
          }
        }
      }
      return fail({
        code: 'PAYPAL_ERROR',
        bidId: prior.id,
        paypalCode: prior.error_code ?? 'UNKNOWN',
        needsReconcile: true,
      });
    }
    case 'HOLD_FAILED':
      return fail({
        code: 'HOLD_FAILED',
        bidId: prior.id,
        paypalCode: prior.error_code ?? 'DECLINED',
      });
    case 'VOIDING':
    case 'VOIDED':
      return fail(refusalFromVoid(prior));
    default:
      return fail({
        code: 'STATE_CONFLICT',
        bidId: prior.id,
        reason: prior.status,
        released: false,
      });
  }
}

async function loadListing(q: Queryable, listingId: string): Promise<RaiseListing | null> {
  const res = await q.query(
    `SELECT l.status, l.window_closes_at, l.rounds_end_at, l.current_round, l.product_id,
            p.best_public_price_cents, clock_timestamp() AS db_now
       FROM listings l JOIN products p ON p.id = l.product_id
      WHERE l.id = $1`,
    [listingId],
  );
  return (res.rows[0] as RaiseListing | undefined) ?? null;
}

async function findBid(q: Queryable, bidId: string): Promise<BidRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(bidId)) return null;
  const res = await q.query(`SELECT * FROM bids WHERE id = $1`, [bidId]);
  return (res.rows[0] as BidRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------------------------
// HTTP / tool response (api.md §`POST /bids/:id/raise`). Shared by REST, MCP and agent tools.
// ---------------------------------------------------------------------------------------------

export interface RaisedBidBody {
  bidId: string;
  status: string;
  amountCents: number;
  replacesBidId: string;
  previousAmountCents: number;
  /** The replaced bid now: VOIDED once its hold is released, VOIDING until then (D14 copy). */
  previousStatus: string;
  authorizationId: string | null;
  authorizedAt: string | null;
  raiseCount: number;
  /** Shopper copy once the new hold is HELD (05 §Logic 4); null while waiting for approval. */
  message: string | null;
  /** From the 2nd raise on a chain: "Each raise places a new hold; …". */
  warnSeveralHolds: string | null;
  /**
   * Once per chain, on the 5th raise (HF-038b): "Your bank may show several pending holds for a
   * few days." Null on every other raise.
   */
  warnPendingHolds: string | null;
  /** CARD / PAYPAL waiting for the buyer. */
  orderId?: string;
  approveUrl?: string | null;
}

/** The old bid still counts (HELD, or already in Clear's hands). */
const STANDS = new Set(['HELD', 'WON', 'LOST', 'CAPTURED', 'SHIPPED']);

/** `{ status, body }` for a `raiseBid` result, in the api.md envelope. */
export function raiseBidResponse(result: RaiseBidResult): IdempotentResponse {
  if (result.ok) {
    const { bid, oldBid } = result;
    const raiseCount = Number(bid.raise_count ?? 0);
    const body: RaisedBidBody = {
      bidId: bid.id,
      status: bid.status,
      amountCents: bid.amount_cents,
      replacesBidId: oldBid.id,
      previousAmountCents: oldBid.amount_cents,
      previousStatus: oldBid.status,
      authorizationId: bid.paypal_authorization_id,
      authorizedAt: bid.authorized_at ? bid.authorized_at.toISOString() : null,
      raiseCount,
      message: bid.authorized_at ? raisedMessage(oldBid.amount_cents, bid.amount_cents) : null,
      warnSeveralHolds: severalHoldsWarning(raiseCount),
      warnPendingHolds: pendingHoldsWarning(raiseCount),
    };
    if (bid.status === 'PENDING_APPROVAL' && isTwoStep(bid.payment_method) && bid.paypal_order_id) {
      body.orderId = bid.paypal_order_id;
      if (bid.payment_method === 'PAYPAL') body.approveUrl = result.approveUrl ?? null;
    }
    return { status: 201, body };
  }

  const { error, oldBid } = result;
  const stands = oldBid && STANDS.has(oldBid.status) ? oldBid.amount_cents : null;
  if (error.code === 'PRICE_DROPPED') {
    return {
      status: 422,
      body: errorBody(
        'PRICE_DROPPED',
        `That's above the best public price of ${formatUsd(error.publicPriceCents)}, so the hold would be released. Your bid wasn't raised.`,
        { bidId: error.bidId, publicPriceCents: error.publicPriceCents },
      ),
    };
  }
  const response = bidErrorResponse(error);
  const envelope = response.body as { error: { message: string } };
  if (error.code === 'HOLD_FAILED' && stands !== null) {
    envelope.error.message = raiseFailedMessage(stands);
  } else if (error.code === 'WINDOW_CLOSED' && error.roundsEnded) {
    // Frozen book (D7, HF-038a): the bid page shows the same copy and hides Raise.
    envelope.error.message =
      stands !== null
        ? `${ROUNDS_ENDED_COPY} Your ${formatUsd(stands)} bid still stands.`
        : ROUNDS_ENDED_COPY;
    (envelope.error as Record<string, unknown>).roundsEnded = true;
  } else if (error.code === 'WINDOW_CLOSED') {
    envelope.error.message =
      stands !== null
        ? `Raising is closed for this listing. Your ${formatUsd(stands)} bid still stands.`
        : 'Raising is closed for this listing.';
  } else if (error.code === 'STATE_CONFLICT') {
    envelope.error.message =
      stands !== null && oldBid?.status === 'HELD'
        ? `This bid can't be raised right now. Your ${formatUsd(stands)} bid still stands.`
        : "This bid can't be raised.";
  }
  return response;
}
