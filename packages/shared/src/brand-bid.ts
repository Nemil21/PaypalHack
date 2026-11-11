import { z } from 'zod';
import { settlementRowSchema } from './events.js';
import { BID_STATUSES, VOID_REASONS } from './status.js';

/**
 * Payload of `GET /api/listings/:id/bids/:bidId` (HF-035): the W08 bid detail drawer. Brand-scoped
 * (`forBrand`), so another brand's bid is a 404. It carries **no shopper PII**: no email, name,
 * shopper id or PayPal payer id; the shopper is the same opaque "Shopper #241" label as the
 * stream. `.strict()` so a PII field added by mistake fails the schema instead of leaking.
 */

export const brandBidEventSchema = z
  .object({
    at: z.string(),
    /** Raw audit action: `BID_HELD`, `CAPTURE_SUCCEEDED`, `PROMOTED`, `UNFILLED_UNIT`, … */
    action: z.string(),
    actorType: z.string().nullable(),
    /** PayPal order, authorization or capture id; never a payer id. */
    paypalId: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();

export const brandBidViewSchema = z
  .object({
    bidId: z.string().min(1),
    listingId: z.string().min(1),
    /** Opaque per-listing label, as on `bid.held`. */
    shopperLabel: z.string(),
    isSimulated: z.boolean(),
    amountCents: z.number().int(),
    status: z.enum(BID_STATUSES),
    /** OFFER_PAGE, BUYER_AGENT, MCP, SIM (`bids.source` is unconstrained text). */
    source: z.string().nullable(),
    paymentMethod: z.string().nullable(),
    placedAt: z.string(),
    authorizedAt: z.string().nullable(),
    voidReason: z.enum(VOID_REASONS).nullable(),
    raiseCount: z.number().int(),
    replacesBidId: z.string().nullable(),
    /** Original winner's bid for this unit (D10); equals `bidId` for an original winner. */
    unitRootBidId: z.string().nullable(),
    /** This bid was promoted into a failed winner's unit: that winner's bid and label. */
    promotedFrom: z.object({ bidId: z.string(), shopperLabel: z.string() }).strict().nullable(),
    /** This winner's capture failed and its unit went to: that bid, label and own amount. */
    promotedTo: z
      .object({ bidId: z.string(), shopperLabel: z.string(), amountCents: z.number().int() })
      .strict()
      .nullable(),
    settlements: z.array(settlementRowSchema),
    timeline: z.array(brandBidEventSchema),
  })
  .strict();

export type BrandBidEvent = z.infer<typeof brandBidEventSchema>;
export type BrandBidView = z.infer<typeof brandBidViewSchema>;

/** Keys that must never appear anywhere in a brand-side bid payload (tests walk the JSON). */
export const BRAND_BID_FORBIDDEN_KEYS = [
  'email',
  'shopperId',
  'shopper_id',
  'displayName',
  'display_name',
  'payerId',
  'payer_id',
  'payer',
] as const;
