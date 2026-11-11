import { z } from 'zod';
import { amountCentsSchema } from './errors.js';

/** `bids.payment_method` (api.md §`POST /bids`). */
export const BID_PAYMENT_METHODS = ['PAYPAL', 'CARD', 'VAULT', 'TEST_CARD'] as const;
export type BidPaymentMethodName = (typeof BID_PAYMENT_METHODS)[number];

/**
 * `POST /api/bids` body. Raw card data is never accepted: `TEST_CARD` uses the server's sandbox
 * card (seed / labelled demo button only). `source` is set by the server, never by the client.
 */
export const placeBidRequestSchema = z
  .object({
    listingId: z.string().uuid(),
    amountCents: amountCentsSchema,
    paymentMethod: z.enum(BID_PAYMENT_METHODS),
    /** Default true. Confirming the over-public-price warning sends false (03, 06). */
    releaseIfCheaper: z.boolean().optional(),
    intentId: z.string().uuid().nullable().optional(),
    mandateId: z.string().uuid().nullable().optional(),
    /** Share-link attribution (14). */
    utmSource: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict();
export type PlaceBidRequest = z.infer<typeof placeBidRequestSchema>;

/** `POST /api/bids/:id/raise` body (HF-018). The new amount; everything else is inherited. */
export const raiseBidRequestSchema = z
  .object({
    amountCents: amountCentsSchema,
  })
  .strict();
export type RaiseBidRequest = z.infer<typeof raiseBidRequestSchema>;

/**
 * `PATCH /api/bids/:id` body (HF-020; api.md, features/06): the per-bid "Release my hold if it's
 * cheaper elsewhere" setting. Owner only, live bids only.
 */
export const patchBidRequestSchema = z.object({ releaseIfCheaper: z.boolean() }).strict();
export type PatchBidRequest = z.infer<typeof patchBidRequestSchema>;
