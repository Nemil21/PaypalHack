import { z } from 'zod';
import { LISTING_STATUSES } from './status.js';
import { payoutViewSchema, settlementCountsSchema, settlementRowSchema } from './events.js';

/**
 * Payload of `GET /api/listings/:id/settlement` (HF-030a) and the W08 settlement view (HF-035).
 * Live updates arrive as `settlement.updated` / `payout.updated` events carrying the same row and
 * payout shapes.
 */
export const settlementViewSchema = z.object({
  listingId: z.string().min(1),
  listingStatus: z.enum(LISTING_STATUSES),
  /** Units chosen at Clear. */
  quantity: z.number().int(),
  /** Units with no successful capture and no remaining promotion candidate. */
  unfilledUnits: z.number().int(),
  /** Gross agreed at Clear (sum of winners' bids): "Cleared $X". */
  clearedCents: z.number().int(),
  /** Sum of SUCCEEDED captures: "Captured $Y". */
  capturedCents: z.number().int(),
  cutoffCents: z.number().int().nullable(),
  feeBps: z.number().int(),
  counts: settlementCountsSchema,
  rows: z.array(settlementRowSchema),
  payout: payoutViewSchema.nullable(),
  updatedAt: z.string(),
});

export type SettlementView = z.infer<typeof settlementViewSchema>;
