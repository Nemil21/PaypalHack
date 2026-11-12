import { z } from 'zod';
import { amountCentsSchema } from './errors.js';

/**
 * Mandates API contract (HF-017b; api.md §Mandates, features/05 §Logic 1, 6). Amounts are integer
 * cents. `POST /api/mandates` creates, `PATCH /api/mandates/:id` changes limits, pauses or
 * resumes, `GET /api/mandates` lists the shopper's own mandates.
 */

export const MANDATE_STATUSES = ['ACTIVE', 'PAUSED', 'FULFILLED', 'EXPIRED', 'REVOKED'] as const;
export type MandateStatusName = (typeof MANDATE_STATUSES)[number];

/** Allowed products per mandate (a Channel3 subscription watches ≤ 25 domains; same order). */
export const MAX_MANDATE_PRODUCTS = 25;

/** Default lifetime of a new mandate, in days (05 §Logic 1). */
export const MANDATE_DEFAULT_DAYS = 30;

/** Pause confirmation copy (ticket HF-017b, screens.md §W17). */
export const MANDATE_PAUSE_CONFIRM = 'This releases all your live holds';

/** Revoke confirmation copy (v4 frame 120:784): revoking is final, unlike pause. */
export const MANDATE_REVOKE_CONFIRM =
  'Revoke this mandate? Your agent stops for good and every live hold is released.';

const productIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_MANDATE_PRODUCTS, `at most ${MAX_MANDATE_PRODUCTS} products`);

const expiresAtSchema = z.iso.datetime({ offset: true });

const capAtLeastMax = {
  message: 'The total hold cap must be at least the max price per item.',
  path: ['totalHoldCapCents'],
};

/** `POST /api/mandates`. Defaults: cap = max price, expiry 30 days, auto-roll and notify on. */
export const createMandateRequestSchema = z
  .object({
    maxPriceCents: amountCentsSchema,
    totalHoldCapCents: amountCentsSchema.optional(),
    productIds: productIdsSchema.optional(),
    autoRoll: z.boolean().optional(),
    notifyEveryAction: z.boolean().optional(),
    expiresAt: expiresAtSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (b) => b.totalHoldCapCents === undefined || b.totalHoldCapCents >= b.maxPriceCents,
    capAtLeastMax,
  );
export type CreateMandateRequest = z.infer<typeof createMandateRequestSchema>;

/**
 * `PATCH /api/mandates/:id`. Limit fields are optional; `status: 'PAUSED'` pauses (and releases
 * every live hold) and must be sent alone; `status: 'REVOKED'` (v4) ends it for good, also
 * releasing every live hold, and must be sent alone; `status: 'ACTIVE'` resumes a paused mandate
 * and may carry new limits.
 */
export const updateMandateRequestSchema = z
  .object({
    maxPriceCents: amountCentsSchema.optional(),
    totalHoldCapCents: amountCentsSchema.optional(),
    productIds: productIdsSchema.optional(),
    autoRoll: z.boolean().optional(),
    notifyEveryAction: z.boolean().optional(),
    expiresAt: expiresAtSchema.optional(),
    status: z.enum(['ACTIVE', 'PAUSED', 'REVOKED']).optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Nothing to change.',
  })
  .refine((b) => b.status !== 'PAUSED' || Object.keys(b).length === 1, {
    message: 'Pause on its own; change limits separately.',
    path: ['status'],
  })
  .refine((b) => b.status !== 'REVOKED' || Object.keys(b).length === 1, {
    message: 'Revoke on its own.',
    path: ['status'],
  })
  .refine(
    (b) =>
      b.totalHoldCapCents === undefined ||
      b.maxPriceCents === undefined ||
      b.totalHoldCapCents >= b.maxPriceCents,
    capAtLeastMax,
  );
export type UpdateMandateRequest = z.infer<typeof updateMandateRequestSchema>;

/** A product a mandate may bid on, with its live listing when there is one. */
export interface MandateProduct {
  productId: string;
  title: string | null;
  imageUrl: string | null;
  /** Slug of the product's OPEN / ROUNDS listing, for "view offer" links. */
  listingSlug: string | null;
}

/** A bid counting toward the cap (D12: PENDING_APPROVAL, HELD, WON, LOST). */
export interface MandateLiveHold {
  bidId: string;
  status: string;
  amountCents: number;
  listingId: string;
  listingSlug: string | null;
  productTitle: string | null;
  placedAt: string;
}

/** W17 / M09 display state (screens.md §W17 States). */
export type MandateState = 'active' | 'paused' | 'expired' | 'fulfilled' | 'revoked';

export interface MandateView {
  mandateId: string;
  status: MandateStatusName;
  state: MandateState;
  maxPriceCents: number;
  totalHoldCapCents: number;
  /** Empty = any product. */
  productIds: string[];
  products: MandateProduct[];
  autoRoll: boolean;
  notifyEveryAction: boolean;
  /** No vaulted method: the agent asks before each hold until one is saved (05 §Logic 2). */
  needsPaymentMethod: boolean;
  /** The shopper has a vaulted PayPal method (S2). */
  savedPaymentMethod: boolean;
  expiresAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  /** Sum of `liveHolds` amounts, compared with `totalHoldCapCents`. */
  liveHoldCents: number;
  liveHolds: MandateLiveHold[];
}

/** `GET /api/mandates`. `productOptions` are products with a live listing, for the picker. */
export interface MandateListBody {
  mandates: MandateView[];
  productOptions: MandateProduct[];
  savedPaymentMethod: boolean;
}

/** `POST` → 201, `GET /:id` and `PATCH` → 200. `release` only after a pause. */
export interface MandateBody {
  mandate: MandateView;
  release?: { voided: number; releasing: number };
}
