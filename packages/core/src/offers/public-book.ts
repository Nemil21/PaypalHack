import {
  isBiddable,
  listingPhase,
  type ListingPhaseName,
  type ListingStatus,
} from '@holdfast/shared';
import type { Queryable } from '../db.js';
import { demandBands, LIKELY_BAND_MIN_BIDS } from './likely-band.js';

/**
 * `publicBookBands(slug)`: the anonymized book an outside agent sees through MCP `get_book`
 * (HF-044a; features/07 §Logic 5, api.md §MCP server). Public by slug; it never goes through the
 * tenant-scoped brand `GET /listings/:id/book`.
 *
 * **Floor-blind** (M22), like the offer page: the SQL selects explicit columns and `floor_cents`
 * is not one of them; bands come from `demandBands()` over D8-eligible amounts (HELD with an
 * authorization), $10 buckets with thin buckets merged. No shopper id or exact amount leaves here.
 *
 * - Bands only for OPEN / ROUNDS listings (an empty list otherwise).
 * - A band with fewer than `LIKELY_BAND_MIN_BIDS` bids (only possible when the whole book is
 *   that thin) is dropped: one or two bids in a $10 bucket would all but name an amount.
 * - DRAFT or unknown slug → null (the tool's `NOT_FOUND`).
 */

export interface PublicDemandBand {
  /** Inclusive lower edge, a multiple of $10. */
  fromCents: number;
  /** Exclusive upper edge. */
  toCents: number;
  bids: number;
}

export interface PublicBook {
  listingSlug: string;
  brand: { name: string; verified: boolean };
  product: { title: string | null; imageUrl: string | null };
  bestPublicPriceCents: number | null;
  bestPublicMerchant: string | null;
  status: ListingStatus;
  phase: ListingPhaseName;
  /** D7 on DB time: new bids accepted right now. */
  biddable: boolean;
  windowClosesAt: string | null;
  roundsEndAt: string | null;
  /** Highest first. */
  demandBands: PublicDemandBand[];
}

interface Row {
  id: string;
  slug: string;
  status: ListingStatus;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  current_round: number | null;
  db_now: Date;
  brand_name: string;
  brand_status: string;
  title: string | null;
  image_url: string | null;
  best_public_price_cents: number | null;
  best_public_merchant: string | null;
}

const LIVE: readonly ListingStatus[] = ['OPEN', 'ROUNDS'];
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function publicBookBands(q: Queryable, slug: string): Promise<PublicBook | null> {
  const res = await q.query(
    `SELECT l.id, l.slug, l.status, l.window_closes_at, l.rounds_end_at,
            l.current_round, clock_timestamp() AS db_now,
            b.name AS brand_name, b.verification_status AS brand_status,
            p.title, p.image_url, p.best_public_price_cents, p.best_public_merchant
       FROM listings l
       JOIN brands b ON b.id = l.brand_id
       JOIN products p ON p.id = l.product_id
      WHERE l.slug = $1 AND l.status <> 'DRAFT'`,
    [slug],
  );
  const row = res.rows[0] as Row | undefined;
  if (!row) return null;

  const live = LIVE.includes(row.status);
  let bands: PublicDemandBand[] = [];
  if (live) {
    const amounts = await q.query(
      // D8 eligibility, as isEligibleBid / loadClearInput / the offer page.
      `SELECT amount_cents FROM bids
        WHERE listing_id = $1 AND status = 'HELD'
          AND paypal_authorization_id IS NOT NULL AND paypal_authorization_id <> ''`,
      [row.id],
    );
    bands = demandBands(
      (amounts.rows as Array<{ amount_cents: number }>).map((r) => r.amount_cents),
    ).filter((b) => b.bids >= LIKELY_BAND_MIN_BIDS);
  }

  const timing = {
    status: row.status,
    windowClosesAt: row.window_closes_at ?? row.db_now,
    roundsEndAt: row.rounds_end_at,
    currentRound: row.current_round,
  };
  return {
    listingSlug: row.slug,
    brand: { name: row.brand_name, verified: row.brand_status === 'VERIFIED' },
    product: { title: row.title, imageUrl: row.image_url },
    bestPublicPriceCents: row.best_public_price_cents,
    bestPublicMerchant: row.best_public_merchant,
    status: row.status,
    phase: listingPhase(timing, row.db_now).phase,
    biddable: !!row.window_closes_at && isBiddable(timing, row.db_now),
    windowClosesAt: iso(row.window_closes_at),
    roundsEndAt: iso(row.rounds_end_at),
    demandBands: bands,
  };
}
