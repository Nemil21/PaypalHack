import {
  moneyCopyKey,
  releasedHoldMessage,
  releasingHoldMessage,
  type ErrorCode,
  type MoneyCopyKey,
} from '@holdfast/shared';
import { errorBody, type IdempotentResponse } from './idempotency.js';
import type { Actor, MoneyDeps } from './money/deps.js';
import type { BidRow } from './money/rows.js';
import { transition } from './money/transition.js';
import { voidBid } from './money/void.js';

/**
 * Cancel a bid (HF-016; api.md §`POST /bids/:id/cancel`, data-model §Bid state machine). The one
 * entry point REST, the buyer agent and MCP `cancel_bid` use to release a shopper's hold.
 *
 * - HELD → `voidBid(…, 'CANCELLED')` (HF-003a): HELD→VOIDING (conditional), `pp.void` with
 *   `PayPal-Request-Id = void-<bidId>` (D4) outside any transaction, retried in-call (D11), then
 *   VOIDED. "Already voided" counts as success. `void_attempts` and the authorization id are on
 *   the bid and in the `BID_VOID_REQUESTED` / `BID_VOIDED` audit rows. If PayPal keeps failing the
 *   bid stays VOIDING ("releasing") and the HF-034 sweeper re-voids it after 2 min.
 * - PENDING_APPROVAL → ABANDONED with no PayPal call. Wallet / card-fields bids have no
 *   authorization until `POST /bids/:id/authorize`; if that lands later, `landHold` refuses the
 *   ABANDONED bid and voids the new authorization. VAULT / TEST_CARD bids follow HF-014a's
 *   reconcile rule: their create call may be in flight or timed out, so the row also keeps
 *   `needs_reconcile = true` and the in-flight call (via `landHold`) or the HF-034 sweeper (same
 *   request id) voids any authorization that turns up.
 * - WON / LOST / CAPTURED / SHIPPED / CAPTURE_FAILED → `STATE_CONFLICT` (settlement owns them).
 * - Already VOIDING / VOIDED / ABANDONED / HOLD_FAILED → the current state (naturally idempotent).
 *
 * Another shopper's bid (or an unknown id) is `NOT_FOUND`, never `FORBIDDEN`.
 */

export interface CancelBidInput {
  bidId: string;
  /** Owner check: only this shopper's bid can be cancelled. */
  shopperId: string;
  /** Audit actor. Default: the shopper. */
  actor?: Actor;
}

export type CancelBidResult =
  | {
      ok: true;
      bid: BidRow;
      /** What this call did; `UNCHANGED` = the bid was already released or never held. */
      outcome: 'VOIDED' | 'VOIDING' | 'ABANDONED' | 'UNCHANGED';
    }
  | { ok: false; error: { code: 'NOT_FOUND' } }
  | { ok: false; error: { code: 'STATE_CONFLICT'; reason: string; bidId: string }; bid: BidRow };

/** Server-side holds: the create call itself authorizes, so an outcome may still be unknown. */
const SERVER_HOLD_METHODS = new Set(['VAULT', 'TEST_CARD']);
const SETTLED_BY_CLEAR = new Set(['WON', 'LOST', 'CAPTURED', 'SHIPPED', 'CAPTURE_FAILED']);
/** A concurrent writer moved the bid between our read and our conditional update: re-read. */
const MAX_PASSES = 4;

export async function cancelBid(deps: MoneyDeps, input: CancelBidInput): Promise<CancelBidResult> {
  const actor: Actor = input.actor ?? { type: 'SHOPPER', id: input.shopperId };
  let bid = await loadOwned(deps, input);
  if (!bid) return { ok: false, error: { code: 'NOT_FOUND' } };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    switch (bid.status) {
      case 'HELD': {
        const r = await voidBid(deps, bid.id, 'CANCELLED', actor);
        if (r.outcome === 'VOIDED') return { ok: true, bid: r.bid, outcome: 'VOIDED' };
        if (r.outcome === 'LEFT_VOIDING') return { ok: true, bid: r.bid, outcome: 'VOIDING' };
        if (r.outcome === 'ALREADY_VOIDED') return { ok: true, bid: r.bid, outcome: 'UNCHANGED' };
        bid = r.bid; // SKIPPED: Clear, a raise or another void moved it first.
        continue;
      }
      case 'PENDING_APPROVAL': {
        const abandoned = await abandon(deps, bid, actor);
        if (abandoned) return { ok: true, bid: abandoned, outcome: 'ABANDONED' };
        bid = (await loadOwned(deps, input))!;
        continue;
      }
      case 'VOIDING':
      case 'VOIDED':
      case 'ABANDONED':
      case 'HOLD_FAILED':
        return { ok: true, bid, outcome: 'UNCHANGED' };
      default:
        if (SETTLED_BY_CLEAR.has(bid.status)) {
          return {
            ok: false,
            error: { code: 'STATE_CONFLICT', reason: bid.status, bidId: bid.id },
            bid,
          };
        }
        throw new Error(`cancelBid: unexpected bid status ${bid.status}`);
    }
  }
  // Still moving after several passes: report what it is now; a retry settles it.
  return { ok: true, bid, outcome: 'UNCHANGED' };
}

async function loadOwned(deps: MoneyDeps, input: CancelBidInput): Promise<BidRow | null> {
  const res = await deps.db.pool.query(`SELECT * FROM bids WHERE id = $1 AND shopper_id = $2`, [
    input.bidId,
    input.shopperId,
  ]);
  return (res.rows[0] as BidRow | undefined) ?? null;
}

async function abandon(deps: MoneyDeps, bid: BidRow, actor: Actor): Promise<BidRow | null> {
  const reconcile = SERVER_HOLD_METHODS.has(String(bid.payment_method));
  return deps.db.tx(async (tx) => {
    const row = await transition<'bids', BidRow>(
      tx,
      'bids',
      bid.id,
      'PENDING_APPROVAL',
      'ABANDONED',
      { void_reason: 'CANCELLED', needs_reconcile: reconcile ? true : undefined },
    );
    if (!row) return null;
    await deps.audit?.(tx, {
      actor,
      action: 'BID_ABANDONED',
      entity: 'bid',
      entityId: row.id,
      listingId: row.listing_id,
      paypalId: row.paypal_order_id,
      data: {
        reason: 'CANCELLED',
        paymentMethod: row.payment_method,
        needsReconcile: Boolean(row.needs_reconcile),
      },
    });
    return row;
  });
}

// ---------------------------------------------------------------------------------------------
// HTTP / tool response. Shared by REST, MCP and the agent tools.
// ---------------------------------------------------------------------------------------------

export interface CancelledBidBody {
  bidId: string;
  status: string;
  amountCents: number;
  voidReason: string | null;
  /** `releasing` while VOIDING, `released` only once VOIDED (D14). */
  moneyKey: MoneyCopyKey;
  message: string;
  authorizationId: string | null;
  voidAttempts: number;
}

export function cancelMessage(bid: Pick<BidRow, 'status' | 'amount_cents'>): string {
  switch (bid.status) {
    case 'VOIDED':
      return releasedHoldMessage(bid.amount_cents);
    case 'VOIDING':
      return releasingHoldMessage(bid.amount_cents);
    default:
      return 'Your bid was cancelled. Nothing was charged.';
  }
}

/** `{ status, body }` for a `cancelBid` result, in the api.md envelope. */
export function cancelBidResponse(result: CancelBidResult): IdempotentResponse {
  if (result.ok) {
    const { bid } = result;
    const body: CancelledBidBody = {
      bidId: bid.id,
      status: bid.status,
      amountCents: bid.amount_cents,
      voidReason: bid.void_reason,
      moneyKey: moneyCopyKey(bid.status),
      message: cancelMessage(bid),
      authorizationId: bid.paypal_authorization_id,
      voidAttempts: bid.void_attempts,
    };
    return { status: 200, body };
  }
  if (result.error.code === 'NOT_FOUND') {
    return { status: 404, body: errorBody('NOT_FOUND' satisfies ErrorCode, 'Bid not found.') };
  }
  const { reason, bidId } = result.error;
  return {
    status: 409,
    body: errorBody(
      'STATE_CONFLICT' satisfies ErrorCode,
      reason === 'WON' || reason === 'CAPTURED' || reason === 'SHIPPED'
        ? 'This bid has won and can no longer be cancelled.'
        : 'This bid is being settled and can no longer be cancelled.',
      { reason, bidId },
    ),
  };
}
