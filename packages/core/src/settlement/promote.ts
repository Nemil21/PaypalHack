import { audit } from '../audit.js';
import type { Queryable } from '../db.js';

/**
 * Inline promotion (features/11 §promoteWithin, D9, D10). `settleBid` (HF-029) calls it inside
 * the transaction that records a terminal capture failure, after the failed bid moved
 * WON → CAPTURE_FAILED and with the listing locked `FOR UPDATE`.
 */
export interface PromoteOutcome {
  /** The reserve bid flipped LOST → WON, or null when nobody was promoted. */
  promotedBidId: string | null;
  /** The CAPTURE settlement inserted for the promoted bid. */
  settlementId: string | null;
  /** Why nobody was promoted (`UNFILLED_UNIT`, `PLACEHOLDER`, …). */
  reason?: string;
}

export type PromoteWithin = (tx: Queryable, failedBidId: string) => Promise<PromoteOutcome>;

/**
 * Placeholder until HF-031 (docs/tickets/INDEX.md): records the failure and promotes nobody.
 * HF-031 replaces this body with the real selection; the signature stays.
 */
export const promoteWithin: PromoteWithin = async (tx, failedBidId) => {
  const res = await tx.query(`SELECT listing_id, unit_root_bid_id FROM bids WHERE id = $1`, [
    failedBidId,
  ]);
  const bid = res.rows[0] as { listing_id: string; unit_root_bid_id: string | null } | undefined;
  if (!bid) throw new Error(`bid ${failedBidId} not found`);
  await audit(tx, {
    actorType: 'WORKFLOW',
    listingId: bid.listing_id,
    entity: 'bid',
    entityId: failedBidId,
    action: 'PROMOTION_SKIPPED',
    data: { reason: 'PLACEHOLDER', unitRootBidId: bid.unit_root_bid_id },
  });
  return { promotedBidId: null, settlementId: null, reason: 'PLACEHOLDER' };
};
