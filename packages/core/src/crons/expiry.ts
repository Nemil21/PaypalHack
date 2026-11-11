import type { ListingStatus } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Queryable } from '../db.js';
import type { Actor, MoneyDeps } from '../money/deps.js';
import { emit } from '../money/emit.js';
import { lockBids } from '../money/locks.js';
import type { BidRow, ListingRow } from '../money/rows.js';
import { transition } from '../money/transition.js';
import { emitVoided, voidBid, voidKey, type VoidBidResult } from '../money/void.js';
import { runLimited } from '../settlement/settle-listing.js';

/**
 * Listing expiry (HF-034; data-model §Listing state machine, D2, D6). Every minute: OPEN / ROUNDS
 * listings past their clear deadline → EXPIRED, and every hold is voided (`WINDOW_EXPIRED`).
 *
 * The deadline is `least(clear_deadline_at, window_opens_at + 60 h)`: HF-036a recomputes
 * `clear_deadline_at` on rounds start / stop and a DB CHECK caps it at opens + 60 h, and this
 * re-applies the cap so no sequence of rounds calls can keep a hold past PayPal's honor period.
 *
 * Locks as Clear and Cancel do (D2), in one short transaction: the conditional listing UPDATE
 * first (re-checking the deadline on DB time), then `FOR UPDATE` on the HELD bids in id order,
 * which go HELD → VOIDING with `void-<bidId>`. The PayPal voids run after COMMIT (INV-1), at most
 * 10 in flight; a void PayPal keeps refusing is left VOIDING for the sweeper.
 */

const SYSTEM: Actor = { type: 'SYSTEM', id: 'cron:listing-expiry' };
const EXPIRY_VOID_CONCURRENCY = 10;

/** SQL for a listing's effective clear deadline (D6). */
const DEADLINE = `least(coalesce(clear_deadline_at, window_opens_at + interval '60 hours'),
                        window_opens_at + interval '60 hours')`;

export interface ExpireListingsResult {
  expired: number;
  voided: number;
  /** Voids PayPal did not confirm: left VOIDING for the sweeper. */
  leftVoiding: number;
}

export async function expiredListingIds(q: Queryable): Promise<string[]> {
  const res = await q.query(
    `SELECT id FROM listings
      WHERE status IN ('OPEN', 'ROUNDS') AND window_opens_at IS NOT NULL
        AND ${DEADLINE} <= now()
      ORDER BY ${DEADLINE}, id`,
  );
  return (res.rows as Array<{ id: string }>).map((r) => r.id);
}

export type ExpireListingResult =
  { expired: false } | { expired: true; from: ListingStatus; bids: VoidBidResult[] };

/** Expire one listing if it is still OPEN / ROUNDS and past its deadline. */
export async function expireListing(
  deps: MoneyDeps,
  listingId: string,
  actor: Actor = SYSTEM,
): Promise<ExpireListingResult> {
  const flipped = await deps.db.tx(async (tx) => {
    const res = await tx.query(
      `UPDATE listings l SET status = 'EXPIRED'
         FROM (SELECT id, status AS from_status FROM listings WHERE id = $1 FOR UPDATE) o
        WHERE l.id = o.id AND l.status IN ('OPEN', 'ROUNDS')
          AND l.window_opens_at IS NOT NULL
          AND least(coalesce(l.clear_deadline_at, l.window_opens_at + interval '60 hours'),
                    l.window_opens_at + interval '60 hours') <= clock_timestamp()
        RETURNING l.*, o.from_status`,
      [listingId],
    );
    const listing = res.rows[0] as (ListingRow & { from_status: ListingStatus }) | undefined;
    if (!listing) return null;

    const held = await lockBids(tx, listingId);
    const voiding: BidRow[] = [];
    for (const b of held) {
      const bid = await transition<'bids', BidRow>(tx, 'bids', b.id, 'HELD', 'VOIDING', {
        void_reason: 'WINDOW_EXPIRED',
        void_request_id: voidKey(b.id),
      });
      if (!bid) continue;
      voiding.push(bid);
      await emitVoided(tx, bid);
      await deps.audit?.(tx, {
        actor,
        action: 'BID_VOID_REQUESTED',
        entity: 'bid',
        entityId: bid.id,
        listingId,
        paypalId: bid.paypal_authorization_id,
        requestId: voidKey(bid.id),
        data: { reason: 'WINDOW_EXPIRED' },
      });
    }
    await audit(tx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      listingId,
      entity: 'listing',
      entityId: listingId,
      action: 'LISTING_EXPIRED',
      data: {
        from: listing.from_status,
        clearDeadlineAt: listing.clear_deadline_at?.toISOString() ?? null,
        holdsReleased: voiding.length,
      },
    });
    await emit(tx, listingId, {
      type: 'listing.status',
      listingId,
      at: new Date().toISOString(),
      from: listing.from_status,
      to: 'EXPIRED',
    });
    return { from: listing.from_status, voiding };
  });
  if (!flipped) return { expired: false };

  const bids: VoidBidResult[] = [];
  await runLimited(flipped.voiding, EXPIRY_VOID_CONCURRENCY, async (bid) => {
    try {
      // HELD → VOIDING already happened above; `resume` finishes it with `void-<bidId>`.
      bids.push(await voidBid(deps, bid.id, 'WINDOW_EXPIRED', actor, { resume: true }));
    } catch {
      // A DB error mid-void: the bid stays VOIDING and the sweeper finishes it.
    }
  });
  return { expired: true, from: flipped.from, bids };
}

export async function expireListings(deps: MoneyDeps): Promise<ExpireListingsResult> {
  const out: ExpireListingsResult = { expired: 0, voided: 0, leftVoiding: 0 };
  for (const id of await expiredListingIds(deps.db.pool)) {
    const r = await expireListing(deps, id);
    if (!r.expired) continue;
    out.expired++;
    for (const b of r.bids) {
      if (b.outcome === 'VOIDED' || b.outcome === 'ALREADY_VOIDED') out.voided++;
      else if (b.outcome === 'LEFT_VOIDING') out.leftVoiding++;
    }
  }
  return out;
}
