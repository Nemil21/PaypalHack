import type { ListingPhaseName } from './listing.js';
import type { ListingStatus } from './status.js';

/**
 * `GET /api/brands/me/overview` (HF-026; screens.md §W04, features/08 §Overview W04). Everything
 * here is the session brand's own data (`forBrand`); the activity feed is a fixed projection of
 * audit events that never carries actor ids, PayPal ids, request ids or free-form `data`.
 */

export interface BrandOverviewKpis {
  /** COMPLETED real captures (not simulated shoppers, not `SIM` bids) finished this UTC month. */
  recoveredThisMonthCents: number;
  /** D8-eligible holds (HELD with an authorization) on OPEN / ROUNDS listings, right now. */
  heldNowCents: number;
  /** Holdfast fee on this month's recovered money (shared `feeCents`, per listing, brand fee). */
  feesThisMonthCents: number;
  /**
   * Net still owed to the brand: the latest payout attempt's net when it is not SUCCESS, or the
   * net of real completed captures for a CLEARING / SETTLED listing with no payout yet.
   */
  payoutPendingCents: number;
  /** Listings in OPEN or ROUNDS. */
  liveListings: number;
}

/** Cumulative held dollars by hour of `bids.placed_at`, oldest first (one point per hour). */
export interface OverviewSparkline {
  /** ISO start of the first hourly bucket; null when the listing has no bids to plot. */
  startAt: string | null;
  /** Cumulative cents at the end of each hour. */
  points: number[];
}

/** One W04 listing card. Timing fields feed the client's live `listingPhase()` / countdown. */
export interface OverviewListingCard {
  listingId: string;
  slug: string | null;
  status: ListingStatus;
  /** `listingPhase()` at `asOf`; the client recomputes it every second. */
  phase: ListingPhaseName;
  title: string | null;
  imageUrl: string | null;
  quantity: number;
  windowClosesAt: string | null;
  roundsEndAt: string | null;
  roundEndsAt: string | null;
  currentRound: number | null;
  clearDeadlineAt: string | null;
  oldestHoldAuthorizedAt: string | null;
  createdAt: string;
  /** D8-eligible bids now (0 once cleared). */
  liveBids: number;
  heldCents: number;
  /** COMPLETED real captures on this listing (after Clear). */
  capturedCents: number;
  sparkline: OverviewSparkline;
}

export const OVERVIEW_ACTIVITY_KINDS = ['BID', 'AGENT', 'LISTING', 'SETTLEMENT', 'PAYOUT'] as const;
export type OverviewActivityKind = (typeof OVERVIEW_ACTIVITY_KINDS)[number];

/** One activity feed row. The projection below is the only way rows are built. */
export interface OverviewActivity {
  id: string;
  at: string;
  kind: OverviewActivityKind;
  /** One of `OVERVIEW_ACTIVITY_ACTIONS`. */
  action: string;
  listingId: string | null;
  listingTitle: string | null;
  /** The one money figure the row is about, when it has one. */
  amountCents: number | null;
}

export interface BrandOverview {
  asOf: string;
  brand: { id: string; name: string; verificationStatus: string };
  kpis: BrandOverviewKpis;
  /** Every listing of the brand, newest first. */
  listings: OverviewListingCard[];
  /** Newest first, at most `OVERVIEW_ACTIVITY_LIMIT` rows. */
  activity: OverviewActivity[];
}

export const OVERVIEW_ACTIVITY_LIMIT = 30;

/**
 * Audit actions the feed shows, with their kind and the `data` key holding their money figure.
 * Anything else (void requests, cron runs, reconcile noise) never reaches the brand's feed.
 */
const ACTIVITY: Record<string, { kind: OverviewActivityKind; amountKey: string | null }> = {
  BID_HELD: { kind: 'BID', amountKey: 'amountCents' },
  BID_RAISED: { kind: 'BID', amountKey: 'newCents' },
  BID_VOIDED: { kind: 'BID', amountKey: null },
  LISTING_CREATED: { kind: 'LISTING', amountKey: null },
  LISTING_PUBLISHED: { kind: 'LISTING', amountKey: null },
  LISTING_QUANTITY_RAISED: { kind: 'LISTING', amountKey: null },
  LISTING_CANCELLED: { kind: 'LISTING', amountKey: null },
  LISTING_EXPIRED: { kind: 'LISTING', amountKey: null },
  ROUND_EXTENDED: { kind: 'LISTING', amountKey: null },
  LISTING_CLEARED: { kind: 'SETTLEMENT', amountKey: 'grossCents' },
  CAPTURE_SUCCEEDED: { kind: 'SETTLEMENT', amountKey: 'amountCents' },
  PROMOTED: { kind: 'SETTLEMENT', amountKey: 'amountCents' },
  LISTING_SETTLED: { kind: 'SETTLEMENT', amountKey: null },
  PAYOUT_CREATED: { kind: 'PAYOUT', amountKey: 'netCents' },
  PAYOUT_SUCCEEDED: { kind: 'PAYOUT', amountKey: 'netCents' },
  PAYOUT_FAILED: { kind: 'PAYOUT', amountKey: null },
};

export const OVERVIEW_ACTIVITY_ACTIONS: readonly string[] = Object.keys(ACTIVITY);

/** Actors whose bid events read as agent activity ("Agent placed a held bid"). */
const AGENT_ACTORS = new Set(['BUYER_AGENT', 'BRAND_AGENT', 'MCP_CLIENT']);

/** The audit columns the projection may read. Ids, PayPal ids and request ids are not here. */
export interface ActivitySourceRow {
  id: string | number;
  at: Date | string;
  actor_type: string;
  listing_id: string | null;
  action: string;
  data: Record<string, unknown> | null;
}

/**
 * Audit row → feed row, or null when the action is not shown. Only `action`, `at`, the listing
 * and one whitelisted integer from `data` survive: shopper emails, PayPal payer ids, actor ids
 * and request ids can never leak, whatever a writer put in `data`.
 */
export function projectActivity(
  row: ActivitySourceRow,
  titles: ReadonlyMap<string, string | null>,
): OverviewActivity | null {
  const spec = ACTIVITY[row.action];
  if (!spec) return null;
  const raw = spec.amountKey ? row.data?.[spec.amountKey] : null;
  const amountCents = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  const kind = spec.kind === 'BID' && AGENT_ACTORS.has(row.actor_type) ? 'AGENT' : spec.kind;
  const at = row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString();
  return {
    id: String(row.id),
    at,
    kind,
    action: row.action,
    listingId: row.listing_id,
    listingTitle: row.listing_id ? (titles.get(row.listing_id) ?? null) : null,
    amountCents,
  };
}

/**
 * Hourly cumulative sparkline from per-hour sums. `buckets` maps an hour's epoch ms to the cents
 * placed in it; the series runs from `startMs` to `endMs` (both floored to the hour), keeping the
 * last `maxPoints` hours.
 */
export function cumulativeHourly(
  buckets: ReadonlyArray<{ hourMs: number; cents: number }>,
  startMs: number,
  endMs: number,
  maxPoints = 60,
): OverviewSparkline {
  if (!buckets.length) return { startAt: null, points: [] };
  const HOUR = 3_600_000;
  const floor = (ms: number) => Math.floor(ms / HOUR) * HOUR;
  const first = Math.min(floor(startMs), ...buckets.map((b) => floor(b.hourMs)));
  const last = Math.max(floor(endMs), ...buckets.map((b) => floor(b.hourMs)));
  const n = Math.round((last - first) / HOUR) + 1;
  const perHour = new Array<number>(n).fill(0);
  for (const b of buckets) perHour[Math.round((floor(b.hourMs) - first) / HOUR)]! += b.cents;
  let sum = 0;
  const points = perHour.map((c) => (sum += c));
  const drop = Math.max(0, points.length - maxPoints);
  return {
    startAt: new Date(first + drop * HOUR).toISOString(),
    points: points.slice(drop),
  };
}
