import { HOLD_MAX_AGE_HOURS } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Queryable } from '../db.js';
import type { BidRow } from '../money/rows.js';
import { SQL_NOW, transition } from '../money/transition.js';

/**
 * Inline promotion (HF-031; features/11 §promoteWithin, D9, D10). `settleBid` (HF-029) calls it
 * inside the transaction that records a terminal capture failure, after the failed bid moved
 * WON → CAPTURE_FAILED and with the listing locked `FOR UPDATE`, so SETTLED can never fire before
 * the replacement CAPTURE exists.
 */
export interface PromoteOutcome {
  /** The reserve bid flipped LOST → WON, or null when nobody was promoted. */
  promotedBidId: string | null;
  /** The CAPTURE settlement inserted for the promoted bid. */
  settlementId: string | null;
  /** Why nobody was promoted (`UNFILLED_UNIT`). */
  reason?: string;
  /** `UNFILLED_UNIT` detail: the unit used its 3 promotions, or no reserve bid was eligible. */
  unfilled?: UnfilledReason;
}

export type UnfilledReason = 'PROMOTION_CAP' | 'RESERVE_EMPTY';

export type PromoteWithin = (tx: Queryable, failedBidId: string) => Promise<PromoteOutcome>;

/** D10: a unit is the original winner plus at most 3 promotions. */
export const MAX_PROMOTIONS_PER_UNIT = 3;

const WORKFLOW = 'WORKFLOW';

interface Candidate {
  id: string;
  amount_cents: number;
  void_id: string;
}

/**
 * The failed winner's unit (`unit_root_bid_id`, D10) goes to the best eligible reserve bid, at
 * that bidder's own bid:
 *
 * 1. Lock the listing; re-open the failed bid's own reserve VOID if it was itself promoted
 *    (CANCELLED → QUEUED; `unique(bid_id, action)`, so never a second row).
 * 2. Unit cap: 1 + 3 CAPTURE rows → `UNFILLED_UNIT`.
 * 3. Next reserve in rank order (`amount DESC, placed_at, id`, as `clear()`), `FOR UPDATE SKIP
 *    LOCKED`: LOST, ≥ floor, reserve VOID still QUEUED; skipped if `release_if_cheaper` and above
 *    the current public price, mandate PAUSED / FULFILLED, or hold ≥ 66 h old.
 * 4. Claim its VOID QUEUED → CANCELLED (0 rows → next candidate), bid LOST → WON with the root and
 *    `promotion_count`, CAPTURE at `bid.amount_cents` (INV-5 trigger checks it), audit `PROMOTED`.
 * 5. Nobody eligible → `UNFILLED_UNIT`.
 *
 * The coordinator (HF-030a) runs the new CAPTURE in phase 1; phase 3 waits for the `PROMOTED` /
 * `UNFILLED_UNIT` row naming the failed bid.
 */
export const promoteWithin: PromoteWithin = async (tx, failedBidId) => {
  const failed = (
    await tx.query(`SELECT id, listing_id, unit_root_bid_id FROM bids WHERE id = $1`, [failedBidId])
  ).rows[0] as { id: string; listing_id: string; unit_root_bid_id: string | null } | undefined;
  if (!failed) throw new Error(`bid ${failedBidId} not found`);
  const listingId = failed.listing_id;
  const root = failed.unit_root_bid_id ?? failed.id;

  // 1. Listing lock first (data-model §Locking rule 3), then the public price for the skip rule.
  const listing = (
    await tx.query(
      `SELECT l.floor_cents, p.best_public_price_cents
         FROM listings l JOIN products p ON p.id = l.product_id
        WHERE l.id = $1 FOR UPDATE OF l`,
      [listingId],
    )
  ).rows[0] as { floor_cents: number; best_public_price_cents: number | null } | undefined;
  if (!listing) throw new Error(`listing ${listingId} not found`);

  // A promoted bid whose capture also failed: its cancelled reserve VOID runs again (phase 2).
  // settleBid voids the authorization itself; the row then finds the bid VOIDED and closes.
  await tx.query(
    `UPDATE settlements
        SET status = 'QUEUED', finished_at = NULL, lease_until = NULL, next_attempt_at = NULL
      WHERE bid_id = $1 AND action = 'VOID' AND status = 'CANCELLED'`,
    [failedBidId],
  );

  const unfilled = async (why: UnfilledReason, captures: number): Promise<PromoteOutcome> => {
    await audit(tx, {
      actorType: WORKFLOW,
      listingId,
      entity: 'bid',
      entityId: failedBidId,
      action: 'UNFILLED_UNIT',
      data: {
        reason: why,
        failedBidId,
        root,
        unitRootBidId: root,
        promotions: Math.max(0, captures - 1),
        alert: true,
      },
    });
    return { promotedBidId: null, settlementId: null, reason: 'UNFILLED_UNIT', unfilled: why };
  };

  // 2. Unit cap: count the unit's CAPTURE rows (the original + each promotion).
  const captures = (
    (
      await tx.query(
        `SELECT count(*)::int AS n
           FROM settlements s JOIN bids b ON b.id = s.bid_id
          WHERE s.action = 'CAPTURE' AND (b.unit_root_bid_id = $1 OR b.id = $1)`,
        [root],
      )
    ).rows[0] as { n: number }
  ).n;
  if (captures >= 1 + MAX_PROMOTIONS_PER_UNIT) return unfilled('PROMOTION_CAP', captures);

  // 3–4. Best eligible reserve bid; rows another transaction holds are skipped, not waited on.
  const tried: string[] = [];
  for (;;) {
    const cand = (
      await tx.query(
        `SELECT b.id, b.amount_cents, v.id AS void_id
           FROM bids b
           JOIN settlements v ON v.bid_id = b.id AND v.action = 'VOID'
           LEFT JOIN mandates m ON m.id = b.mandate_id
          WHERE b.listing_id = $1
            AND b.status = 'LOST'
            AND v.is_reserve AND v.status = 'QUEUED'
            AND b.amount_cents >= $2
            AND b.paypal_authorization_id IS NOT NULL
            AND b.authorized_amount_cents = b.amount_cents
            AND b.authorized_at > now() - make_interval(hours => $3)
            AND (m.id IS NULL OR m.status NOT IN ('PAUSED', 'FULFILLED'))
            AND NOT (b.release_if_cheaper AND $4::int IS NOT NULL AND b.amount_cents > $4::int)
            AND b.id <> ALL($5::uuid[])
          ORDER BY b.amount_cents DESC, b.placed_at ASC, b.id ASC
          LIMIT 1
          FOR UPDATE OF b, v SKIP LOCKED`,
        [
          listingId,
          listing.floor_cents,
          HOLD_MAX_AGE_HOURS,
          listing.best_public_price_cents,
          tried,
        ],
      )
    ).rows[0] as Candidate | undefined;
    if (!cand) return unfilled('RESERVE_EMPTY', captures);
    tried.push(cand.id);

    // Conditional claim: a reserve VOID task that got there first wins; try the next bid.
    const claimed = await transition(tx, 'settlements', cand.void_id, 'QUEUED', 'CANCELLED', {
      finished_at: SQL_NOW,
    });
    if (!claimed) continue;
    const won = await transition<'bids', BidRow>(tx, 'bids', cand.id, 'LOST', 'WON', {
      unit_root_bid_id: root,
      promotion_count: captures,
      void_reason: null,
    });
    if (!won) {
      // Locked above, so unreachable; undo the claim rather than strand the hold.
      await transition(tx, 'settlements', cand.void_id, 'CANCELLED', 'QUEUED', {
        finished_at: null,
      });
      continue;
    }

    // 5. CAPTURE at that bidder's own bid (never more: the INV-5 trigger refuses any other amount).
    const s = (
      await tx.query(
        `INSERT INTO settlements (listing_id, bid_id, action, amount_cents)
         VALUES ($1, $2, 'CAPTURE', $3) RETURNING id`,
        [listingId, cand.id, cand.amount_cents],
      )
    ).rows[0] as { id: string };

    // 6. Audit; the promoted shopper's timeline shows "A unit opened up. You won at your bid…".
    await audit(tx, {
      actorType: WORKFLOW,
      listingId,
      entity: 'bid',
      entityId: cand.id,
      action: 'PROMOTED',
      data: {
        fromBidId: failedBidId,
        toBidId: cand.id,
        root,
        amountCents: cand.amount_cents,
        promotionCount: captures,
        settlementId: s.id,
      },
    });
    return { promotedBidId: cand.id, settlementId: s.id };
  }
};
