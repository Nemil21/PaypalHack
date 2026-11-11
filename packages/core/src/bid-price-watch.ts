import {
  moneyCopyKey,
  releasedHoldMessage,
  releasingHoldMessage,
  type ErrorCode,
  type MoneyCopyKey,
} from '@holdfast/shared';
import { errorBody, type IdempotentResponse } from './idempotency.js';
import type { Actor, MoneyDeps } from './money/deps.js';
import { lockListing } from './money/locks.js';
import type { BidRow } from './money/rows.js';
import { transition } from './money/transition.js';
import { emitVoided, voidBid, voidKey } from './money/void.js';

/**
 * Per-bid "Release my hold if it's cheaper elsewhere" (HF-020; api.md §`PATCH /bids/:id`,
 * features/03 §Logic 5, features/06). Owner only, live bids only (PENDING_APPROVAL / HELD).
 *
 * Switching it **on** compares at once with `products.best_public_price_cents`: if a store already
 * sells it below the bid, the hold is released with `void_reason = PRICE_DROP`, as the price
 * watcher would have done. The flip runs under the listing's `FOR SHARE` lock and only while the
 * listing is OPEN / ROUNDS (features/06 §Logic 5), so it cannot race Clear: Clear's conditional
 * UPDATE to CLEARING waits for us, or we see the listing already CLEARING and leave the bid alone.
 * Lock order listing → bid (money/locks.ts). The PayPal void (`void-<bidId>`, D4) runs after the
 * commit through `voidBid(…, { resume: true })`, so a concurrent cancel or sweeper makes one call.
 *
 * Switching it off just persists the setting. Either way the change is audited.
 */

export interface SetReleaseIfCheaperInput {
  bidId: string;
  shopperId: string;
  releaseIfCheaper: boolean;
  actor?: Actor;
}

/** The cheaper offer that triggered a release (the M06 sheet's "Buy at <store> $219"). */
export interface CheaperOffer {
  priceCents: number;
  merchant: string | null;
  url: string | null;
}

export type SetReleaseIfCheaperResult =
  | { ok: true; bid: BidRow; released: false }
  | { ok: true; bid: BidRow; released: true; cheaper: CheaperOffer }
  | { ok: false; error: { code: 'NOT_FOUND' } }
  | { ok: false; error: { code: 'STATE_CONFLICT'; reason: string; bidId: string }; bid: BidRow };

const LIVE = ['PENDING_APPROVAL', 'HELD'] as const;
const WATCHED_LISTING: ReadonlySet<string> = new Set(['OPEN', 'ROUNDS']);

interface ProductPrice {
  best_public_price_cents: number | null;
  best_public_merchant: string | null;
  best_public_offer_url: string | null;
}

export async function setReleaseIfCheaper(
  deps: MoneyDeps,
  input: SetReleaseIfCheaperInput,
): Promise<SetReleaseIfCheaperResult> {
  const actor: Actor = input.actor ?? { type: 'SHOPPER', id: input.shopperId };
  const found = await deps.db.pool.query(
    `SELECT listing_id FROM bids WHERE id = $1 AND shopper_id = $2`,
    [input.bidId, input.shopperId],
  );
  const listingId = (found.rows[0] as { listing_id: string } | undefined)?.listing_id;
  if (!listingId) return { ok: false, error: { code: 'NOT_FOUND' } };

  const step = await deps.db.tx(async (tx) => {
    const listing = await lockListing(tx, listingId, 'share');
    const prev = await tx.query(
      `SELECT release_if_cheaper FROM bids WHERE id = $1 AND shopper_id = $2 FOR UPDATE`,
      [input.bidId, input.shopperId],
    );
    const was = (prev.rows[0] as { release_if_cheaper: boolean } | undefined)?.release_if_cheaper;
    const updated = await tx.query(
      `UPDATE bids SET release_if_cheaper = $3
        WHERE id = $1 AND shopper_id = $2 AND status = ANY($4::text[]) RETURNING *`,
      [input.bidId, input.shopperId, input.releaseIfCheaper, LIVE],
    );
    let bid = updated.rows[0] as BidRow | undefined;
    if (!bid) return { kind: 'conflict' as const };

    if (was !== input.releaseIfCheaper) {
      await deps.audit?.(tx, {
        actor,
        action: 'BID_RELEASE_IF_CHEAPER_SET',
        entity: 'bid',
        entityId: bid.id,
        listingId: bid.listing_id,
        // `reason` is what the bid timeline shows (bid-views.ts reads `data.reason`).
        data: {
          releaseIfCheaper: input.releaseIfCheaper,
          reason: input.releaseIfCheaper ? 'PRICE_WATCH_ON' : 'PRICE_WATCH_OFF',
        },
      });
    }

    if (!input.releaseIfCheaper || bid.status !== 'HELD') return { kind: 'saved' as const, bid };
    if (!listing || !WATCHED_LISTING.has(listing.status)) return { kind: 'saved' as const, bid };
    const price = (
      await tx.query(
        `SELECT best_public_price_cents, best_public_merchant, best_public_offer_url
           FROM products WHERE id = $1`,
        [listing.product_id as string],
      )
    ).rows[0] as ProductPrice | undefined;
    const best = price?.best_public_price_cents;
    if (best == null || best >= bid.amount_cents) return { kind: 'saved' as const, bid };

    const cheaper: CheaperOffer = {
      priceCents: best,
      merchant: price!.best_public_merchant,
      url: price!.best_public_offer_url,
    };
    const flipped = await transition<'bids', BidRow>(tx, 'bids', bid.id, 'HELD', 'VOIDING', {
      void_reason: 'PRICE_DROP',
      void_request_id: voidKey(bid.id),
    });
    if (!flipped) return { kind: 'saved' as const, bid };
    bid = flipped;
    await emitVoided(tx, bid);
    await deps.audit?.(tx, {
      actor,
      action: 'BID_VOID_REQUESTED',
      entity: 'bid',
      entityId: bid.id,
      listingId: bid.listing_id,
      paypalId: bid.paypal_authorization_id,
      requestId: voidKey(bid.id),
      data: {
        reason: 'PRICE_DROP',
        trigger: 'RELEASE_IF_CHEAPER_ON',
        newPriceCents: cheaper.priceCents,
        merchant: cheaper.merchant,
        url: cheaper.url,
      },
    });
    return { kind: 'released' as const, bid, cheaper };
  });

  if (step.kind === 'conflict') {
    const current = (await deps.db.pool.query(`SELECT * FROM bids WHERE id = $1`, [input.bidId]))
      .rows[0] as BidRow;
    return {
      ok: false,
      error: { code: 'STATE_CONFLICT', reason: current.status, bidId: current.id },
      bid: current,
    };
  }
  if (step.kind === 'saved') return { ok: true, bid: step.bid, released: false };

  // Outside the transaction (INV-1). `resume` finishes our VOIDING bid; a concurrent cancel or
  // sweeper resuming it shares `void-<bidId>`, so PayPal voids it once.
  const r = await voidBid(deps, step.bid.id, 'PRICE_DROP', actor, { resume: true });
  return { ok: true, bid: r.bid, released: true, cheaper: step.cheaper };
}

// ---------------------------------------------------------------------------------------------
// HTTP response
// ---------------------------------------------------------------------------------------------

export interface PatchedBidBody {
  bidId: string;
  status: string;
  amountCents: number;
  releaseIfCheaper: boolean;
  voidReason: string | null;
  moneyKey: MoneyCopyKey;
  /** Present when switching on released the hold: the cheaper store. */
  cheaper: CheaperOffer | null;
  message: string | null;
}

export function setReleaseIfCheaperResponse(result: SetReleaseIfCheaperResult): IdempotentResponse {
  if (result.ok) {
    const { bid } = result;
    const body: PatchedBidBody = {
      bidId: bid.id,
      status: bid.status,
      amountCents: bid.amount_cents,
      releaseIfCheaper: bid.release_if_cheaper === true,
      voidReason: bid.void_reason,
      moneyKey: moneyCopyKey(bid.status),
      cheaper: result.released ? result.cheaper : null,
      message: !result.released
        ? null
        : bid.status === 'VOIDED'
          ? releasedHoldMessage(bid.amount_cents)
          : releasingHoldMessage(bid.amount_cents),
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
      'This bid is no longer live, so its price-watch setting cannot change.',
      { reason, bidId },
    ),
  };
}
