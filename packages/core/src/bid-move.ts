import { formatUsd, isBiddable, MAX_AMOUNT_CENTS, MIN_AMOUNT_CENTS } from '@holdfast/shared';
import { audit } from './audit.js';
import {
  bidErrorResponse,
  denialError,
  findByKey,
  landingError,
  markHoldFailed,
  markNeedsReconcile,
  paymentSourceFor,
  refusalFromVoid,
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
 * Move a held bid to another listing (HF-052; features/04 §Logic 3–4, D1, D3, D12). The intent's
 * one live bid leaves one book for another; PayPal can't move a hold, so a move is a new bid with
 * a new hold on the target that replaces the old one, the cross-listing form of a raise:
 *
 * 1. The old bid is the shopper's and HELD; the target is another listing and biddable (D7).
 * 2. `release_if_cheaper` on and the amount above the target product's public price →
 *    `PRICE_DROPPED`, before any hold (M11, as a raise).
 * 3. One transaction (serialized per shopper and target listing): no live bid of the shopper on the
 *    target (D3, `ALREADY_BID`); `mandates.authorize` with the old bid excluded (D12); the old bid
 *    locked and still HELD; `UNIQUE(replaces_bid_id)`, so a second concurrent move of the same bid
 *    is refused here before any PayPal call; insert the new bid PENDING_APPROVAL on the target with
 *    `replaces_bid_id = old.id`, the old bid's intent, mandate and `release_if_cheaper`.
 * 4. The VAULT hold, outside any transaction (INV-1), `PayPal-Request-Id = <newBidId>`. A move is
 *    an agent action under a mandate, so it needs a saved payment method (no wallet step).
 * 5. `landHold` swaps atomically across both listings (D1): both locked FOR SHARE in id order,
 *    target biddable, mandate cap re-checked with the old bid excluded, old HELD→VOIDING
 *    (`REPLACED`), new →HELD. If Clear on the source listing, a cancel or a parallel move won, the
 *    **new** authorization is voided and the old bid stands. `bids_one_held_per_intent` backs the
 *    "one live bid per intent" rule in the database.
 * 6. After COMMIT the old hold is voided with `void-<oldBidId>` (left VOIDING for the sweeper on
 *    failure), and `BID_MOVED` is audited with the reason the agent quotes later.
 */

/** Why the bid moved; stored on `BID_MOVED` so the agent can explain it (features/04 §Logic 4). */
export type MoveReason =
  /** The shopper confirmed a `move_bid` proposal. */
  | 'SHOPPER'
  /** The move rule: another of the intent's books is likelier to clear. */
  | 'BETTER_BOOK';

/** Audit action of the insert transaction. */
export const MOVE_REQUESTED_ACTION = 'BID_MOVE_REQUESTED';
/** Audit action once the swap landed; `data.reason` / `data.why` explain it. */
export const MOVED_ACTION = 'BID_MOVED';

export interface MoveBidInput {
  /** The HELD bid being moved. */
  bidId: string;
  toListingId: string;
  amountCents: number;
  /** The bid must belong to this shopper (else NOT_FOUND). */
  shopperId: string;
  idempotencyKey: string;
  reason: MoveReason;
  /** One sentence for the shopper ("why did you move my bid?"). */
  why?: string | null;
  actor?: Actor;
  /** VAULT `payment_initiator`: `CUSTOMER` when the shopper confirmed, `MERCHANT` for the move rule. */
  initiator?: 'CUSTOMER' | 'MERCHANT';
}

export type MoveBidError =
  PlaceBidError | { code: 'PRICE_DROPPED'; bidId: string; publicPriceCents: number };

export type MoveBidResult =
  | { ok: true; bid: BidRow; oldBid: BidRow; replayed: boolean }
  | {
      ok: false;
      error: MoveBidError;
      /** The new bid, when one was created (HOLD_FAILED, VOIDED …). */
      bid: BidRow | null;
      /** The bid that was to be moved, as it is now. Null only when it was not found. */
      oldBid: BidRow | null;
      replayed: boolean;
    };

interface TargetListing {
  id: string;
  status: string;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  product_id: string;
  best_public_price_cents: number | null;
  db_now: Date;
}

const biddable = (l: TargetListing) =>
  !!l.window_closes_at &&
  isBiddable(
    { status: l.status as never, windowClosesAt: l.window_closes_at, roundsEndAt: l.rounds_end_at },
    l.db_now,
  );

class MoveRefused extends Error {
  constructor(readonly error: MoveBidError) {
    super(error.code);
  }
}

const closed = (amountCents: number): MoveBidError => ({
  code: 'WINDOW_CLOSED',
  bidId: null,
  amountCents,
  released: false,
});

export async function moveBid(deps: PlaceBidDeps, input: MoveBidInput): Promise<MoveBidResult> {
  const actor: Actor = input.actor ?? { type: 'BUYER_AGENT', id: input.shopperId };
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
  const fail = (error: MoveBidError, bid: BidRow | null = null, oldBid: BidRow = old) =>
    ({ ok: false, error, bid, oldBid, replayed: false }) as const;

  const prior = await findByKey(deps.db.pool, input.shopperId, input.idempotencyKey);
  if (prior) return replay(deps, input, old, prior, actor);

  if (old.status !== 'HELD') {
    return fail({
      code: 'STATE_CONFLICT',
      bidId: old.id,
      reason: `BID_${old.status}`,
      released: false,
    });
  }
  if (old.listing_id === input.toListingId) {
    return fail({
      code: 'VALIDATION_ERROR',
      field: 'toListingId',
      message: 'The bid is already on this listing. Raise it instead.',
    });
  }
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents < MIN_AMOUNT_CENTS ||
    input.amountCents > MAX_AMOUNT_CENTS
  ) {
    return fail({ code: 'VALIDATION_ERROR', field: 'amountCents', message: 'Invalid amount.' });
  }
  const target = await loadTarget(deps.db.pool, input.toListingId);
  if (!target) return fail({ code: 'NOT_FOUND', what: 'listing' });
  if (!biddable(target)) return fail(closed(input.amountCents));
  if (
    old.release_if_cheaper &&
    target.best_public_price_cents != null &&
    input.amountCents > target.best_public_price_cents
  ) {
    return fail({
      code: 'PRICE_DROPPED',
      bidId: old.id,
      publicPriceCents: target.best_public_price_cents,
    });
  }

  const placeInput = placeInputFor(input, old, actor);
  const source = await paymentSourceFor(deps, placeInput);
  if ('error' in source) return fail(source.error);

  let inserted: { kind: 'placed' | 'existing'; bid: BidRow };
  try {
    inserted = await deps.db.tx((tx) => insertMove(tx, input, old, actor));
  } catch (err) {
    if (err instanceof MoveRefused) {
      return fail(err.error, null, (await findBid(deps.db.pool, old.id)) ?? old);
    }
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'bids_replaces_bid_id_key') {
      return fail({
        code: 'STATE_CONFLICT',
        bidId: old.id,
        reason: 'MOVE_IN_PROGRESS',
        released: false,
      });
    }
    if (pgErr.code === '23505' && pgErr.constraint === 'bids_shopper_idempotency_key') {
      const other = await findByKey(deps.db.pool, input.shopperId, input.idempotencyKey);
      if (other) return replay(deps, input, old, other, actor);
    }
    throw err;
  }
  if (inserted.kind === 'existing') return replay(deps, input, old, inserted.bid, actor);
  return holdMove(deps, input, inserted.bid, source.paymentSource, actor);
}

function placeInputFor(input: MoveBidInput, old: BidRow, actor: Actor): PlaceBidInput {
  return {
    shopperId: old.shopper_id,
    listingId: input.toListingId,
    amountCents: input.amountCents,
    paymentMethod: 'VAULT',
    mandateId: old.mandate_id,
    intentId: old.intent_id,
    releaseIfCheaper: Boolean(old.release_if_cheaper),
    source: 'BUYER_AGENT',
    idempotencyKey: input.idempotencyKey,
    initiator: input.initiator ?? 'CUSTOMER',
    actor,
  };
}

async function insertMove(
  tx: Tx,
  input: MoveBidInput,
  old: BidRow,
  actor: Actor,
): Promise<{ kind: 'placed' | 'existing'; bid: BidRow }> {
  // Same advisory lock as placeBid on the target: one placement / move per (shopper, listing).
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `bid:${old.shopper_id}:${input.toListingId}`,
  ]);
  const same = await findByKey(tx, old.shopper_id, input.idempotencyKey);
  if (same) return { kind: 'existing', bid: same };

  const target = await loadTarget(tx, input.toListingId);
  if (!target || !biddable(target)) throw new MoveRefused(closed(input.amountCents));

  // D3: one live bid per shopper per listing.
  const live = await tx.query(
    `SELECT id, amount_cents FROM bids
      WHERE listing_id = $1 AND shopper_id = $2 AND status IN ('PENDING_APPROVAL', 'HELD')
      LIMIT 1`,
    [input.toListingId, old.shopper_id],
  );
  const existing = live.rows[0] as { id: string; amount_cents: number } | undefined;
  if (existing) {
    throw new MoveRefused({
      code: 'ALREADY_BID',
      bidId: existing.id,
      amountCents: existing.amount_cents,
    });
  }

  // Lock order: mandate → bids. D12: the moved bid is excluded from the cap.
  if (old.mandate_id) {
    const authorized = await authorize(tx, old.mandate_id, {
      newHoldCents: input.amountCents,
      replacedBidId: old.id,
      productId: target.product_id,
      shopperId: old.shopper_id,
    });
    if (!authorized.ok) {
      throw new MoveRefused(
        denialError(authorized.denial, authorized.mandate?.max_price_cents ?? 0),
      );
    }
  }

  const [current] = await lockBidsById(tx, [old.id]);
  if (!current || current.status !== 'HELD') {
    throw new MoveRefused({
      code: 'STATE_CONFLICT',
      bidId: old.id,
      reason: `BID_${current?.status ?? 'MISSING'}`,
      released: false,
    });
  }

  // UNIQUE(replaces_bid_id), as a raise: a replacement that never held gives the slot back; a
  // live one (in flight) refuses this move before any PayPal call.
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
      throw new MoveRefused({
        code: 'STATE_CONFLICT',
        bidId: old.id,
        reason: 'MOVE_IN_PROGRESS',
        released: false,
      });
    }
    await tx.query(`UPDATE bids SET replaces_bid_id = NULL WHERE id = $1`, [other.id]);
  }

  const res = await tx.query(
    `INSERT INTO bids (listing_id, shopper_id, intent_id, mandate_id, amount_cents, payment_method,
                       source, public_price_at_placement, release_if_cheaper, idempotency_key,
                       replaces_bid_id)
     SELECT $2, o.shopper_id, o.intent_id, o.mandate_id, $3, 'VAULT', 'BUYER_AGENT',
            p.best_public_price_cents, o.release_if_cheaper, $4, o.id
       FROM bids o, listings l JOIN products p ON p.id = l.product_id
      WHERE o.id = $1 AND l.id = $2
     RETURNING *`,
    [old.id, input.toListingId, input.amountCents, input.idempotencyKey],
  );
  const bid = res.rows[0] as BidRow;
  await audit(tx, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    listingId: bid.listing_id,
    entity: 'bid',
    entityId: bid.id,
    action: MOVE_REQUESTED_ACTION,
    requestId: bid.id,
    data: {
      replacesBidId: old.id,
      fromListingId: old.listing_id,
      toListingId: bid.listing_id,
      oldCents: old.amount_cents,
      newCents: bid.amount_cents,
      intentId: old.intent_id,
      reason: input.reason,
    },
  });
  return { kind: 'placed', bid };
}

/** Steps 4–6. */
async function holdMove(
  deps: PlaceBidDeps,
  input: MoveBidInput,
  bid: BidRow,
  paymentSource: PaymentSource,
  actor: Actor,
): Promise<MoveBidResult> {
  const oldId = bid.replaces_bid_id!;
  const result = async (error: MoveBidError, row: BidRow | null): Promise<MoveBidResult> => ({
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
      description: 'Holdfast held bid (move)',
    });
  } catch (err) {
    hold = {
      kind: 'unknown',
      orderId: null,
      code: err instanceof Error ? `CLIENT_${err.name}` : 'CLIENT_ERROR',
      errorClass: 'RECONCILE',
    };
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
      return finishMove(deps, input, landed.bid, landed.replaced, oldId, actor);
    }
    case 'needs_approval':
    case 'denied': {
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

async function finishMove(
  deps: PlaceBidDeps,
  input: MoveBidInput,
  bid: BidRow,
  replaced: BidRow | null,
  oldId: string,
  actor: Actor,
): Promise<MoveBidResult> {
  let oldBid = replaced;
  if (replaced) {
    const v = await voidBid(deps, replaced.id, 'REPLACED', actor, { from: ['VOIDING'] });
    oldBid = v.bid;
    // Always written (not only through deps.audit): `explainIntent` reads these rows.
    await audit(deps.db.pool, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      listingId: bid.listing_id,
      entity: 'bid',
      entityId: bid.id,
      action: MOVED_ACTION,
      paypalId: bid.paypal_authorization_id,
      requestId: bid.id,
      data: {
        replacesBidId: replaced.id,
        fromListingId: replaced.listing_id,
        toListingId: bid.listing_id,
        oldCents: replaced.amount_cents,
        newCents: bid.amount_cents,
        intentId: bid.intent_id,
        reason: input.reason,
        why: input.why ?? null,
        oldVoid: v.outcome,
      },
    });
  }
  return {
    ok: true,
    bid,
    oldBid: oldBid ?? (await findBid(deps.db.pool, oldId))!,
    replayed: false,
  };
}

async function replay(
  deps: PlaceBidDeps,
  input: MoveBidInput,
  old: BidRow,
  prior: BidRow,
  actor: Actor,
): Promise<MoveBidResult> {
  const oldBid =
    (prior.replaces_bid_id && (await findBid(deps.db.pool, prior.replaces_bid_id))) || old;
  const fail = (error: MoveBidError) =>
    ({ ok: false, error, bid: prior, oldBid, replayed: true }) as const;
  if (
    prior.listing_id !== input.toListingId ||
    prior.amount_cents !== input.amountCents ||
    (prior.replaces_bid_id !== null && prior.replaces_bid_id !== old.id)
  ) {
    return fail({ code: 'IDEMPOTENCY_MISMATCH' });
  }
  if (prior.authorized_at) return { ok: true, bid: prior, oldBid, replayed: true };
  switch (prior.status) {
    case 'PENDING_APPROVAL': {
      if (!prior.needs_reconcile) return fail({ code: 'IN_PROGRESS', bidId: prior.id });
      // Replay the VAULT create with the same request id (S7).
      const source = await paymentSourceFor(deps, placeInputFor(input, old, actor));
      if ('error' in source) return fail(source.error);
      return {
        ...(await holdMove(deps, input, prior, source.paymentSource, actor)),
        replayed: true,
      };
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

async function loadTarget(q: Queryable, listingId: string): Promise<TargetListing | null> {
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) return null;
  const res = await q.query(
    `SELECT l.id, l.status, l.window_closes_at, l.rounds_end_at, l.product_id,
            p.best_public_price_cents, clock_timestamp() AS db_now
       FROM listings l JOIN products p ON p.id = l.product_id
      WHERE l.id = $1`,
    [listingId],
  );
  return (res.rows[0] as TargetListing | undefined) ?? null;
}

async function findBid(q: Queryable, bidId: string): Promise<BidRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(bidId)) return null;
  const res = await q.query(`SELECT * FROM bids WHERE id = $1`, [bidId]);
  return (res.rows[0] as BidRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Response (agent confirm / tools), in the api.md envelope.
// ---------------------------------------------------------------------------------------------

export interface MovedBidBody {
  bidId: string;
  status: string;
  listingId: string;
  amountCents: number;
  replacesBidId: string;
  previousListingId: string;
  previousAmountCents: number;
  /** VOIDED once the old hold is released, VOIDING until then (D14 copy). */
  previousStatus: string;
  authorizationId: string | null;
  message: string | null;
}

/** The old bid still counts (HELD, or already in Clear's hands). */
const STANDS = new Set(['HELD', 'WON', 'LOST', 'CAPTURED', 'SHIPPED']);

export function moveBidResponse(result: MoveBidResult): IdempotentResponse {
  if (result.ok) {
    const { bid, oldBid } = result;
    const body: MovedBidBody = {
      bidId: bid.id,
      status: bid.status,
      listingId: bid.listing_id,
      amountCents: bid.amount_cents,
      replacesBidId: oldBid.id,
      previousListingId: oldBid.listing_id,
      previousAmountCents: oldBid.amount_cents,
      previousStatus: oldBid.status,
      authorizationId: bid.paypal_authorization_id,
      message: bid.authorized_at
        ? `Moved: ${formatUsd(bid.amount_cents)} is held in the new book. The old ${formatUsd(oldBid.amount_cents)} hold is released and won't be charged.`
        : null,
    };
    return { status: 201, body };
  }
  const { error, oldBid } = result;
  if (error.code === 'PRICE_DROPPED') {
    return {
      status: 422,
      body: errorBody(
        'PRICE_DROPPED',
        `That's above the best public price of ${formatUsd(error.publicPriceCents)}, so the hold would be released. Your bid wasn't moved.`,
        { bidId: error.bidId, publicPriceCents: error.publicPriceCents },
      ),
    };
  }
  const response = bidErrorResponse(error);
  const stands = oldBid && STANDS.has(oldBid.status) ? oldBid.amount_cents : null;
  if (stands !== null && error.code !== 'VALIDATION_ERROR' && error.code !== 'NOT_FOUND') {
    const envelope = response.body as { error: { message: string } };
    envelope.error.message = `Couldn't move your bid. Your ${formatUsd(stands)} bid still stands.`;
  }
  return response;
}
