import { formatUsd, type BidStatus } from '@holdfast/shared';
import type { MyBid } from './bids';

/**
 * W18 / M08 won page (HF-059a). Mirrors `GET /api/bids/:id/won` (core/bid-won.ts); the copy
 * itself (D14 headline, "You moved up from the reserve list") is built server-side so the web, MCP
 * and notifications say the same thing.
 */

export type ShippingStage = 'ORDERED' | 'SHIPPED' | 'OUT_FOR_DELIVERY' | 'DELIVERED';

export interface WonShipment {
  status: string;
  stage: ShippingStage;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  updatedAt: string;
}

export interface WonView {
  bidId: string;
  status: 'WON' | 'CAPTURED' | 'SHIPPED';
  amountCents: number;
  headline: string;
  promoted: boolean;
  promotedNote: string | null;
  listing: MyBid['listing'];
  receipt: {
    chargedCents: number;
    captureId: string | null;
    capturedAt: string | null;
    paymentMethod: string | null;
  } | null;
  released: Array<{ bidId: string; amountCents: number; text: string }>;
  shipment: WonShipment | null;
}

/** W14 / W15 statuses that link to the won page. */
export function hasWonPage(status: BidStatus): boolean {
  return status === 'WON' || status === 'CAPTURED' || status === 'SHIPPED';
}

export const NOT_SHIPPED_COPY =
  "Not shipped yet. We'll show tracking here once the brand ships it.";
export const CHARGING_COPY = 'Charging your card now. This page updates by itself.';

/** M08 tracker steps, in order. */
export const TRACKER_STEPS: ReadonlyArray<{ stage: ShippingStage; label: string }> = [
  { stage: 'ORDERED', label: 'Ordered' },
  { stage: 'SHIPPED', label: 'Shipped' },
  { stage: 'OUT_FOR_DELIVERY', label: 'Out for delivery' },
  { stage: 'DELIVERED', label: 'Delivered' },
];

export interface TrackerStep {
  stage: ShippingStage;
  label: string;
  done: boolean;
  current: boolean;
}

/** Each step is done up to and including the parcel's stage (no shipment = ordered). */
export function trackerSteps(shipment: WonShipment | null): TrackerStep[] {
  const at = TRACKER_STEPS.findIndex((s) => s.stage === (shipment?.stage ?? 'ORDERED'));
  return TRACKER_STEPS.map((s, i) => ({ ...s, done: i <= at, current: i === at }));
}

/** v4 tracker (frame 119:788): the line under each step. */
export function trackerDetail(stage: ShippingStage, brandName: string | null | undefined): string {
  switch (stage) {
    case 'ORDERED':
      return `${brandName ?? 'The brand'} adds tracking after clearing`;
    case 'SHIPPED':
      return 'Tracking accepted by PayPal';
    case 'OUT_FOR_DELIVERY':
      return 'Shown once the carrier reports it';
    case 'DELIVERED':
      return 'Signed for at your address';
  }
}

/** W18 states: awaiting shipment, in transit, delivered. */
export function shippingSummary(shipment: WonShipment | null): string {
  switch (shipment?.stage ?? 'ORDERED') {
    case 'ORDERED':
      return NOT_SHIPPED_COPY;
    case 'SHIPPED':
    case 'OUT_FOR_DELIVERY':
      return 'On its way.';
    case 'DELIVERED':
      return 'Delivered.';
  }
}

const METHOD_LABEL: Record<string, string> = {
  CARD: 'Card',
  PAYPAL: 'PayPal',
  VAULT: 'Saved card',
  TEST_CARD: 'Test card (sandbox)',
};

export interface ReceiptLine {
  label: string;
  value: string;
  mono?: boolean;
}

/** Receipt card rows: charged (= the bid), PayPal capture id, date, method. */
export function receiptLines(view: WonView, formatDate: (iso: string) => string): ReceiptLine[] {
  const r = view.receipt;
  if (!r) return [];
  const lines: ReceiptLine[] = [
    { label: 'Your bid', value: formatUsd(view.amountCents), mono: true },
    { label: 'Charged', value: formatUsd(r.chargedCents), mono: true },
  ];
  if (r.capturedAt) lines.push({ label: 'Date', value: formatDate(r.capturedAt) });
  if (r.paymentMethod) {
    lines.push({ label: 'Paid with', value: METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod });
  }
  if (r.captureId) lines.push({ label: 'PayPal capture ID', value: r.captureId, mono: true });
  return lines;
}
