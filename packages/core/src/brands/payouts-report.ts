import {
  averageCents,
  feeCents,
  statementTotals,
  type BrandPayoutRow,
  type BrandPayoutsBody,
  type BrandReportBody,
  type ListingStatement,
  type ListingStatus,
  type PayoutStatus,
} from '@holdfast/shared';
import type { Queryable } from '../db.js';
import { payoutFailureReason } from '../payouts/payout-brand.js';

/**
 * W09 reads (HF-059b; features/12 §Logic 4, api.md §`/brands/me/payouts`, §`/brands/me/reports`).
 * Scoped to the session brand: every query filters `l.brand_id = $1`.
 *
 * Statement money is computed from the capture records at read time, never copied from the
 * payout row, so the W09 numbers always equal the sum of COMPLETED captures (acceptance
 * criterion). Same gross rule as `payoutBrand` (B7, D8): `settlements` CAPTURE SUCCEEDED with
 * `paypal_status = 'COMPLETED'`; a simulated shopper or a `SIM` bid is reported apart.
 * Fee = the shared `feeCents` at the brand's `fee_bps`; when a payout attempt exists for exactly
 * this gross, its stored fee is used, so the statement matches what was actually paid.
 */

const iso = (v: Date | null) => (v ? v.toISOString() : null);
const int = (v: unknown) => Number(v ?? 0);

/** Every payout attempt of the brand, newest first. */
export async function brandPayouts(q: Queryable, brandId: string): Promise<BrandPayoutsBody> {
  const rows = (
    await q.query<{
      id: string;
      listing_id: string;
      title: string | null;
      listing_status: ListingStatus;
      attempt: number;
      status: PayoutStatus;
      gross_cents: number | null;
      fee_cents: number | null;
      net_cents: number | null;
      item_status: string | null;
      paypal_batch_id: string | null;
      error_code: string | null;
      created_at: Date;
      sent_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT p.id, p.listing_id, pr.title, l.status AS listing_status, p.attempt, p.status,
              p.gross_cents, p.fee_cents, p.net_cents, p.item_status, p.paypal_batch_id,
              p.error_code, p.created_at, p.sent_at, p.completed_at
         FROM payouts p
         JOIN listings l ON l.id = p.listing_id
         LEFT JOIN products pr ON pr.id = l.product_id
        WHERE l.brand_id = $1
        ORDER BY p.created_at DESC, p.attempt DESC`,
      [brandId],
    )
  ).rows;
  const payouts: BrandPayoutRow[] = rows.map((r) => ({
    payoutId: r.id,
    listingId: r.listing_id,
    productTitle: r.title ?? 'Listing',
    listingStatus: r.listing_status,
    attempt: r.attempt,
    status: r.status,
    grossCents: r.gross_cents,
    feeCents: r.fee_cents,
    netCents: r.net_cents,
    itemStatus: r.item_status,
    paypalBatchId: r.paypal_batch_id,
    failureReason: payoutFailureReason(r.error_code),
    createdAt: r.created_at.toISOString(),
    sentAt: iso(r.sent_at),
    completedAt: iso(r.completed_at),
  }));
  return { payouts };
}

export interface ReportRange {
  /** Inclusive lower bound on `cleared_at`. */
  from?: Date | null;
  /** Exclusive upper bound on `cleared_at`. */
  to?: Date | null;
}

/** Per-listing statements for listings cleared in `[from, to)`, newest first. */
export async function brandReport(
  q: Queryable,
  brandId: string,
  range: ReportRange = {},
): Promise<BrandReportBody> {
  const rows = (
    await q.query<{
      id: string;
      title: string | null;
      status: ListingStatus;
      cleared_at: Date | null;
      cutoff_cents: number | null;
      fee_bps: number;
      units: number;
      gross_real: string;
      units_sim: number;
      gross_sim: string;
      payout_status: PayoutStatus | null;
      payout_attempt: number | null;
      payout_gross: number | null;
      payout_fee: number | null;
    }>(
      `WITH caps AS (
         SELECT s.listing_id,
                ((coalesce(sh.is_simulated, false) OR b.source = 'SIM') IS TRUE) AS sim,
                s.amount_cents
           FROM settlements s
           JOIN bids b ON b.id = s.bid_id
           JOIN listings l ON l.id = s.listing_id
           LEFT JOIN shoppers sh ON sh.id = b.shopper_id
          WHERE l.brand_id = $1 AND s.action = 'CAPTURE' AND s.status = 'SUCCEEDED'
            AND s.paypal_status = 'COMPLETED'
       )
       SELECT l.id, p.title, l.status, l.cleared_at, l.cutoff_cents, br.fee_bps,
              (SELECT count(*) FROM caps c WHERE c.listing_id = l.id AND NOT c.sim)::int AS units,
              (SELECT coalesce(sum(c.amount_cents), 0) FROM caps c
                WHERE c.listing_id = l.id AND NOT c.sim)::bigint AS gross_real,
              (SELECT count(*) FROM caps c WHERE c.listing_id = l.id AND c.sim)::int AS units_sim,
              (SELECT coalesce(sum(c.amount_cents), 0) FROM caps c
                WHERE c.listing_id = l.id AND c.sim)::bigint AS gross_sim,
              po.status AS payout_status, po.attempt AS payout_attempt,
              po.gross_real_cents AS payout_gross, po.fee_cents AS payout_fee
         FROM listings l
         JOIN brands br ON br.id = l.brand_id
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN LATERAL (
           SELECT status, attempt, gross_real_cents, fee_cents FROM payouts
            WHERE listing_id = l.id ORDER BY attempt DESC LIMIT 1
         ) po ON true
        WHERE l.brand_id = $1 AND l.cleared_at IS NOT NULL
          AND ($2::timestamptz IS NULL OR l.cleared_at >= $2)
          AND ($3::timestamptz IS NULL OR l.cleared_at < $3)
        ORDER BY l.cleared_at DESC, l.id`,
      [brandId, range.from ?? null, range.to ?? null],
    )
  ).rows;

  const statements: ListingStatement[] = rows.map((r) => {
    const gross = int(r.gross_real);
    const fee =
      r.payout_fee !== null && r.payout_gross === gross ? r.payout_fee : feeCents(gross, r.fee_bps);
    return {
      listingId: r.id,
      productTitle: r.title ?? 'Listing',
      listingStatus: r.status,
      clearedAt: iso(r.cleared_at),
      cutoffCents: r.cutoff_cents,
      units: r.units,
      grossRealCents: gross,
      feeBps: r.fee_bps,
      feeCents: fee,
      netCents: gross - fee,
      averageCents: averageCents(gross, r.units),
      unitsSimulated: r.units_sim,
      grossSimulatedCents: int(r.gross_sim),
      payoutStatus: r.payout_status,
      payoutAttempt: r.payout_attempt,
    };
  });
  return {
    from: iso(range.from ?? null),
    to: iso(range.to ?? null),
    statements,
    totals: statementTotals(statements),
  };
}
