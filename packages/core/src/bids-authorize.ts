import { isBiddable, isRaisable } from '@holdfast/shared';
import {
  isTwoStep,
  landingError,
  markHoldFailed,
  markNeedsReconcile,
  refusalFromVoid,
  type PlaceBidDeps,
  type PlaceBidError,
} from './bids.js';
import type { Queryable } from './db.js';
import { landHold } from './money/land-hold.js';
import type { Actor, AuditEntry } from './money/deps.js';
import type { BidRow } from './money/rows.js';
import { transition } from './money/transition.js';
import { callVoid, loadBid, markVoided, voidBid, voidKey } from './money/void.js';
import { authorizeRequestId } from './paypal/ids.js';
import type { HoldResult } from './paypal/types.js';

/**
 * The shared authorize-and-land path for the two-step holds (HF-014b; api.md
 * §`POST /bids/:id/authorize`, §`GET /bids/return`; features/03 §Logic 4, §Edge cases). Used by
 * `POST /bids/:id/authorize` (after the card-fields submit), `GET /bids/return` (after wallet
 * approval) and the HF-034 order poll:
 *
 * 1. The bid must be PENDING_APPROVAL with an order. Already HELD → return it (replay, no PayPal
 *    call); ABANDONED, HOLD_FAILED, VOIDED → answer with that end state, never authorize.
 * 2. Biddable first (D7; `isRaisable` for a replacement): if the listing stopped taking bids, don't
 *    authorize; the bid ends ABANDONED (`error_code = WINDOW_CLOSED`), W21 "Nothing was held".
 * 3. `pp.authorizeOrder` with `authz-<bidId>` (D5, M2), outside any transaction (INV-1). A same-id
 *    replay returns the same authorization; `ORDER_ALREADY_AUTHORIZED` → the client GETs the order.
 * 4. The authorization's amount must equal `bids.amount_cents` and its `custom_id` the bid id;
 *    otherwise it is voided (`void-<bidId>`) and audited `AMOUNT_MISMATCH`.
 * 5. `landHold` (D1). If Clear / cancel / expiry won meanwhile it voids the new authorization (B2).
 *    A replacement (`replaces_bid_id`, a wallet raise from HF-018) swaps atomically and the old
 *    hold is then voided (`REPLACED`). CARD saves the vault id on the shopper.
 */

export interface AuthorizeBidInput {
  bidId: string;
  /** When set, the bid must belong to this shopper (else NOT_FOUND). */
  shopperId?: string | null;
  /** Audit actor. Default: the bid's shopper. */
  actor?: Actor;
  /** Which entry point called (audit only). */
  via?: 'AUTHORIZE' | 'RETURN' | 'CRON';
}

export type AuthorizeBidResult =
  | {
      ok: true;
      bid: BidRow;
      /** The bid was already HELD (a refresh, a double click): no PayPal call was made. */
      alreadyHeld: boolean;
      /** Replacement: the old bid, now VOIDED (or VOIDING if PayPal is still failing). */
      replaced: BidRow | null;
    }
  | { ok: false; error: PlaceBidError; bid: BidRow | null };

interface ListingTiming {
  status: string;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  db_now: Date;
}

export async function authorizeAndLand(
  deps: PlaceBidDeps,
  input: AuthorizeBidInput,
): Promise<AuthorizeBidResult> {
  const found = await findBid(deps.db.pool, input.bidId);
  if (!found || (input.shopperId && found.shopper_id !== input.shopperId)) {
    return { ok: false, error: { code: 'NOT_FOUND', what: 'bid' }, bid: null };
  }
  const bid = found;
  const actor: Actor = input.actor ?? { type: 'SHOPPER', id: bid.shopper_id };
  const via = input.via ?? 'AUTHORIZE';

  // 1. Only a waiting two-step bid is authorized; anything else answers with its state.
  if (bid.status !== 'PENDING_APPROVAL') return settled(bid);
  if (!isTwoStep(bid.payment_method)) {
    return {
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'bidId', message: 'This bid needs no approval.' },
      bid,
    };
  }
  if (!bid.paypal_order_id) {
    // The order create itself is unresolved (needs_reconcile); the sweeper replays it.
    return { ok: false, error: { code: 'IN_PROGRESS', bidId: bid.id }, bid };
  }
  const orderId = bid.paypal_order_id;

  // 2. Biddable first: no authorization for a closed window (W21, "Nothing was held").
  if (!(await stillAccepts(deps.db.pool, bid))) {
    const abandoned = await abandonPendingBid(deps, bid.id, 'WINDOW_CLOSED', actor);
    if (abandoned) {
      return {
        ok: false,
        error: {
          code: 'WINDOW_CLOSED',
          bidId: bid.id,
          amountCents: bid.amount_cents,
          released: false,
        },
        bid: abandoned,
      };
    }
    return settled(await loadBid(deps.db.pool, bid.id));
  }

  // 3. Authorize outside any transaction (INV-1), with the bid's own request id.
  let result: HoldResult;
  try {
    result = await deps.paypal.authorizeOrder(orderId, authorizeRequestId(bid.id));
  } catch (err) {
    result = {
      kind: 'unknown',
      orderId,
      code: err instanceof Error ? `CLIENT_${err.name}` : 'CLIENT_ERROR',
      errorClass: 'RECONCILE',
    };
  }

  switch (result.kind) {
    case 'held':
      return land(deps, bid, result, actor, via);
    case 'needs_approval':
      // The buyer hasn't approved (or the card-fields submit didn't finish). Nothing is held.
      await record(deps, {
        actor,
        action: 'BID_AUTHORIZE_NOT_APPROVED',
        entity: 'bid',
        entityId: bid.id,
        listingId: bid.listing_id,
        paypalId: orderId,
        requestId: authorizeRequestId(bid.id),
        data: { via, orderStatus: result.status },
      });
      return {
        ok: false,
        error: { code: 'IN_PROGRESS', bidId: bid.id, reason: 'NOT_APPROVED' },
        bid,
      };
    case 'denied': {
      const failed = await markHoldFailed(deps, bid, result.code, orderId, actor);
      return {
        ok: false,
        error: { code: 'HOLD_FAILED', bidId: bid.id, paypalCode: result.code },
        bid: failed,
      };
    }
    case 'pending':
    case 'unknown': {
      // Not a hold (M6). The sweeper replays `authz-<bidId>` and lands or voids what it finds.
      const code = result.kind === 'pending' ? `AUTHORIZATION_${result.status}` : result.code;
      const row = await markNeedsReconcile(deps, bid, code, orderId, actor);
      return {
        ok: false,
        error: { code: 'PAYPAL_ERROR', bidId: bid.id, paypalCode: code, needsReconcile: true },
        bid: row,
      };
    }
  }
}

/** Steps 4–5 for an authorization in status CREATED. */
async function land(
  deps: PlaceBidDeps,
  bid: BidRow,
  held: Extract<HoldResult, { kind: 'held' }>,
  actor: Actor,
  via: string,
): Promise<AuthorizeBidResult> {
  // CARD: PayPal vaulted the card on success (store_in_vault: ON_SUCCESS). Saved whatever the
  // landing decides: the vault is the shopper's either way. Wallet vaults are not stored here
  // (shoppers.paypal_vault_id holds one card vault; see the PR notes).
  const vaulted = held.vault?.status === 'VAULTED' && !!held.vault.id ? held.vault.id : null;
  if (bid.payment_method === 'CARD' && vaulted) {
    await deps.db.pool.query(
      `UPDATE shoppers SET paypal_vault_id = $2, updated_at = now() WHERE id = $1`,
      [bid.shopper_id, vaulted],
    );
  }
  const customIdChecked = held.customId != null;
  await record(deps, {
    actor,
    action: 'BID_AUTHORIZED',
    entity: 'bid',
    entityId: bid.id,
    listingId: bid.listing_id,
    paypalId: held.authorizationId,
    requestId: authorizeRequestId(bid.id),
    data: {
      via,
      orderId: held.orderId,
      authorizedCents: held.amountCents,
      customIdChecked,
      cardVaultSaved: bid.payment_method === 'CARD' && !!vaulted,
      walletVaulted: bid.payment_method === 'PAYPAL' && !!vaulted,
    },
  });

  // 4. INV-5 + D5: the authorization is exactly this bid's.
  if (held.amountCents !== bid.amount_cents || (customIdChecked && held.customId !== bid.id)) {
    return rejectMismatch(deps, bid, held, actor);
  }

  // 5. landHold (D1); a replacement swaps the old hold in the same transaction.
  const landed = await landHold(deps, {
    bidId: bid.id,
    authorizationId: held.authorizationId,
    authorizedAt: held.authorizedAt,
    authorizedAmountCents: held.amountCents,
    authorizationExpiresAt: held.expiresAt,
    paypalOrderId: held.orderId,
    replacesBidId: bid.replaces_bid_id,
    actor,
  });
  if (!landed.ok) {
    return { ok: false, error: await landingError(deps, landed), bid: landed.bid };
  }

  let replaced: BidRow | null = null;
  if (landed.replaced) {
    // The old hold went HELD → VOIDING (REPLACED) inside landHold; release it now. On a PayPal
    // failure it stays VOIDING for the sweeper (HF-034).
    const v = await voidBid(deps, landed.replaced.id, 'REPLACED', actor, { from: ['VOIDING'] });
    replaced = v.bid;
  }
  return { ok: true, bid: landed.bid, alreadyHeld: landed.alreadyHeld, replaced };
}

/**
 * The authorization doesn't match the bid (amount or `custom_id`): never land it. Record it on the
 * bid, void it with `void-<bidId>` and end the bid VOIDED, audited `AMOUNT_MISMATCH`.
 */
async function rejectMismatch(
  deps: PlaceBidDeps,
  bid: BidRow,
  held: Extract<HoldResult, { kind: 'held' }>,
  actor: Actor,
): Promise<AuthorizeBidResult> {
  const data = {
    expectedCents: bid.amount_cents,
    authorizedCents: held.amountCents,
    expectedCustomId: bid.id,
    customId: held.customId ?? null,
  };
  const conflict = (released: boolean, row: BidRow | null): AuthorizeBidResult => ({
    ok: false,
    error: { code: 'STATE_CONFLICT', bidId: bid.id, reason: 'AMOUNT_MISMATCH', released },
    bid: row,
  });

  // Another bid owns this authorization: its own key voids it, never ours (D4).
  const owner = await deps.db.pool.query(
    `SELECT id FROM bids WHERE paypal_authorization_id = $1 AND id <> $2`,
    [held.authorizationId, bid.id],
  );
  if (owner.rowCount) {
    await record(deps, {
      actor,
      action: 'AMOUNT_MISMATCH',
      entity: 'bid',
      entityId: bid.id,
      listingId: bid.listing_id,
      paypalId: held.authorizationId,
      data: { ...data, foreignBidId: (owner.rows[0] as { id: string }).id, voided: false },
    });
    return conflict(false, await loadBid(deps.db.pool, bid.id));
  }

  const marked = await deps.db.tx(async (tx) => {
    const row = await transition<'bids', BidRow>(
      tx,
      'bids',
      bid.id,
      ['PENDING_APPROVAL', 'ABANDONED'],
      'VOIDING',
      {
        paypal_authorization_id: held.authorizationId,
        paypal_order_id: held.orderId,
        void_reason: 'CANCELLED',
        void_request_id: voidKey(bid.id),
        error_code: 'AMOUNT_MISMATCH',
        needs_reconcile: false,
      },
    );
    if (row) {
      await deps.audit?.(tx, {
        actor,
        action: 'AMOUNT_MISMATCH',
        entity: 'bid',
        entityId: row.id,
        listingId: row.listing_id,
        paypalId: held.authorizationId,
        requestId: voidKey(row.id),
        data,
      });
    }
    return row;
  });
  if (!marked) {
    const current = await loadBid(deps.db.pool, bid.id);
    if (
      current.paypal_authorization_id &&
      current.paypal_authorization_id !== held.authorizationId
    ) {
      // void-<bidId> already belongs to another authorization of this bid: leave it to a human.
      return conflict(false, current);
    }
  }
  const call = await callVoid(deps, bid.id, held.authorizationId);
  const row =
    marked && call.done ? await markVoided(deps, bid.id, actor, { emitEvent: false }) : null;
  return conflict(call.done, row ?? (await loadBid(deps.db.pool, bid.id)));
}

/**
 * PENDING_APPROVAL → ABANDONED with `error_code = reason`: no authorization exists and none will be
 * made. Used here when the window closed before approval, and by the HF-034 order poll. Returns
 * null if the bid had already moved on.
 */
export async function abandonPendingBid(
  deps: Pick<PlaceBidDeps, 'db' | 'audit'>,
  bidId: string,
  reason: string,
  actor: Actor = { type: 'SYSTEM' },
): Promise<BidRow | null> {
  return deps.db.tx(async (tx) => {
    const row = await transition<'bids', BidRow>(
      tx,
      'bids',
      bidId,
      'PENDING_APPROVAL',
      'ABANDONED',
      {
        error_code: reason,
        needs_reconcile: false,
      },
    );
    if (row) {
      await deps.audit?.(tx, {
        actor,
        action: 'BID_ABANDONED',
        entity: 'bid',
        entityId: row.id,
        listingId: row.listing_id,
        paypalId: row.paypal_order_id,
        data: { reason },
      });
    }
    return row;
  });
}

/**
 * The buyer pressed cancel on PayPal (`cancel_url`). The bid stays PENDING_APPROVAL: the HF-034
 * order poll GETs the order after 30 min and lands it if it was approved after all, else
 * abandons it.
 */
export async function recordApprovalCancelled(
  deps: Pick<PlaceBidDeps, 'db' | 'audit'>,
  bid: BidRow,
  actor: Actor = { type: 'SHOPPER', id: bid.shopper_id },
): Promise<void> {
  if (bid.status !== 'PENDING_APPROVAL') return;
  await record(deps, {
    actor,
    action: 'BID_APPROVAL_CANCELLED',
    entity: 'bid',
    entityId: bid.id,
    listingId: bid.listing_id,
    paypalId: bid.paypal_order_id,
  });
}

/** The two-step bid whose PayPal order is `orderId` (the `token` on the return / cancel URL). */
export async function findBidByOrderId(q: Queryable, orderId: string): Promise<BidRow | null> {
  const res = await q.query(
    `SELECT * FROM bids
      WHERE paypal_order_id = $1 AND payment_method IN ('CARD', 'PAYPAL')
      ORDER BY placed_at DESC LIMIT 1`,
    [orderId],
  );
  return (res.rows[0] as BidRow | undefined) ?? null;
}

/** The answer for a bid that is no longer waiting: HELD (or later) is a replay, the rest refuse. */
function settled(bid: BidRow): AuthorizeBidResult {
  if (bid.authorized_at && !['VOIDING', 'VOIDED', 'CAPTURE_FAILED'].includes(bid.status)) {
    return { ok: true, bid, alreadyHeld: true, replaced: null };
  }
  switch (bid.status) {
    case 'ABANDONED':
      return {
        ok: false,
        error:
          bid.error_code === 'WINDOW_CLOSED'
            ? {
                code: 'WINDOW_CLOSED',
                bidId: bid.id,
                amountCents: bid.amount_cents,
                released: false,
              }
            : { code: 'STATE_CONFLICT', bidId: bid.id, reason: 'ABANDONED', released: false },
        bid,
      };
    case 'HOLD_FAILED':
      return {
        ok: false,
        error: { code: 'HOLD_FAILED', bidId: bid.id, paypalCode: bid.error_code ?? 'DECLINED' },
        bid,
      };
    case 'VOIDING':
    case 'VOIDED':
      return { ok: false, error: refusalFromVoid(bid), bid };
    default:
      return {
        ok: false,
        error: { code: 'STATE_CONFLICT', bidId: bid.id, reason: bid.status, released: false },
        bid,
      };
  }
}

/** D7 on DB time: a new bid needs `isBiddable`; a replacement (raise) needs `isRaisable`. */
async function stillAccepts(q: Queryable, bid: BidRow): Promise<boolean> {
  const res = await q.query(
    `SELECT status, window_closes_at, rounds_end_at, clock_timestamp() AS db_now
       FROM listings WHERE id = $1`,
    [bid.listing_id],
  );
  const l = res.rows[0] as ListingTiming | undefined;
  if (!l?.window_closes_at) return false;
  const timing = {
    status: l.status as never,
    windowClosesAt: l.window_closes_at,
    roundsEndAt: l.rounds_end_at,
  };
  return bid.replaces_bid_id ? isRaisable(timing, l.db_now) : isBiddable(timing, l.db_now);
}

async function findBid(q: Queryable, bidId: string): Promise<BidRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(bidId)) return null;
  const res = await q.query(`SELECT * FROM bids WHERE id = $1`, [bidId]);
  return (res.rows[0] as BidRow | undefined) ?? null;
}

async function record(deps: Pick<PlaceBidDeps, 'db' | 'audit'>, entry: AuditEntry): Promise<void> {
  if (!deps.audit) return;
  await deps.db.tx((tx) => deps.audit!(tx, entry));
}
