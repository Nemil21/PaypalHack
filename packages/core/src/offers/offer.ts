import {
  isBiddable,
  listingPhase,
  type ListingPhaseName,
  type ListingStatus,
} from '@holdfast/shared';
import type { Queryable } from '../db.js';
import type { PublicOffer } from '../bids.js';
import { likelyBand, suggestedBidCents, type PriceBand } from './likely-band.js';

/**
 * `GET /offers/:slug` (api.md; features/03 §Logic 1–2; HF-019). Public: the offer page, the embed
 * (HF-055) and deep links (`?amount=`, HF-039) read it.
 *
 * **The floor is never read here** (M22): the SQL selects explicit columns and `floor_cents` is
 * not one of them, and `likelyBand()` only sees eligible bid amounts and the quantity. A test
 * changes the floor and asserts the body is unchanged.
 */

/** Listings a shopper may see. DRAFT (unpublished) answers 404 like an unknown slug. */
const PUBLIC_STATUSES: readonly ListingStatus[] = [
  'OPEN',
  'ROUNDS',
  'CLEARING',
  'SETTLED',
  'PAID_OUT',
  'PAYOUT_FAILED',
  'CANCELLED',
  'EXPIRED',
];

/** The shopper's live bid here (D3: at most one), for the "already bid" state. */
export interface OfferMyBid {
  bidId: string;
  status: 'PENDING_APPROVAL' | 'HELD';
  amountCents: number;
  paymentMethod: string | null;
  releaseIfCheaper: boolean;
  placedAt: string;
}

export interface OfferView {
  listingId: string;
  slug: string;
  brand: { name: string; verified: boolean };
  product: { title: string | null; imageUrl: string | null; bestPublicPriceCents: number | null };
  publicOffer: PublicOffer | null;
  status: ListingStatus;
  phase: ListingPhaseName;
  /** D7, on DB time: new bids accepted right now. */
  biddable: boolean;
  windowClosesAt: string | null;
  /** Set during live rounds (raises only). */
  roundsEndAt: string | null;
  suggestedBidCents: number | null;
  likelyBand: PriceBand | null;
  myBid: OfferMyBid | null;
}

interface OfferRow {
  id: string;
  slug: string;
  status: ListingStatus;
  quantity: number;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  current_round: number | null;
  db_now: Date;
  brand_name: string;
  brand_status: string;
  title: string | null;
  image_url: string | null;
  best_public_price_cents: number | null;
  best_public_offer_url: string | null;
  best_public_merchant: string | null;
  price_updated_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The offer for `slug`, as `shopperId` sees it; null when there is no public listing. */
export async function loadOffer(
  q: Queryable,
  slug: string,
  shopperId: string | null,
): Promise<OfferView | null> {
  const res = await q.query(
    `SELECT l.id, l.slug, l.status, l.quantity, l.window_closes_at, l.rounds_end_at,
            l.current_round, clock_timestamp() AS db_now,
            b.name AS brand_name, b.verification_status AS brand_status,
            p.title, p.image_url, p.best_public_price_cents, p.best_public_offer_url,
            p.best_public_merchant, p.price_updated_at
       FROM listings l
       JOIN brands b ON b.id = l.brand_id
       JOIN products p ON p.id = l.product_id
      WHERE l.slug = $1 AND l.status = ANY($2::text[])`,
    [slug, PUBLIC_STATUSES],
  );
  const row = res.rows[0] as OfferRow | undefined;
  if (!row) return null;

  const [amounts, mine] = await Promise.all([
    q.query(
      // D8 eligibility, as isEligibleBid / loadClearInput.
      `SELECT amount_cents FROM bids
        WHERE listing_id = $1 AND status = 'HELD'
          AND paypal_authorization_id IS NOT NULL AND paypal_authorization_id <> ''`,
      [row.id],
    ),
    shopperId
      ? q.query(
          `SELECT id, status, amount_cents, payment_method, release_if_cheaper, placed_at
             FROM bids
            WHERE listing_id = $1 AND shopper_id = $2 AND status IN ('PENDING_APPROVAL', 'HELD')
            ORDER BY (status = 'HELD') DESC, placed_at DESC
            LIMIT 1`,
          [row.id, shopperId],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const timing = {
    status: row.status,
    windowClosesAt: row.window_closes_at ?? row.db_now,
    roundsEndAt: row.rounds_end_at,
    currentRound: row.current_round,
  };
  const live = row.status === 'OPEN' || row.status === 'ROUNDS';
  const eligible = (amounts.rows as Array<{ amount_cents: number }>).map((r) => r.amount_cents);
  const my = mine.rows[0] as
    | {
        id: string;
        status: OfferMyBid['status'];
        amount_cents: number;
        payment_method: string | null;
        release_if_cheaper: boolean;
        placed_at: Date;
      }
    | undefined;

  return {
    listingId: row.id,
    slug: row.slug,
    brand: { name: row.brand_name, verified: row.brand_status === 'VERIFIED' },
    product: {
      title: row.title,
      imageUrl: row.image_url,
      bestPublicPriceCents: row.best_public_price_cents,
    },
    publicOffer:
      row.best_public_price_cents == null
        ? null
        : {
            merchant: row.best_public_merchant,
            priceCents: row.best_public_price_cents,
            url: row.best_public_offer_url,
            updatedAt: iso(row.price_updated_at),
          },
    status: row.status,
    phase: listingPhase(timing, row.db_now).phase,
    biddable: !!row.window_closes_at && isBiddable(timing, row.db_now),
    windowClosesAt: iso(row.window_closes_at),
    roundsEndAt: iso(row.rounds_end_at),
    suggestedBidCents: suggestedBidCents(row.best_public_price_cents),
    likelyBand: live ? likelyBand(eligible, row.quantity) : null,
    myBid: my
      ? {
          bidId: my.id,
          status: my.status,
          amountCents: my.amount_cents,
          paymentMethod: my.payment_method,
          releaseIfCheaper: my.release_if_cheaper,
          placedAt: my.placed_at.toISOString(),
        }
      : null,
  };
}
