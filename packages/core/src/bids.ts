import {
  isBiddable,
  releasedHoldMessage,
  type BidSource,
  type ErrorCode,
  type VoidReason,
} from '@holdfast/shared';
import type { Tx } from './db.js';
import { errorBody, type IdempotentResponse } from './idempotency.js';
import { defaultMandateCheck, landHold, type LandHoldResult } from './money/land-hold.js';
import type { Actor, MandateRefusal, MoneyDeps } from './money/deps.js';
import { lockMandate } from './money/locks.js';
import type { BidRow, MandateRow } from './money/rows.js';
import { transition } from './money/transition.js';
import { orderRequestId } from './paypal/ids.js';
import type { HoldResult, PayPalClient, PaymentSource, TestCard } from './paypal/types.js';

/**
 * Bid service core (HF-014a; api.md §`POST /bids`, features/03 §Logic 4, data-model §Locking
 * rules 3–5). `placeBid()` is the one entry point REST, the buyer agent, MCP, the seeder and live
 * rounds call to create a real PayPal hold:
 *
 * 1. Idempotency: a bid with this shopper's `idempotency_key` is replayed from its row
 *    (`unique(shopper_id, idempotency_key)`); HTTP routes also wrap the call in HF-003b's
 *    `idempotent()` (request hash + stored response).
 * 2. `isBiddable` (D7) else `WINDOW_CLOSED`, no PayPal call.
 * 3. One transaction: `pg_advisory_xact_lock(shopper, listing)`; a live bid → `ALREADY_BID` (D3);
 *    mandate `FOR UPDATE` + cap (D12); insert the bid PENDING_APPROVAL; audit `BID_PENDING`.
 * 4. `pp.createAuthOrder` outside any transaction (INV-1) with `PayPal-Request-Id = bid.id` (D5).
 * 5. Only an authorization `CREATED` is a hold (M6): `landHold` (D1) flips it HELD, re-checking
 *    the listing and mandate; a refusal voids the new authorization (B2). `bid.held` is emitted
 *    with `pg_notify` on that COMMIT.
 *
 * Declines end the bid HOLD_FAILED (terminal; retry = a new bid row with a new key). A create with
 * no answer after the client's same-id retries leaves the bid PENDING_APPROVAL with
 * `needs_reconcile = true` for the HF-034 sweeper (or a same-key retry) to replay with the same id.
 */

/** `bids.payment_method`. CARD and PAYPAL (card fields, wallet) are the HF-014b two-step flows. */
export type BidPaymentMethod = 'VAULT' | 'TEST_CARD' | 'CARD' | 'PAYPAL';

/**
 * Card fields and the PayPal wallet: the order is created with no card data, the buyer acts in the
 * browser (card-fields submit, maybe 3DS, or wallet approval), then `authorizeAndLand` (HF-014b).
 */
export function isTwoStep(method: unknown): method is 'CARD' | 'PAYPAL' {
  return method === 'CARD' || method === 'PAYPAL';
}

/** Where PayPal sends the buyer after wallet approval (or a 3DS redirect): `GET /api/bids/return`. */
export const BID_RETURN_PATH = '/api/bids/return';

/** PayPal appends `token=<orderId>` to both URLs. */
export function approvalUrls(appBaseUrl: string): { returnUrl: string; cancelUrl: string } {
  const returnUrl = new URL(BID_RETURN_PATH, appBaseUrl).toString();
  return { returnUrl, cancelUrl: `${returnUrl}?cancelled=1` };
}

/** PayPal's published sandbox Visa (S1, S7 step 6). Server-side only; never from request input. */
export const SANDBOX_TEST_CARD: TestCard = {
  number: '4111111111111111',
  expiry: '2030-12',
  security_code: '123',
  name: 'Holdfast Sandbox',
};

/** Statuses that count as "the shopper already has a bid here" (D3). */
const LIVE_BID_STATUSES = ['PENDING_APPROVAL', 'HELD'] as const;

/** A cached public price older than this is refreshed after the response (api.md). */
export const PUBLIC_OFFER_MAX_AGE_MS = 10 * 60 * 1000;

export interface PlaceBidDeps extends MoneyDeps {
  paypal: PayPalClient;
  /**
   * Allow `TEST_CARD` (raw card, S1 style): the seed (HF-045) and the labelled sandbox test-card
   * button (HF-014b Part 1). Wire it to sandbox / stub + `DEMO_MODE` only.
   */
  allowTestCard?: boolean;
  /** The card a `TEST_CARD` hold uses. Default `SANDBOX_TEST_CARD`. */
  testCard?: TestCard;
  /**
   * Public origin of the app (`APP_BASE_URL`), for the wallet / 3DS `return_url` and `cancel_url`.
   * CARD and PAYPAL bids are refused without it.
   */
  appBaseUrl?: string;
  /**
   * Refresh `products.best_public_*` (HF-009). Called without awaiting, after the bid is decided,
   * when the cached price is missing or older than 10 min. Never on the money path.
   */
  refreshPublicOffer?: (productId: string) => Promise<unknown>;
}

export interface PlaceBidInput {
  shopperId: string;
  listingId: string;
  amountCents: number;
  paymentMethod: BidPaymentMethod;
  /** The mandate that authorizes this bid (D12); offer-page bids carry none unless opted in. */
  mandateId?: string | null;
  intentId?: string | null;
  releaseIfCheaper?: boolean;
  source: BidSource;
  utmSource?: string | null;
  idempotencyKey: string;
  /**
   * VAULT `stored_credential.payment_initiator`: `CUSTOMER` when a human is present (default);
   * `MERCHANT` only for rounds auto-raise and roll.
   */
  initiator?: 'CUSTOMER' | 'MERCHANT';
  /** Which vault `shoppers.paypal_vault_id` holds. Default `card` (S2); `wallet` per S7 step 4. */
  vaultKind?: 'card' | 'wallet';
  /** Audit actor. Default: the shopper (or BUYER_AGENT / MCP_CLIENT by source). */
  actor?: Actor;
}

export interface PublicOffer {
  merchant: string | null;
  priceCents: number;
  url: string | null;
  updatedAt: string | null;
}

export type PlaceBidError =
  | { code: 'NOT_FOUND'; what: 'listing' | 'shopper' | 'bid' }
  | { code: 'VALIDATION_ERROR'; field: string; message: string }
  | { code: 'IDEMPOTENCY_MISMATCH' }
  /**
   * The first request with this key is still waiting on PayPal, or (`reason: NOT_APPROVED`) the
   * buyer has not approved / submitted the card yet. Not stored, so a retry can succeed.
   */
  | { code: 'IN_PROGRESS'; bidId: string; reason?: 'NOT_APPROVED' }
  /** Not biddable (D7). `released`: a hold was created and then voided by `landHold`. */
  | { code: 'WINDOW_CLOSED'; bidId: string | null; amountCents: number; released: boolean }
  | { code: 'ALREADY_BID'; bidId: string; amountCents: number }
  | { code: 'MANDATE_EXCEEDED'; bidId: string | null; released: boolean }
  | { code: 'MANDATE_PAUSED'; bidId: string | null; released: boolean }
  /** Declined, 3DS on a vault, or a non-CREATED authorization: bid HOLD_FAILED (terminal). */
  | { code: 'HOLD_FAILED'; bidId: string; paypalCode: string }
  /** PayPal gave no usable answer: bid PENDING_APPROVAL + `needs_reconcile` (M6). */
  | { code: 'PAYPAL_ERROR'; bidId: string; paypalCode: string; needsReconcile: true }
  /** Any other refusal after the hold landed (voided): `reason` is the `landHold` failure. */
  | { code: 'STATE_CONFLICT'; bidId: string; reason: string; released: boolean };

export type PlaceBidResult =
  | {
      ok: true;
      bid: BidRow;
      replayed: boolean;
      publicOffer: PublicOffer | null;
      /** PAYPAL bids waiting for the buyer: the `rel=payer-action` link (HF-014b). */
      approveUrl?: string | null;
    }
  | {
      ok: false;
      error: PlaceBidError;
      bid: BidRow | null;
      replayed: boolean;
      publicOffer: PublicOffer | null;
    };

interface ListingSnapshot {
  id: string;
  status: string;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  db_now: Date;
  product_id: string;
  best_public_price_cents: number | null;
  best_public_offer_url: string | null;
  best_public_merchant: string | null;
  price_updated_at: Date | null;
}

const biddable = (
  l: Pick<ListingSnapshot, 'status' | 'window_closes_at' | 'rounds_end_at'>,
  now: Date,
) =>
  !!l.window_closes_at &&
  isBiddable(
    { status: l.status as never, windowClosesAt: l.window_closes_at, roundsEndAt: l.rounds_end_at },
    now,
  );

function actorFor(input: PlaceBidInput): Actor {
  if (input.actor) return input.actor;
  if (input.source === 'BUYER_AGENT') return { type: 'BUYER_AGENT', id: input.shopperId };
  if (input.source === 'MCP') return { type: 'MCP_CLIENT', id: input.shopperId };
  if (input.source === 'SIM') return { type: 'SYSTEM', id: null };
  return { type: 'SHOPPER', id: input.shopperId };
}

/** Thrown inside the placement transaction to roll back the inserted bid. */
class PlacementRefused extends Error {
  constructor(readonly error: PlaceBidError) {
    super(error.code);
  }
}

export async function placeBid(deps: PlaceBidDeps, input: PlaceBidInput): Promise<PlaceBidResult> {
  const listing = await loadListing(deps, input.listingId);
  const publicOffer = listing ? publicOfferOf(listing) : null;
  const result = await place(deps, input, listing, publicOffer);
  if (listing) maybeRefreshPublicOffer(deps, listing);
  return result;
}

async function place(
  deps: PlaceBidDeps,
  input: PlaceBidInput,
  listing: ListingSnapshot | null,
  publicOffer: PublicOffer | null,
): Promise<PlaceBidResult> {
  const fail = (error: PlaceBidError, bid: BidRow | null = null, replayed = false) =>
    ({ ok: false, error, bid, replayed, publicOffer }) as const;

  // 1. Idempotency: the bid row is the record of what this key did.
  const prior = await findByKey(deps.db.pool, input.shopperId, input.idempotencyKey);
  if (prior) return replay(deps, input, prior, publicOffer);

  if (!listing) return fail({ code: 'NOT_FOUND', what: 'listing' });

  // 2. D7, on DB time. No PayPal call.
  if (!biddable(listing, listing.db_now)) {
    return fail({
      code: 'WINDOW_CLOSED',
      bidId: null,
      amountCents: input.amountCents,
      released: false,
    });
  }

  const source = await paymentSourceFor(deps, input);
  if ('error' in source) return fail(source.error);

  // 3. Placement transaction.
  let placed: { kind: 'placed'; bid: BidRow } | { kind: 'existing'; bid: BidRow };
  try {
    placed = await deps.db.tx((tx) => insertPending(deps, tx, input));
  } catch (err) {
    if (err instanceof PlacementRefused) return fail(err.error);
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'bids_shopper_idempotency_key') {
      // The same key was used concurrently for another listing.
      const other = await findByKey(deps.db.pool, input.shopperId, input.idempotencyKey);
      if (other) return replay(deps, input, other, publicOffer);
    }
    throw err;
  }
  if (placed.kind === 'existing') return replay(deps, input, placed.bid, publicOffer);

  return hold(deps, input, placed.bid, source.paymentSource, publicOffer);
}

/** Steps 4–6: the PayPal call outside any transaction, then `landHold` or the failure state. */
async function hold(
  deps: PlaceBidDeps,
  input: PlaceBidInput,
  bid: BidRow,
  paymentSource: PaymentSource,
  publicOffer: PublicOffer | null,
): Promise<PlaceBidResult> {
  const actor = actorFor(input);
  const fail = (error: PlaceBidError, row: BidRow | null) =>
    ({ ok: false, error, bid: row, replayed: false, publicOffer }) as const;

  let result: HoldResult;
  try {
    result = await deps.paypal.createAuthOrder({
      requestId: orderRequestId(bid.id),
      amountCents: bid.amount_cents,
      paymentSource,
      description: 'Holdfast held bid',
    });
  } catch (err) {
    // The client answers network failures as `unknown`; a throw is unexpected. Whether PayPal saw
    // the request is unknown, so reconcile with the same id instead of guessing.
    result = {
      kind: 'unknown',
      orderId: null,
      code: err instanceof Error ? `CLIENT_${err.name}` : 'CLIENT_ERROR',
      errorClass: 'RECONCILE',
    };
  }

  // CARD / PAYPAL: the buyer acts next (card-fields submit or wallet approval).
  if (result.kind === 'needs_approval' && isTwoStep(bid.payment_method)) {
    return awaitApproval(deps, bid, result, actor, publicOffer);
  }

  switch (result.kind) {
    case 'held': {
      const landed = await landHold(deps, {
        bidId: bid.id,
        authorizationId: result.authorizationId,
        authorizedAt: result.authorizedAt,
        authorizedAmountCents: result.amountCents,
        authorizationExpiresAt: result.expiresAt,
        paypalOrderId: result.orderId,
        actor,
      });
      return landed.ok
        ? { ok: true, bid: landed.bid, replayed: false, publicOffer }
        : fail(await landingError(deps, landed), landed.bid);
    }
    case 'needs_approval':
    case 'denied': {
      // VAULT / TEST_CARD authorize at create: a buyer step (3DS on a vault) is a failed hold too.
      const code =
        result.kind === 'denied' ? result.code : `PAYER_ACTION_REQUIRED:${result.status}`;
      const failed = await markHoldFailed(deps, bid, code, result.orderId, actor);
      return fail({ code: 'HOLD_FAILED', bidId: bid.id, paypalCode: code }, failed);
    }
    case 'pending':
    case 'unknown': {
      // `pending`: an authorization that is not CREATED is not a hold (M6); reconcile it.
      const code = result.kind === 'pending' ? `AUTHORIZATION_${result.status}` : result.code;
      const row = await markNeedsReconcile(deps, bid, code, result.orderId, actor);
      return fail(
        { code: 'PAYPAL_ERROR', bidId: bid.id, paypalCode: code, needsReconcile: true },
        row,
      );
    }
  }
}

/**
 * CARD / PAYPAL: the order exists and waits for the buyer. The bid stays PENDING_APPROVAL with
 * `paypal_order_id` (how `GET /bids/return?token=` finds it); `authorizeAndLand` takes it from here.
 */
async function awaitApproval(
  deps: PlaceBidDeps,
  bid: BidRow,
  result: Extract<HoldResult, { kind: 'needs_approval' }>,
  actor: Actor,
  publicOffer: PublicOffer | null,
): Promise<PlaceBidResult> {
  if (bid.payment_method === 'PAYPAL' && !result.approveUrl) {
    // Nowhere to send the buyer: reconcile with the same request id (S7: no-source replays return
    // the same order, links included).
    const row = await markNeedsReconcile(deps, bid, 'NO_APPROVE_URL', result.orderId, actor);
    return {
      ok: false,
      error: {
        code: 'PAYPAL_ERROR',
        bidId: bid.id,
        paypalCode: 'NO_APPROVE_URL',
        needsReconcile: true,
      },
      bid: row,
      replayed: false,
      publicOffer,
    };
  }
  const row = await deps.db.tx(async (tx) => {
    const res = await tx.query(
      `UPDATE bids SET paypal_order_id = $2, needs_reconcile = false, error_code = NULL
        WHERE id = $1 AND status = 'PENDING_APPROVAL' RETURNING *`,
      [bid.id, result.orderId],
    );
    const updated = res.rows[0] as BidRow | undefined;
    if (updated) {
      await deps.audit?.(tx, {
        actor,
        action: 'BID_APPROVAL_REQUIRED',
        entity: 'bid',
        entityId: updated.id,
        listingId: updated.listing_id,
        paypalId: result.orderId,
        requestId: updated.id,
        data: { paymentMethod: updated.payment_method, orderStatus: result.status },
      });
    }
    return updated ?? (await findById(tx, bid.id));
  });
  return {
    ok: true,
    bid: row,
    replayed: false,
    publicOffer,
    approveUrl: row.payment_method === 'PAYPAL' ? result.approveUrl : null,
  };
}

/** The approval link of a waiting PAYPAL bid, for a replayed `POST /bids`. */
async function approveUrlOf(deps: PlaceBidDeps, bid: BidRow): Promise<string | null> {
  if (bid.payment_method !== 'PAYPAL' || !bid.paypal_order_id) return null;
  try {
    return (await deps.paypal.getOrder(bid.paypal_order_id)).approveUrl;
  } catch {
    return null;
  }
}

async function insertPending(
  deps: PlaceBidDeps,
  tx: Tx,
  input: PlaceBidInput,
): Promise<{ kind: 'placed'; bid: BidRow } | { kind: 'existing'; bid: BidRow }> {
  // One placement per (shopper, listing) at a time: two tabs serialize here.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `bid:${input.shopperId}:${input.listingId}`,
  ]);

  const same = await findByKey(tx, input.shopperId, input.idempotencyKey);
  if (same) return { kind: 'existing', bid: same };

  const res = await tx.query(
    `SELECT status, window_closes_at, rounds_end_at, clock_timestamp() AS db_now
       FROM listings WHERE id = $1`,
    [input.listingId],
  );
  const listing = res.rows[0] as
    Pick<ListingSnapshot, 'status' | 'window_closes_at' | 'rounds_end_at' | 'db_now'> | undefined;
  if (!listing || !biddable(listing, listing.db_now)) {
    throw new PlacementRefused({
      code: 'WINDOW_CLOSED',
      bidId: null,
      amountCents: input.amountCents,
      released: false,
    });
  }

  const live = await tx.query(
    `SELECT id, amount_cents FROM bids
      WHERE listing_id = $1 AND shopper_id = $2 AND status = ANY($3::text[])
      ORDER BY placed_at DESC LIMIT 1`,
    [input.listingId, input.shopperId, LIVE_BID_STATUSES],
  );
  const existing = live.rows[0] as { id: string; amount_cents: number } | undefined;
  if (existing) {
    throw new PlacementRefused({
      code: 'ALREADY_BID',
      bidId: existing.id,
      amountCents: existing.amount_cents,
    });
  }

  if (input.intentId) {
    const intent = await tx.query(`SELECT 1 FROM intents WHERE id = $1 AND shopper_id = $2`, [
      input.intentId,
      input.shopperId,
    ]);
    if (!intent.rowCount) {
      throw new PlacementRefused({
        code: 'VALIDATION_ERROR',
        field: 'intentId',
        message: 'Unknown intent.',
      });
    }
  }

  // Lock order: (listing, not locked here) → mandate → bids.
  let mandate: MandateRow | null = null;
  if (input.mandateId) {
    mandate = await lockMandate(tx, input.mandateId);
    if (!mandate || mandate.shopper_id !== input.shopperId) {
      throw new PlacementRefused({
        code: 'VALIDATION_ERROR',
        field: 'mandateId',
        message: 'Unknown mandate.',
      });
    }
  }

  const inserted = await tx.query(
    `INSERT INTO bids (listing_id, shopper_id, intent_id, mandate_id, amount_cents, payment_method,
                       source, public_price_at_placement, release_if_cheaper, utm_source,
                       idempotency_key)
     SELECT $1, $2, $3, $4, $5, $6, $7, p.best_public_price_cents, $8, $9, $10
       FROM listings l JOIN products p ON p.id = l.product_id
      WHERE l.id = $1
     RETURNING *`,
    [
      input.listingId,
      input.shopperId,
      input.intentId ?? null,
      input.mandateId ?? null,
      input.amountCents,
      input.paymentMethod,
      input.source,
      input.releaseIfCheaper ?? true,
      input.utmSource ?? null,
      input.idempotencyKey,
    ],
  );
  const bid = inserted.rows[0] as BidRow;

  // D12: the PENDING_APPROVAL row is already in the sum, under the mandate lock.
  if (mandate) {
    const check = deps.mandateCheck ?? defaultMandateCheck;
    const refusal = await check(tx, { mandate, bid, replacesBidId: null, now: listing.db_now });
    if (refusal) throw new PlacementRefused(mandateError(refusal, null, false));
  }

  await deps.audit?.(tx, {
    actor: actorFor(input),
    action: 'BID_PENDING',
    entity: 'bid',
    entityId: bid.id,
    listingId: bid.listing_id,
    requestId: bid.id,
    data: {
      amountCents: bid.amount_cents,
      paymentMethod: input.paymentMethod,
      source: input.source,
      mandateId: input.mandateId ?? null,
    },
  });
  return { kind: 'placed', bid };
}

function mandateError(
  refusal: MandateRefusal,
  bidId: string | null,
  released: boolean,
): PlaceBidError {
  return refusal === 'MANDATE_CAP'
    ? { code: 'MANDATE_EXCEEDED', bidId, released }
    : { code: 'MANDATE_PAUSED', bidId, released };
}

/** @internal Shared with `authorizeAndLand`. */
export async function landingError(
  deps: PlaceBidDeps,
  landed: Extract<LandHoldResult, { ok: false }>,
): Promise<PlaceBidError> {
  const { bid, voided: released } = landed;
  switch (landed.reason) {
    case 'WINDOW_CLOSED':
      return { code: 'WINDOW_CLOSED', bidId: bid.id, amountCents: bid.amount_cents, released };
    case 'MANDATE_CAP':
    case 'MANDATE_PAUSED':
      return mandateError(landed.reason, bid.id, released);
    case 'ALREADY_BID': {
      const held = await deps.db.pool.query(
        `SELECT id, amount_cents FROM bids
          WHERE listing_id = $1 AND shopper_id = $2 AND status = 'HELD' LIMIT 1`,
        [bid.listing_id, bid.shopper_id],
      );
      const row = held.rows[0] as { id: string; amount_cents: number } | undefined;
      if (row) return { code: 'ALREADY_BID', bidId: row.id, amountCents: row.amount_cents };
      return { code: 'STATE_CONFLICT', bidId: bid.id, reason: landed.reason, released };
    }
    default:
      return { code: 'STATE_CONFLICT', bidId: bid.id, reason: landed.reason, released };
  }
}

/** @internal Shared with `authorizeAndLand`. */
export async function markHoldFailed(
  deps: PlaceBidDeps,
  bid: BidRow,
  code: string,
  orderId: string | null,
  actor: Actor,
): Promise<BidRow> {
  return deps.db.tx(async (tx) => {
    const row = await transition<'bids', BidRow>(
      tx,
      'bids',
      bid.id,
      'PENDING_APPROVAL',
      'HOLD_FAILED',
      { error_code: code, paypal_order_id: orderId ?? undefined, needs_reconcile: false },
    );
    if (row) {
      await deps.audit?.(tx, {
        actor,
        action: 'BID_HOLD_FAILED',
        entity: 'bid',
        entityId: row.id,
        listingId: row.listing_id,
        paypalId: orderId,
        requestId: row.id,
        data: { code },
      });
    }
    return row ?? (await findById(tx, bid.id));
  });
}

/** @internal Shared with `authorizeAndLand`. */
export async function markNeedsReconcile(
  deps: PlaceBidDeps,
  bid: BidRow,
  code: string,
  orderId: string | null,
  actor: Actor,
): Promise<BidRow> {
  return deps.db.tx(async (tx) => {
    const res = await tx.query(
      `UPDATE bids SET needs_reconcile = true, error_code = $2,
                       paypal_order_id = COALESCE($3, paypal_order_id)
        WHERE id = $1 AND status = 'PENDING_APPROVAL' RETURNING *`,
      [bid.id, code, orderId],
    );
    const row = res.rows[0] as BidRow | undefined;
    if (row) {
      await deps.audit?.(tx, {
        actor,
        action: 'BID_NEEDS_RECONCILE',
        entity: 'bid',
        entityId: row.id,
        listingId: row.listing_id,
        paypalId: orderId,
        requestId: row.id,
        data: { code },
      });
    }
    return row ?? (await findById(tx, bid.id));
  });
}

/**
 * The key was used before: answer with what that bid became. A bid that is still waiting for
 * reconciliation is retried with the same PayPal-Request-Id (VAULT only: a raw-card replay is
 * always refused, S7).
 */
async function replay(
  deps: PlaceBidDeps,
  input: PlaceBidInput,
  bid: BidRow,
  publicOffer: PublicOffer | null,
): Promise<PlaceBidResult> {
  const fail = (error: PlaceBidError) =>
    ({ ok: false, error, bid, replayed: true, publicOffer }) as const;
  if (
    bid.listing_id !== input.listingId ||
    bid.amount_cents !== input.amountCents ||
    bid.payment_method !== input.paymentMethod
  ) {
    return fail({ code: 'IDEMPOTENCY_MISMATCH' });
  }
  // A hold landed (authorized_at is only written by landHold): replay success, current status.
  if (bid.authorized_at) return { ok: true, bid, replayed: true, publicOffer };

  switch (bid.status) {
    case 'PENDING_APPROVAL': {
      // CARD / PAYPAL: the order was created and waits for the buyer; answer as the first time.
      if (isTwoStep(bid.payment_method) && bid.paypal_order_id) {
        return {
          ok: true,
          bid,
          replayed: true,
          publicOffer,
          approveUrl: await approveUrlOf(deps, bid),
        };
      }
      if (!bid.needs_reconcile) return fail({ code: 'IN_PROGRESS', bidId: bid.id });
      // VAULT and no-source (card fields, wallet) creates replay with the same id (S7).
      if (bid.payment_method === 'VAULT' || isTwoStep(bid.payment_method)) {
        const source = await paymentSourceFor(deps, input);
        if (!('error' in source)) {
          const again = await hold(deps, input, bid, source.paymentSource, publicOffer);
          return { ...again, replayed: true };
        }
      }
      return fail({
        code: 'PAYPAL_ERROR',
        bidId: bid.id,
        paypalCode: bid.error_code ?? 'UNKNOWN',
        needsReconcile: true,
      });
    }
    case 'HOLD_FAILED':
      return fail({ code: 'HOLD_FAILED', bidId: bid.id, paypalCode: bid.error_code ?? 'DECLINED' });
    case 'VOIDING':
    case 'VOIDED':
      return fail(refusalFromVoid(bid));
    default:
      return fail({ code: 'STATE_CONFLICT', bidId: bid.id, reason: bid.status, released: false });
  }
}

/** @internal Shared with `authorizeAndLand`. */
export function refusalFromVoid(bid: BidRow): PlaceBidError {
  const released = bid.status === 'VOIDED';
  const reason: VoidReason | null = bid.void_reason;
  if (reason === 'WINDOW_CLOSED') {
    return { code: 'WINDOW_CLOSED', bidId: bid.id, amountCents: bid.amount_cents, released };
  }
  if (reason === 'MANDATE_PAUSED') {
    // landHold records both mandate refusals as MANDATE_PAUSED; error_code keeps which.
    return mandateError(
      bid.error_code === 'MANDATE_CAP' ? 'MANDATE_CAP' : 'MANDATE_PAUSED',
      bid.id,
      released,
    );
  }
  return {
    code: 'STATE_CONFLICT',
    bidId: bid.id,
    reason: bid.error_code ?? reason ?? bid.status,
    released,
  };
}

/** Build the PayPal payment source. Raw card data comes only from server config, never input. */
async function paymentSourceFor(
  deps: PlaceBidDeps,
  input: PlaceBidInput,
): Promise<{ paymentSource: PaymentSource } | { error: PlaceBidError }> {
  const res = await deps.db.pool.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [
    input.shopperId,
  ]);
  const shopper = res.rows[0] as { paypal_vault_id: string | null } | undefined;
  if (!shopper) return { error: { code: 'NOT_FOUND', what: 'shopper' } };

  switch (input.paymentMethod) {
    case 'VAULT': {
      if (!shopper.paypal_vault_id) {
        return {
          error: {
            code: 'VALIDATION_ERROR',
            field: 'paymentMethod',
            message: 'There is no saved payment method. Pay with PayPal or a card first.',
          },
        };
      }
      return {
        paymentSource:
          input.vaultKind === 'wallet'
            ? { kind: 'wallet_vault', vaultId: shopper.paypal_vault_id }
            : {
                kind: 'card_vault',
                vaultId: shopper.paypal_vault_id,
                initiator: input.initiator ?? 'CUSTOMER',
              },
      };
    }
    case 'TEST_CARD':
      if (!deps.allowTestCard) {
        return {
          error: {
            code: 'VALIDATION_ERROR',
            field: 'paymentMethod',
            message: 'The sandbox test card is available only in the demo.',
          },
        };
      }
      return { paymentSource: { kind: 'test_card', card: deps.testCard ?? SANDBOX_TEST_CARD } };
    case 'CARD':
    case 'PAYPAL': {
      // HF-014b two-step flows: no card data here; the browser acts, then `/bids/:id/authorize`.
      if (!deps.appBaseUrl) {
        return {
          error: {
            code: 'VALIDATION_ERROR',
            field: 'paymentMethod',
            message: 'This payment method is not available right now.',
          },
        };
      }
      const urls = approvalUrls(deps.appBaseUrl);
      return {
        paymentSource:
          input.paymentMethod === 'PAYPAL'
            ? { kind: 'wallet', ...urls, brandName: 'Holdfast' }
            : { kind: 'card_fields', ...urls },
      };
    }
  }
}

async function loadListing(deps: PlaceBidDeps, listingId: string): Promise<ListingSnapshot | null> {
  const res = await deps.db.pool.query(
    `SELECT l.id, l.status, l.window_closes_at, l.rounds_end_at, clock_timestamp() AS db_now,
            l.product_id, p.best_public_price_cents, p.best_public_offer_url,
            p.best_public_merchant, p.price_updated_at
       FROM listings l JOIN products p ON p.id = l.product_id
      WHERE l.id = $1`,
    [listingId],
  );
  return (res.rows[0] as ListingSnapshot | undefined) ?? null;
}

function publicOfferOf(l: ListingSnapshot): PublicOffer | null {
  if (l.best_public_price_cents == null) return null;
  return {
    merchant: l.best_public_merchant,
    priceCents: l.best_public_price_cents,
    url: l.best_public_offer_url,
    updatedAt: l.price_updated_at ? l.price_updated_at.toISOString() : null,
  };
}

function maybeRefreshPublicOffer(deps: PlaceBidDeps, l: ListingSnapshot): void {
  if (!deps.refreshPublicOffer) return;
  const fresh =
    l.price_updated_at &&
    l.db_now.getTime() - l.price_updated_at.getTime() < PUBLIC_OFFER_MAX_AGE_MS;
  if (fresh) return;
  // Fire and forget: a stale anchor never blocks or fails a bid.
  void deps.refreshPublicOffer(l.product_id).catch(() => undefined);
}

async function findByKey(
  q: Pick<Tx, 'query'>,
  shopperId: string,
  key: string,
): Promise<BidRow | null> {
  const res = await q.query(`SELECT * FROM bids WHERE shopper_id = $1 AND idempotency_key = $2`, [
    shopperId,
    key,
  ]);
  return (res.rows[0] as BidRow | undefined) ?? null;
}

async function findById(q: Pick<Tx, 'query'>, bidId: string): Promise<BidRow> {
  const res = await q.query(`SELECT * FROM bids WHERE id = $1`, [bidId]);
  return res.rows[0] as BidRow;
}

// ---------------------------------------------------------------------------------------------
// HTTP / tool response (api.md §`POST /bids`). Shared by REST, MCP and the agent tools.
// ---------------------------------------------------------------------------------------------

export interface PlacedBidBody {
  bidId: string;
  status: string;
  amountCents: number;
  authorizationId: string | null;
  authorizedAt: string | null;
  publicOffer: PublicOffer | null;
  /** CARD / PAYPAL waiting for the buyer: the order the card fields submit against. */
  orderId?: string;
  /** PAYPAL waiting for the buyer: the `rel=payer-action` link. */
  approveUrl?: string | null;
}

const ERROR_HTTP: Record<PlaceBidError['code'], { status: number; code: ErrorCode }> = {
  NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  VALIDATION_ERROR: { status: 400, code: 'VALIDATION_ERROR' },
  IDEMPOTENCY_MISMATCH: { status: 422, code: 'IDEMPOTENCY_MISMATCH' },
  IN_PROGRESS: { status: 409, code: 'IN_PROGRESS' },
  WINDOW_CLOSED: { status: 409, code: 'WINDOW_CLOSED' },
  ALREADY_BID: { status: 409, code: 'ALREADY_BID' },
  MANDATE_EXCEEDED: { status: 422, code: 'MANDATE_EXCEEDED' },
  MANDATE_PAUSED: { status: 409, code: 'STATE_CONFLICT' },
  HOLD_FAILED: { status: 422, code: 'HOLD_FAILED' },
  PAYPAL_ERROR: { status: 502, code: 'PAYPAL_ERROR' },
  STATE_CONFLICT: { status: 409, code: 'STATE_CONFLICT' },
};

function messageFor(error: PlaceBidError): string {
  switch (error.code) {
    case 'NOT_FOUND':
      return error.what === 'listing'
        ? 'Listing not found.'
        : error.what === 'bid'
          ? 'Bid not found.'
          : 'Shopper not found.';
    case 'VALIDATION_ERROR':
      return error.message;
    case 'IDEMPOTENCY_MISMATCH':
      return 'This Idempotency-Key was already used for a different request.';
    case 'IN_PROGRESS':
      return error.reason === 'NOT_APPROVED'
        ? "PayPal hasn't confirmed your approval yet."
        : 'This bid is still being placed.';
    case 'WINDOW_CLOSED':
      return error.released
        ? `This window has closed. ${releasedHoldMessage(error.amountCents)}`
        : 'This window has closed. Nothing was held.';
    case 'ALREADY_BID':
      return 'You already have a bid on this listing. Raise or cancel it instead.';
    case 'MANDATE_EXCEEDED':
      return "This bid is over your agent's limits.";
    case 'MANDATE_PAUSED':
      return 'Your agent mandate is paused.';
    case 'HOLD_FAILED':
      return "PayPal couldn't hold this amount. Try another payment method.";
    case 'PAYPAL_ERROR':
      return "We couldn't confirm your hold with PayPal yet. Try again in a moment.";
    case 'STATE_CONFLICT':
      return 'This bid could not be placed.';
  }
}

/** `{ status, body }` for a `placeBid` result, in the api.md envelope. */
export function placeBidResponse(result: PlaceBidResult): IdempotentResponse {
  if (result.ok) {
    const { bid } = result;
    const body: PlacedBidBody = {
      bidId: bid.id,
      status: bid.status,
      amountCents: bid.amount_cents,
      authorizationId: bid.paypal_authorization_id,
      authorizedAt: bid.authorized_at ? bid.authorized_at.toISOString() : null,
      publicOffer: result.publicOffer,
    };
    if (bid.status === 'PENDING_APPROVAL' && isTwoStep(bid.payment_method) && bid.paypal_order_id) {
      body.orderId = bid.paypal_order_id;
      if (bid.payment_method === 'PAYPAL') body.approveUrl = result.approveUrl ?? null;
    }
    return { status: 201, body };
  }
  return bidErrorResponse(result.error, result.publicOffer);
}

/** `{ status, body }` for a bid service error (`POST /bids`, `POST /bids/:id/authorize`). */
export function bidErrorResponse(
  error: PlaceBidError,
  publicOffer: PublicOffer | null = null,
): IdempotentResponse {
  const http = ERROR_HTTP[error.code];
  const details: Record<string, unknown> = {};
  switch (error.code) {
    case 'VALIDATION_ERROR':
      details.field = error.field;
      break;
    case 'MANDATE_PAUSED':
      details.reason = 'MANDATE_PAUSED';
      details.bidId = error.bidId;
      details.released = error.released;
      break;
    case 'STATE_CONFLICT':
      details.reason = error.reason;
      details.bidId = error.bidId;
      details.released = error.released;
      break;
    case 'ALREADY_BID':
      details.bidId = error.bidId;
      details.amountCents = error.amountCents;
      break;
    case 'WINDOW_CLOSED':
    case 'MANDATE_EXCEEDED':
      details.bidId = error.bidId;
      details.released = error.released;
      break;
    case 'IN_PROGRESS':
      details.bidId = error.bidId;
      if (error.reason) details.reason = error.reason;
      break;
    case 'HOLD_FAILED':
      details.bidId = error.bidId;
      details.paypalCode = error.paypalCode;
      break;
    case 'PAYPAL_ERROR':
      details.bidId = error.bidId;
      details.needsReconcile = true;
      break;
  }
  if (publicOffer) details.publicOffer = publicOffer;
  return { status: http.status, body: errorBody(http.code, messageFor(error), details) };
}
