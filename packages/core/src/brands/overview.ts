import {
  cumulativeHourly,
  feeCents,
  listingPhase,
  netCents,
  OVERVIEW_ACTIVITY_ACTIONS,
  OVERVIEW_ACTIVITY_LIMIT,
  projectActivity,
  type BrandOverview,
  type OverviewActivity,
  type OverviewListingCard,
} from '@holdfast/shared';
import type { Queryable } from '../db.js';
import { forBrand, NotFoundError } from '../tenancy.js';

/**
 * W04 overview (HF-026; screens.md §W04, features/08 §Overview W04). One read, scoped to the
 * session brand: every query below either goes through `forBrand` or filters `l.brand_id = $1`.
 *
 * - Held = D8 eligibility (HELD with an authorization id), the same rule as `/book` and Clear.
 * - Recovered / captured = COMPLETED real captures, the payout's gross rule (HF-032, B7): a
 *   PENDING capture, a simulated shopper or a `SIM` bid never counts as money recovered.
 * - Sparkline = cumulative cents by hour of `bids.placed_at`. For a live listing it plots the
 *   holds that are live now (so it ends at the card's held $); afterwards, every bid that held,
 *   minus the old half of a raise (`REPLACED`), so a settled card keeps its demand history.
 */

const LIVE = ['OPEN', 'ROUNDS'];
const ELIGIBLE = `b.status = 'HELD' AND coalesce(b.paypal_authorization_id, '') <> ''`;
const REAL_COMPLETED_CAPTURE = `s.action = 'CAPTURE' AND s.status = 'SUCCEEDED'
  AND s.paypal_status = 'COMPLETED'
  AND NOT ((coalesce(sh.is_simulated, false) OR b.source = 'SIM') IS TRUE)`;

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null;
const ms = (v: unknown): number | null => (v instanceof Date ? v.getTime() : null);
const int = (v: unknown): number => Number(v ?? 0);

export async function brandOverview(q: Queryable, brandId: string): Promise<BrandOverview> {
  const scope = forBrand(q, brandId);
  const brand = (
    await q.query<{
      id: string;
      name: string;
      verification_status: string;
      fee_bps: number;
      as_of: Date;
      month_start: Date;
    }>(
      `SELECT id, name, verification_status, fee_bps, now() AS as_of,
              date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start
         FROM brands WHERE id = $1`,
      [brandId],
    )
  ).rows[0];
  if (!brand) throw new NotFoundError('brand');
  const asOf = brand.as_of.getTime();

  const [listings, products, bidStats, captures, payouts, buckets, audit] = await Promise.all([
    scope.listings(),
    q.query<{ listing_id: string; title: string | null; image_url: string | null }>(
      `SELECT l.id AS listing_id, p.title, p.image_url
         FROM listings l JOIN products p ON p.id = l.product_id WHERE l.brand_id = $1`,
      [brandId],
    ),
    q.query<{ listing_id: string; live_bids: number; held: string; oldest: Date | null }>(
      `SELECT b.listing_id,
              count(*) FILTER (WHERE ${ELIGIBLE})::int AS live_bids,
              coalesce(sum(b.amount_cents) FILTER (WHERE ${ELIGIBLE}), 0)::bigint AS held,
              min(b.authorized_at) FILTER (WHERE ${ELIGIBLE}) AS oldest
         FROM bids b JOIN listings l ON l.id = b.listing_id
        WHERE l.brand_id = $1
        GROUP BY b.listing_id`,
      [brandId],
    ),
    q.query<{ listing_id: string; total: string; month: string }>(
      `SELECT s.listing_id,
              sum(s.amount_cents)::bigint AS total,
              coalesce(sum(s.amount_cents)
                FILTER (WHERE coalesce(s.finished_at, s.updated_at) >= $2), 0)::bigint AS month
         FROM settlements s
         JOIN listings l ON l.id = s.listing_id
         JOIN bids b ON b.id = s.bid_id
         LEFT JOIN shoppers sh ON sh.id = b.shopper_id
        WHERE l.brand_id = $1 AND ${REAL_COMPLETED_CAPTURE}
        GROUP BY s.listing_id`,
      [brandId, brand.month_start],
    ),
    q.query<{ listing_id: string; status: string; net_cents: number | null }>(
      `SELECT DISTINCT ON (p.listing_id) p.listing_id, p.status, p.net_cents
         FROM payouts p JOIN listings l ON l.id = p.listing_id
        WHERE l.brand_id = $1
        ORDER BY p.listing_id, p.attempt DESC`,
      [brandId],
    ),
    q.query<{ listing_id: string; hour_s: string; cents: string }>(
      `SELECT b.listing_id,
              (floor(extract(epoch FROM b.placed_at) / 3600) * 3600)::bigint AS hour_s,
              sum(b.amount_cents)::bigint AS cents
         FROM bids b JOIN listings l ON l.id = b.listing_id
        WHERE l.brand_id = $1
          AND CASE WHEN l.status = ANY($2::text[]) THEN ${ELIGIBLE}
                   ELSE b.authorized_at IS NOT NULL
                        AND b.void_reason IS DISTINCT FROM 'REPLACED' END
        GROUP BY 1, 2`,
      [brandId, LIVE],
    ),
    scope.auditEvents({ actions: OVERVIEW_ACTIVITY_ACTIONS, limit: OVERVIEW_ACTIVITY_LIMIT }),
  ]);

  const product = new Map(products.rows.map((r) => [r.listing_id, r]));
  const stats = new Map(bidStats.rows.map((r) => [r.listing_id, r]));
  const captured = new Map(captures.rows.map((r) => [r.listing_id, r]));
  const payout = new Map(payouts.rows.map((r) => [r.listing_id, r]));
  const hourly = new Map<string, Array<{ hourMs: number; cents: number }>>();
  for (const r of buckets.rows) {
    const list = hourly.get(r.listing_id) ?? [];
    list.push({ hourMs: int(r.hour_s) * 1000, cents: int(r.cents) });
    hourly.set(r.listing_id, list);
  }

  let heldNowCents = 0;
  let recoveredThisMonthCents = 0;
  let feesThisMonthCents = 0;
  let payoutPendingCents = 0;
  let liveListings = 0;

  const cards: OverviewListingCard[] = listings.map((l) => {
    const p = product.get(l.id);
    const s = stats.get(l.id);
    const c = captured.get(l.id);
    const live = LIVE.includes(l.status);
    const heldCents = int(s?.held);
    const capturedCents = int(c?.total);
    const month = int(c?.month);

    if (live) {
      liveListings += 1;
      heldNowCents += heldCents;
    }
    recoveredThisMonthCents += month;
    feesThisMonthCents += feeCents(month, brand.fee_bps);
    const po = payout.get(l.id);
    if (po) {
      if (po.status !== 'SUCCESS') payoutPendingCents += po.net_cents ?? 0;
    } else if (l.status === 'CLEARING' || l.status === 'SETTLED') {
      payoutPendingCents += netCents(capturedCents, brand.fee_bps);
    }

    const timing = {
      status: l.status,
      windowClosesAt: l.window_closes_at ?? asOf,
      roundsEndAt: l.rounds_end_at,
      roundEndsAt: (l.round_ends_at as Date | null) ?? null,
      clearDeadlineAt: l.clear_deadline_at,
      currentRound: (l.current_round as number | null) ?? null,
      oldestHoldAuthorizedAt: s?.oldest ?? null,
    };
    const opened = ms(l.window_opens_at) ?? ms(l.created_at) ?? asOf;
    const closed = Math.max(ms(l.rounds_end_at) ?? 0, ms(l.window_closes_at) ?? 0) || asOf;
    const ended = live ? asOf : Math.min(asOf, ms(l.cleared_at) ?? closed);
    return {
      listingId: l.id,
      slug: (l.slug as string | null) ?? null,
      status: l.status,
      phase: listingPhase(timing, asOf).phase,
      title: p?.title ?? null,
      imageUrl: p?.image_url ?? null,
      quantity: l.quantity,
      windowClosesAt: l.status === 'DRAFT' ? null : iso(l.window_closes_at),
      roundsEndAt: iso(l.rounds_end_at),
      roundEndsAt: iso(timing.roundEndsAt),
      currentRound: timing.currentRound,
      clearDeadlineAt: iso(l.clear_deadline_at),
      oldestHoldAuthorizedAt: iso(s?.oldest),
      createdAt: iso(l.created_at)!,
      liveBids: s?.live_bids ?? 0,
      heldCents,
      capturedCents,
      sparkline: cumulativeHourly(hourly.get(l.id) ?? [], opened, Math.max(opened, ended)),
    };
  });

  const titles = new Map(cards.map((c) => [c.listingId, c.title]));
  const activity = audit
    .map((row) => projectActivity(row, titles))
    .filter((a): a is OverviewActivity => a !== null);

  return {
    asOf: brand.as_of.toISOString(),
    brand: { id: brand.id, name: brand.name, verificationStatus: brand.verification_status },
    kpis: {
      recoveredThisMonthCents,
      heldNowCents,
      feesThisMonthCents,
      payoutPendingCents,
      liveListings,
    },
    listings: cards,
    activity,
  };
}
