import { moneyCopyKey, wonMessage, type BidStatus } from '@holdfast/shared';
import { getBidDetail, type MyBidListing } from './bid-views.js';
import type { Queryable } from './db.js';

/**
 * W18 / M08 won page (HF-059a; screens.md §W18, §M08, features/12 §Logic 3). Read-only and
 * owner-scoped like the other shopper bid views (`getBidDetail` does the ownership check): another
 * shopper's bid is simply not found.
 *
 * Pay-your-bid (D14): the winner is charged their own bid, so the charged amount is the bid's
 * `authorized_amount_cents` (= `amount_cents`, INV-5) and "Charged" appears only once the capture
 * succeeded (CAPTURED / SHIPPED). Shipping progress comes from the HF-059b `shipments` row.
 */

/** The statuses that have a won page; anything else answers `NOT_WON`. */
export const WON_PAGE_STATUSES: ReadonlySet<BidStatus> = new Set(['WON', 'CAPTURED', 'SHIPPED']);

export const MOVED_UP_COPY = 'You moved up from the reserve list';

/** M08 tracker: ordered → shipped → out for delivery → delivered. */
export type ShippingStage = 'ORDERED' | 'SHIPPED' | 'OUT_FOR_DELIVERY' | 'DELIVERED';

export interface WonShipment {
  /** `shipments.status`: PENDING, SHIPPED, DELIVERED or TRACKING_FAILED (HF-059b). */
  status: string;
  /** Where the parcel is: no tracking number yet = still ORDERED ("not shipped yet"). */
  stage: ShippingStage;
  carrier: string | null;
  trackingNumber: string | null;
  /** The carrier's public tracking page, for known carriers only. */
  trackingUrl: string | null;
  shippedAt: string | null;
  updatedAt: string;
}

export interface WonReleasedHold {
  bidId: string;
  amountCents: number;
  /** "$219 released. Your bank may show it…" or "Releasing your $219 hold." (D14). */
  text: string;
}

export interface WonReceipt {
  /** The bid (= `authorized_amount_cents`); never a clearing price (D14). */
  chargedCents: number;
  captureId: string | null;
  capturedAt: string | null;
  paymentMethod: string | null;
}

export interface WonView {
  bidId: string;
  status: 'WON' | 'CAPTURED' | 'SHIPPED';
  amountCents: number;
  /** "You won at your bid of $229. Charged $229." ("Charged …" only after the capture, D14). */
  headline: string;
  /** Promoted from the reserve list (HF-031: `unit_root_bid_id` is another bid). */
  promoted: boolean;
  promotedNote: string | null;
  listing: MyBidListing;
  /** Null until the capture succeeded (WON = "charging"). */
  receipt: WonReceipt | null;
  /** Earlier holds on this bid's raise chain, released when the shopper raised. */
  released: WonReleasedHold[];
  /** Null = not shipped yet (no shipments row). */
  shipment: WonShipment | null;
}

export type WonViewResult =
  { ok: true; view: WonView } | { ok: false; code: 'NOT_FOUND' | 'NOT_WON' };

const CARRIER_URLS: Record<string, (n: string) => string> = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  FEDEX: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  DHL: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}`,
  DHL_API: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}`,
};

/** A public tracking link for the PayPal carrier codes we know; null for anything else. */
export function carrierTrackingUrl(
  carrier: string | null,
  trackingNumber: string | null,
): string | null {
  if (!carrier || !trackingNumber) return null;
  const build =
    CARRIER_URLS[
      carrier
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_')
    ];
  return build ? build(encodeURIComponent(trackingNumber.trim())) : null;
}

/**
 * Stage from the shipments row. Without carrier events we only know "has a tracking number"
 * (shipped) and DELIVERED; out for delivery is reached together with delivered.
 */
export function shippingStage(
  s: { status: string; tracking_number: string | null } | null,
): ShippingStage {
  if (!s) return 'ORDERED';
  if (s.status === 'DELIVERED') return 'DELIVERED';
  return s.tracking_number ? 'SHIPPED' : 'ORDERED';
}

interface WonRow {
  authorized_amount_cents: number | null;
  amount_cents: number;
  payment_method: string | null;
  promoted: boolean;
  capture_id: string | null;
  captured_at: Date | null;
  shipment_status: string | null;
  carrier: string | null;
  tracking_number: string | null;
  shipped_at: Date | null;
  shipment_updated_at: Date | null;
}

/** `GET /bids/:id/won`. */
export async function getWonView(
  q: Queryable,
  shopperId: string,
  bidId: string,
): Promise<WonViewResult> {
  const detail = await getBidDetail(q, shopperId, bidId);
  if (!detail) return { ok: false, code: 'NOT_FOUND' };
  const { bid } = detail;
  if (!WON_PAGE_STATUSES.has(bid.status)) return { ok: false, code: 'NOT_WON' };

  const row = (
    await q.query(
      `SELECT b.authorized_amount_cents, b.amount_cents, b.payment_method,
              (b.unit_root_bid_id IS NOT NULL AND b.unit_root_bid_id <> b.id) AS promoted,
              s.paypal_id AS capture_id, s.finished_at AS captured_at,
              sh.status AS shipment_status, sh.carrier, sh.tracking_number, sh.shipped_at,
              sh.updated_at AS shipment_updated_at
         FROM bids b
         LEFT JOIN settlements s ON s.bid_id = b.id AND s.action = 'CAPTURE' AND s.status = 'SUCCEEDED'
         LEFT JOIN shipments sh ON sh.bid_id = b.id
        WHERE b.id = $1 AND b.shopper_id = $2`,
      [bidId, shopperId],
    )
  ).rows[0] as WonRow | undefined;
  if (!row) return { ok: false, code: 'NOT_FOUND' };

  const captured = moneyCopyKey(bid.status) === 'charged';
  // INV-5: the authorization equals the bid; fall back to the bid for a row predating it.
  const chargedCents = row.authorized_amount_cents ?? row.amount_cents;
  const shipment =
    row.shipment_status == null
      ? null
      : {
          status: row.shipment_status,
          stage: shippingStage({
            status: row.shipment_status,
            tracking_number: row.tracking_number,
          }),
          carrier: row.carrier,
          trackingNumber: row.tracking_number,
          trackingUrl: carrierTrackingUrl(row.carrier, row.tracking_number),
          shippedAt: row.shipped_at?.toISOString() ?? null,
          updatedAt: (row.shipment_updated_at ?? new Date()).toISOString(),
        };

  return {
    ok: true,
    view: {
      bidId: bid.bidId,
      status: bid.status as WonView['status'],
      amountCents: bid.amountCents,
      headline: wonMessage(bid.amountCents, { captured }),
      promoted: row.promoted,
      promotedNote: row.promoted ? MOVED_UP_COPY : null,
      listing: bid.listing,
      receipt: captured
        ? {
            chargedCents,
            captureId: row.capture_id,
            capturedAt: row.captured_at?.toISOString() ?? null,
            paymentMethod: row.payment_method,
          }
        : null,
      released: detail.chain
        .filter(
          (c) => c.bidId !== bid.bidId && (c.moneyKey === 'released' || c.moneyKey === 'releasing'),
        )
        .map((c) => ({ bidId: c.bidId, amountCents: c.amountCents, text: c.moneyText })),
      shipment,
    },
  };
}
