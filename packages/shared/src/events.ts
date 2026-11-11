import { z } from 'zod';
import {
  BID_STATUSES,
  ERROR_CLASSES,
  LISTING_STATUSES,
  PAYOUT_STATUSES,
  SETTLEMENT_ACTIONS,
  SETTLEMENT_STATUSES,
  VOID_REASONS,
} from './status.js';

/**
 * Events streamed on `GET /api/listings/:id/events` (SSE, HF-008) and published with `pg_notify`
 * inside the business transaction. Keep payloads small: ids, cents and labels; never emails or
 * PayPal payer ids. Every event carries `listingId` and `at` (ISO, server time).
 */

export const BID_SOURCES = ['OFFER_PAGE', 'BUYER_AGENT', 'MCP', 'SIM'] as const;
export type BidSource = (typeof BID_SOURCES)[number];

export const ROUND_END_REASONS = [
  'CAP_REACHED',
  'NO_RAISES',
  'NONE_BELOW_CUTOFF',
  'BRAND_STOPPED',
] as const;
export type RoundEndReason = (typeof ROUND_END_REASONS)[number];

const cents = z.number().int();
const id = z.string().min(1);
const iso = z.string().min(1);

const base = { listingId: id, at: iso };

export const bidHeldEvent = z.object({
  type: z.literal('bid.held'),
  ...base,
  bidId: id,
  /** Opaque per-listing label such as "Shopper #241"; never PII. */
  shopperLabel: z.string(),
  amountCents: cents,
  source: z.enum(BID_SOURCES),
  isSimulated: z.boolean(),
  placedAt: iso,
});

export const bidVoidedEvent = z.object({
  type: z.literal('bid.voided'),
  ...base,
  bidId: id,
  amountCents: cents,
  reason: z.enum(VOID_REASONS),
  status: z.enum(BID_STATUSES),
});

/** Owned by HF-018: a raise is a new hold that replaces the old one (no in-place increase). */
export const bidRaisedEvent = z.object({
  type: z.literal('bid.raised'),
  ...base,
  bidId: id,
  replacesBidId: id,
  oldCents: cents,
  newCents: cents,
  shopperLabel: z.string(),
  source: z.enum(BID_SOURCES),
  isSimulated: z.boolean(),
});

export const settlementCountsSchema = z.object({
  total: z.number().int(),
  queued: z.number().int(),
  running: z.number().int(),
  /** CAPTURE SUCCEEDED with PayPal status COMPLETED. */
  captured: z.number().int(),
  /** CAPTURE SUCCEEDED with PayPal status PENDING ("charged (pending)"). */
  capturePending: z.number().int(),
  /** VOID SUCCEEDED. */
  released: z.number().int(),
  failed: z.number().int(),
  promoted: z.number().int(),
  cancelled: z.number().int(),
});

export const settlementRowSchema = z.object({
  settlementId: id,
  bidId: id,
  shopperLabel: z.string(),
  isSimulated: z.boolean(),
  action: z.enum(SETTLEMENT_ACTIONS),
  status: z.enum(SETTLEMENT_STATUSES),
  amountCents: cents,
  isReserve: z.boolean(),
  /** PayPal capture id or authorization id once known. */
  paypalId: z.string().nullable(),
  /** PayPal body status, e.g. COMPLETED / PENDING / VOIDED. */
  paypalStatus: z.string().nullable(),
  errorClass: z.enum(ERROR_CLASSES).nullable(),
  errorCode: z.string().nullable(),
  attempts: z.number().int(),
  /** Original winner's bid id for this unit (D10); equals `bidId` for an original winner. */
  unitRootBidId: z.string().nullable(),
  /** For a promoted capture: the failed winner it replaced. */
  promotedFromBidId: z.string().nullable(),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});

export const settlementUpdatedEvent = z.object({
  type: z.literal('settlement.updated'),
  ...base,
  row: settlementRowSchema,
  counts: settlementCountsSchema,
});

export const listingStatusEvent = z.object({
  type: z.literal('listing.status'),
  ...base,
  from: z.enum(LISTING_STATUSES).nullable(),
  to: z.enum(LISTING_STATUSES),
});

export const roundStartedEvent = z.object({
  type: z.literal('round.started'),
  ...base,
  round: z.number().int(),
  targetQuantity: z.number().int(),
  cutoffCents: cents.nullable(),
  roundEndsAt: iso.nullable(),
  roundsEndAt: iso,
});

export const roundNudgedEvent = z.object({
  type: z.literal('round.nudged'),
  ...base,
  round: z.number().int(),
  bidId: id,
  shopperLabel: z.string(),
  isSimulated: z.boolean(),
  cutoffCents: cents,
  targetCents: cents,
  text: z.string(),
});

export const roundExtendedEvent = z.object({
  type: z.literal('round.extended'),
  ...base,
  round: z.number().int(),
  roundEndsAt: iso,
  roundsEndAt: iso,
});

export const roundEndedEvent = z.object({
  type: z.literal('round.ended'),
  ...base,
  round: z.number().int(),
  reason: z.enum(ROUND_END_REASONS),
  roundsEndAt: iso,
  clearDeadlineAt: iso.nullable(),
});

export const payoutViewSchema = z.object({
  payoutId: id,
  attempt: z.number().int(),
  status: z.enum(PAYOUT_STATUSES),
  grossCents: cents,
  feeCents: cents,
  netCents: cents,
  paypalBatchId: z.string().nullable(),
  /** Payout item status, e.g. SUCCESS / UNCLAIMED / DENIED. */
  itemStatus: z.string().nullable(),
  failureReason: z.string().nullable(),
});

export const payoutUpdatedEvent = z.object({
  type: z.literal('payout.updated'),
  ...base,
  payout: payoutViewSchema,
});

export const pricewatchReleasedEvent = z.object({
  type: z.literal('pricewatch.released'),
  ...base,
  count: z.number().int(),
  priceCents: cents,
  merchant: z.string(),
});

export const listingEventSchema = z.discriminatedUnion('type', [
  bidHeldEvent,
  bidVoidedEvent,
  bidRaisedEvent,
  settlementUpdatedEvent,
  listingStatusEvent,
  roundStartedEvent,
  roundNudgedEvent,
  roundExtendedEvent,
  roundEndedEvent,
  payoutUpdatedEvent,
  pricewatchReleasedEvent,
]);

export type ListingEvent = z.infer<typeof listingEventSchema>;
export type ListingEventType = ListingEvent['type'];
export type ListingEventOf<T extends ListingEventType> = Extract<ListingEvent, { type: T }>;
export type SettlementCounts = z.infer<typeof settlementCountsSchema>;
export type SettlementRow = z.infer<typeof settlementRowSchema>;
export type PayoutView = z.infer<typeof payoutViewSchema>;

export const LISTING_EVENT_TYPES = listingEventSchema.options.map(
  (o) => o.shape.type.value,
) as ListingEventType[];

/** Validate an untrusted payload (e.g. an SSE frame) as a ListingEvent. */
export function parseListingEvent(input: unknown): ListingEvent {
  return listingEventSchema.parse(input);
}
