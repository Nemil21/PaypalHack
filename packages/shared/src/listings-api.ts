import { z } from 'zod';
import { amountCentsSchema } from './errors.js';
import type { ListingStatus } from './status.js';

/**
 * Listings API contracts (HF-012a; api.md §`POST /listings`, §`/publish`). Shared by the API and
 * the create-listing wizard (HF-013).
 */

/** Window lengths a listing may use (D6, 02 §Logic 3): card holds are guaranteed for 3 days. */
export const LISTING_WINDOW_HOURS = [24, 48] as const;
export type ListingWindowHours = (typeof LISTING_WINDOW_HOURS)[number];

/** `clear_deadline_at = least(window_closes_at + 6 h, window_opens_at + 60 h)` (D6). */
export const CLEAR_AFTER_CLOSE_HOURS = 6;
export const CLEAR_MAX_AFTER_OPEN_HOURS = 60;

export const MAX_LISTING_QUANTITY = 100_000;

/**
 * `POST /api/listings` body. `channel3Id` + `variant` pick the product from the wizard search;
 * `gtin` / `mpn` are typed by hand (Channel3 rarely has them, and they are the only identity when
 * Channel3 is down). Without a `channel3Id` the listing is manual-only: `title` and a GTIN or MPN
 * are required and price watch stays off.
 */
export const createListingRequestSchema = z
  .object({
    channel3Id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be a Channel3 product id')
      .optional(),
    /** `products.channel3_variant` key (`Color=Green`) or its label (`Green`); null = none. */
    variant: z.string().trim().min(1).max(200).nullable().optional(),
    gtin: z.string().trim().max(32).nullable().optional(),
    mpn: z.string().trim().max(64).nullable().optional(),
    /** Product title, needed only for a manual listing (no `channel3Id`). */
    title: z.string().trim().min(1).max(200).optional(),
    quantity: z.number().int('must be a whole number').min(1).max(MAX_LISTING_QUANTITY),
    floorCents: amountCentsSchema,
    liquidationQuoteCents: z.number().int('must be whole cents').min(0).max(100_000_000),
    windowHours: z.union([z.literal(24), z.literal(48)], { error: 'must be 24 or 48' }),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.channel3Id) return;
    if (!body.title) {
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'is required without channel3Id' });
    }
    if (!body.gtin && !body.mpn) {
      ctx.addIssue({
        code: 'custom',
        path: ['gtin'],
        message: 'a GTIN or MPN is required without channel3Id',
      });
    }
  });
export type CreateListingRequest = z.infer<typeof createListingRequestSchema>;

/** `GET /api/listings?status=OPEN,ROUNDS` query. */
export const listListingsQuerySchema = z.object({
  status: z
    .string()
    .trim()
    .regex(/^[A-Z_]+(,[A-Z_]+)*$/, 'comma-separated listing statuses')
    .optional(),
});

/** `201` from `POST /api/listings`. */
export interface CreateListingResponse {
  listingId: string;
  status: 'DRAFT';
  slug: string;
  productId: string;
  windowHours: ListingWindowHours;
  /** Cheapest exact-match public offer at creation; null = unknown (floor check skipped). */
  bestPublicPriceCents: number | null;
  /** False when Channel3 was unreachable and the identity came from the cache or by hand. */
  channel3Available: boolean;
}

/** `200` from `POST /api/listings/:id/publish`. */
export interface PublishListingResponse {
  listingId: string;
  status: 'OPEN';
  slug: string;
  /** Shopper offer page path (`/o/:slug`). */
  offerPath: string;
  windowOpensAt: string;
  windowClosesAt: string;
  clearDeadlineAt: string;
  /** False when the Channel3 subscription is missing (badge); it is retried in the background. */
  priceWatch: boolean;
}

/** One row of `GET /api/listings`. Never exposes another brand's data. */
export interface BrandListingView {
  listingId: string;
  slug: string | null;
  status: ListingStatus;
  offerPath: string | null;
  quantity: number;
  floorCents: number;
  liquidationQuoteCents: number | null;
  windowHours: number | null;
  windowOpensAt: string | null;
  windowClosesAt: string | null;
  clearDeadlineAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  priceWatch: boolean;
  product: {
    productId: string;
    title: string | null;
    brandName: string | null;
    imageUrl: string | null;
    channel3Id: string | null;
    variant: string | null;
    gtin: string | null;
    mpn: string | null;
    bestPublicPriceCents: number | null;
  };
}

/**
 * `PATCH /api/listings/:id` body (HF-012b; 02 §Edge cases): quantity only, upward only, while
 * OPEN. Floor and window are locked after publish (fairness), so any other field is refused.
 */
export const updateListingRequestSchema = z
  .object({
    quantity: z.number().int('must be a whole number').min(1).max(MAX_LISTING_QUANTITY),
  })
  .strict();
export type UpdateListingRequest = z.infer<typeof updateListingRequestSchema>;

/** `200` from `PATCH /api/listings/:id`. */
export interface UpdateListingResponse {
  listingId: string;
  status: 'OPEN';
  previousQuantity: number;
  quantity: number;
}

/**
 * `202` from `POST /api/listings/:id/cancel` (HF-012b; api.md §`/cancel`). The listing is
 * CANCELLED on return; `voiding` HELD bids are released asynchronously (progress over SSE:
 * `listing.status`, then one `bid.voided` per bid) and `abandoned` pending bids never held money.
 */
export interface CancelListingResponse {
  listingId: string;
  status: 'CANCELLED';
  from: 'OPEN' | 'ROUNDS';
  voiding: number;
  abandoned: number;
}

export const offerPathOf = (slug: string) => `/o/${encodeURIComponent(slug)}`;
export const listingConsolePathOf = (listingId: string) =>
  `/brand/listings/${encodeURIComponent(listingId)}`;
