import { isBiddable, type ListingStatus } from '@holdfast/shared';
import type { Queryable } from '../db.js';
import { audit } from '../audit.js';
import { isUuid } from '../tenancy.js';

/**
 * Share links and the embed widget (HF-055; features/14, screens.md §W10).
 *
 *   - `loadWidgetStatus`: what `widget.js` polls once on load. Public and cross-origin, so it
 *     carries only what the button needs: no amounts, bids or floor.
 *   - `recordOfferClick`: one `OFFER_CLICK` audit event when a shopper arrives on `/o/:slug` from
 *     a tracked link or the widget (`utm_source`). The offer page sends it once per tab.
 *   - `shareStats`: W10 "stats by source": clicks, bids and held $ per `utm_source`, joined from
 *     the click events and `bids.utm_source` (copied into `POST /bids` by the offer page).
 */

/** The audit action for a tracked arrival on the offer page. */
export const OFFER_CLICK = 'OFFER_CLICK';

/** Bids placed with no `utm_source` (the plain `/o/:slug` link, agents) are grouped here. */
export const DIRECT_SOURCE = 'direct';

const SOURCE = /^[a-z0-9_-]{1,32}$/;

/** `?utm_source=` → a stats key ("Email" → "email"), or null when it isn't a plain token. */
export function normalizeSource(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return SOURCE.test(s) ? s : null;
}

export interface WidgetStatus {
  slug: string;
  /** D7 on DB time: the button says "Make an offer" only when this is true. */
  biddable: boolean;
  status: ListingStatus;
  brandName: string;
  productTitle: string | null;
}

/** The widget's view of `slug`; null for an unknown or unpublished listing. */
export async function loadWidgetStatus(q: Queryable, slug: string): Promise<WidgetStatus | null> {
  const res = await q.query(
    `SELECT l.slug, l.status, l.window_closes_at, l.rounds_end_at, l.current_round,
            clock_timestamp() AS db_now, b.name AS brand_name, p.title
       FROM listings l
       JOIN brands b ON b.id = l.brand_id
       JOIN products p ON p.id = l.product_id
      WHERE l.slug = $1 AND l.status <> 'DRAFT'`,
    [slug],
  );
  const row = res.rows[0] as
    | {
        slug: string;
        status: ListingStatus;
        window_closes_at: Date | null;
        rounds_end_at: Date | null;
        current_round: number | null;
        db_now: Date;
        brand_name: string;
        title: string | null;
      }
    | undefined;
  if (!row) return null;
  const biddable =
    !!row.window_closes_at &&
    isBiddable(
      {
        status: row.status,
        windowClosesAt: row.window_closes_at,
        roundsEndAt: row.rounds_end_at,
        currentRound: row.current_round,
      },
      row.db_now,
    );
  return {
    slug: row.slug,
    biddable,
    status: row.status,
    brandName: row.brand_name,
    productTitle: row.title,
  };
}

export interface OfferClickInput {
  slug: string;
  source: string;
  /** `utm_medium`, e.g. `widget` for the embed button; free-form, stored as given (normalized). */
  medium?: string | null;
  shopperId: string;
}

/** Logs one tracked arrival. Returns false for an unknown slug (the route answers 404). */
export async function recordOfferClick(q: Queryable, input: OfferClickInput): Promise<boolean> {
  const res = await q.query(`SELECT id FROM listings WHERE slug = $1 AND status <> 'DRAFT'`, [
    input.slug,
  ]);
  const listingId = (res.rows[0] as { id: string } | undefined)?.id;
  if (!listingId) return false;
  await audit(q, {
    actorType: 'SHOPPER',
    actorId: input.shopperId,
    listingId,
    entity: 'listing',
    entityId: listingId,
    action: OFFER_CLICK,
    data: { source: input.source, medium: normalizeSource(input.medium) },
  });
  return true;
}

export interface SourceStats {
  source: string;
  clicks: number;
  /** Bids placed from this source that reached a hold; a raise is the same bid, not a new one. */
  bids: number;
  /** Sum of the bids from this source that are HELD right now. */
  heldCents: number;
}

export interface ShareStats {
  listingId: string;
  slug: string | null;
  status: ListingStatus;
  biddable: boolean;
  sources: SourceStats[];
  totals: Omit<SourceStats, 'source'>;
}

/**
 * Per-source stats for the session brand's listing; null when it is another brand's or missing
 * (404, no existence leak). Sources are ordered by clicks, then bids; "direct" covers bids that
 * came without a source.
 */
export async function shareStats(
  q: Queryable,
  brandId: string,
  listingId: string,
): Promise<ShareStats | null> {
  if (!isUuid(listingId)) return null;
  const l = await q.query(
    `SELECT id, slug, status, window_closes_at, rounds_end_at, current_round,
            clock_timestamp() AS db_now
       FROM listings WHERE id = $1 AND brand_id = $2`,
    [listingId, brandId],
  );
  const row = l.rows[0] as
    | {
        id: string;
        slug: string | null;
        status: ListingStatus;
        window_closes_at: Date | null;
        rounds_end_at: Date | null;
        current_round: number | null;
        db_now: Date;
      }
    | undefined;
  if (!row) return null;

  const [clicks, bids] = await Promise.all([
    q.query(
      `SELECT data->>'source' AS source, count(*)::int AS n
         FROM audit_events
        WHERE listing_id = $1 AND action = $2 AND entity = 'listing'
        GROUP BY 1`,
      [listingId, OFFER_CLICK],
    ),
    // Root bids only (a raise copies utm_source onto its replacement); a bid "counts" once it was
    // ever held. Held $ follows the live HELD row wherever it sits in the raise chain.
    q.query(
      `SELECT COALESCE(lower(utm_source), $2) AS source,
              count(*) FILTER (WHERE replaces_bid_id IS NULL
                                 AND paypal_authorization_id IS NOT NULL
                                 AND paypal_authorization_id <> '')::int AS bids,
              COALESCE(sum(amount_cents) FILTER (WHERE status = 'HELD'), 0)::bigint AS held
         FROM bids
        WHERE listing_id = $1
        GROUP BY 1`,
      [listingId, DIRECT_SOURCE],
    ),
  ]);

  const by = new Map<string, SourceStats>();
  const at = (source: string) => {
    let s = by.get(source);
    if (!s) by.set(source, (s = { source, clicks: 0, bids: 0, heldCents: 0 }));
    return s;
  };
  for (const r of clicks.rows as Array<{ source: string | null; n: number }>) {
    at(r.source ?? DIRECT_SOURCE).clicks += r.n;
  }
  for (const r of bids.rows as Array<{ source: string; bids: number; held: string }>) {
    const s = at(r.source);
    s.bids += r.bids;
    s.heldCents += Number(r.held);
  }
  const sources = [...by.values()]
    .filter((s) => s.clicks + s.bids + s.heldCents > 0)
    .sort((a, b) => b.clicks - a.clicks || b.bids - a.bids || a.source.localeCompare(b.source));
  const totals = sources.reduce(
    (t, s) => ({
      clicks: t.clicks + s.clicks,
      bids: t.bids + s.bids,
      heldCents: t.heldCents + s.heldCents,
    }),
    { clicks: 0, bids: 0, heldCents: 0 },
  );

  return {
    listingId: row.id,
    slug: row.slug,
    status: row.status,
    biddable:
      !!row.window_closes_at &&
      isBiddable(
        {
          status: row.status,
          windowClosesAt: row.window_closes_at,
          roundsEndAt: row.rounds_end_at,
          currentRound: row.current_round,
        },
        row.db_now,
      ),
    sources,
    totals,
  };
}
