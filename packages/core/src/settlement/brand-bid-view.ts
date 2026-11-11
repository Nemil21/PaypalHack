import type { BidStatus, BrandBidEvent, BrandBidView, VoidReason } from '@holdfast/shared';
import type { Queryable } from '../db.js';
import { forBrand, isUuid } from '../tenancy.js';
import { settlementRows } from './view.js';

/**
 * `GET /api/listings/:id/bids/:bidId` (HF-035): one bid as its brand may see it, for the W08 bid
 * detail drawer. Scoped with `forBrand` (another brand's bid, or a bid of another listing, is
 * null → 404). Only PII-free columns are selected: the shopper is "Shopper #<seq>", never a name,
 * email, shopper id or payer id; audit `data` contributes only its `reason` string.
 *
 * `brandId` null is an admin read (`ADMIN_EMAILS`): the listing's own brand scopes the query.
 */
export async function loadBrandBidView(
  q: Queryable,
  input: { brandId: string | null; listingId: string; bidId: string },
): Promise<BrandBidView | null> {
  if (!isUuid(input.listingId) || !isUuid(input.bidId)) return null;
  let brandId = input.brandId;
  if (brandId === null) {
    const l = (await q.query(`SELECT brand_id FROM listings WHERE id = $1`, [input.listingId]))
      .rows[0] as { brand_id: string } | undefined;
    if (!l) return null;
    brandId = l.brand_id;
  }
  const bid = await forBrand(q, brandId).findBid(input.bidId);
  if (!bid || bid.listing_id !== input.listingId) return null;

  const head = (
    await q.query(
      `SELECT b.seq, sh.is_simulated, b.status, b.amount_cents, b.source, b.payment_method,
              b.placed_at, b.authorized_at, b.void_reason, b.raise_count, b.replaces_bid_id,
              b.unit_root_bid_id
         FROM bids b JOIN shoppers sh ON sh.id = b.shopper_id
        WHERE b.id = $1`,
      [input.bidId],
    )
  ).rows[0] as {
    seq: string;
    is_simulated: boolean;
    status: BidStatus;
    amount_cents: number;
    source: string | null;
    payment_method: string | null;
    placed_at: Date;
    authorized_at: Date | null;
    void_reason: VoidReason | null;
    raise_count: number;
    replaces_bid_id: string | null;
    unit_root_bid_id: string | null;
  };

  // Promotion links (D10): PROMOTED audit rows name both sides of the hand-over.
  const links = (
    await q.query(
      `SELECT a.data->>'fromBidId' AS from_id, a.data->>'toBidId' AS to_id,
              f.seq AS from_seq, t.seq AS to_seq, t.amount_cents AS to_cents
         FROM audit_events a
         JOIN bids f ON f.id::text = a.data->>'fromBidId'
         JOIN bids t ON t.id::text = a.data->>'toBidId'
        WHERE a.listing_id = $1 AND a.action = 'PROMOTED'
          AND (a.data->>'fromBidId' = $2 OR a.data->>'toBidId' = $2)
        ORDER BY a.at, a.id`,
      [input.listingId, input.bidId],
    )
  ).rows as Array<{
    from_id: string;
    to_id: string;
    from_seq: string;
    to_seq: string;
    to_cents: number;
  }>;
  const from = links.find((l) => l.to_id === input.bidId);
  const to = links.find((l) => l.from_id === input.bidId);

  const audits = (
    await q.query(
      `SELECT at, actor_type, action, paypal_id,
              coalesce(data->>'reason', data->>'voidReason') AS reason
         FROM audit_events
        WHERE listing_id = $1
          AND ((entity = 'bid' AND entity_id = $2::uuid) OR data->>'bidId' = $2::text)
        ORDER BY at, id`,
      [input.listingId, input.bidId],
    )
  ).rows as Array<{
    at: Date;
    actor_type: string | null;
    action: string;
    paypal_id: string | null;
    reason: string | null;
  }>;
  const timeline: BrandBidEvent[] = audits.map((a) => ({
    at: a.at.toISOString(),
    action: a.action,
    actorType: a.actor_type,
    paypalId: a.paypal_id,
    reason: a.reason,
  }));

  const settlements = (await settlementRows(q, input.listingId)).filter(
    (r) => r.bidId === input.bidId,
  );

  return {
    bidId: input.bidId,
    listingId: input.listingId,
    shopperLabel: `Shopper #${head.seq}`,
    isSimulated: head.is_simulated,
    amountCents: head.amount_cents,
    status: head.status,
    source: head.source,
    paymentMethod: head.payment_method,
    placedAt: head.placed_at.toISOString(),
    authorizedAt: head.authorized_at?.toISOString() ?? null,
    voidReason: head.void_reason,
    raiseCount: head.raise_count,
    replacesBidId: head.replaces_bid_id,
    unitRootBidId: head.unit_root_bid_id,
    promotedFrom: from ? { bidId: from.from_id, shopperLabel: `Shopper #${from.from_seq}` } : null,
    promotedTo: to
      ? { bidId: to.to_id, shopperLabel: `Shopper #${to.to_seq}`, amountCents: to.to_cents }
      : null,
    settlements,
    timeline,
  };
}
