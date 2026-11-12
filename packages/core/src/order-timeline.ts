import {
  clearBy,
  type ListingStatus,
  type OrderTimelineFacts,
  type PayoutStatus,
} from '@holdfast/shared';
import type { Queryable } from './db.js';

/**
 * Facts behind the order-status timeline (HF-060 part 2; shared `orderTimeline()`): the listing's
 * own timestamps plus counts and times from settlements, payouts, shipments and the price
 * watcher's audit rows. Two read paths with the same shape:
 *   - `brandOrderTimeline`: tenant-scoped (another brand's listing is simply not found);
 *   - `shopperOrderTimeline`: owner-scoped through the bid, narrowed to the shopper's own
 *     settlement rows and shipment. No amounts, labels or other shoppers' data either way.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HeadRow {
  id: string;
  status: ListingStatus;
  window_opens_at: Date | null;
  window_closes_at: Date | null;
  rounds_started_at: Date | null;
  rounds_end_at: Date | null;
  clear_deadline_at: Date | null;
  cleared_at: Date | null;
  cancelled_at: Date | null;
  watch_on: boolean;
  oldest_hold: Date | null;
  db_now: Date;
}

const HEAD_SQL = `
  SELECT l.id, l.status, l.window_opens_at, l.window_closes_at, l.rounds_started_at,
         l.rounds_end_at, l.clear_deadline_at, l.cleared_at, l.cancelled_at,
         p.channel3_subscription_id IS NOT NULL AS watch_on,
         (SELECT min(b.authorized_at) FROM bids b
           WHERE b.listing_id = l.id AND b.status = 'HELD') AS oldest_hold,
         now() AS db_now
    FROM listings l JOIN products p ON p.id = l.product_id`;

interface SettlementAgg {
  total: number;
  finished: number;
  failed: number;
  charged: number;
  first_started_at: Date | null;
  last_finished_at: Date | null;
}

const SETTLEMENT_AGG = `
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE s.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))::int AS finished,
         count(*) FILTER (WHERE s.status = 'FAILED')::int AS failed,
         count(*) FILTER (WHERE s.action = 'CAPTURE' AND s.status = 'SUCCEEDED')::int AS charged,
         min(s.started_at) AS first_started_at,
         max(s.finished_at) AS last_finished_at
    FROM settlements s JOIN bids b ON b.id = s.bid_id`;

interface ShipAgg {
  shipped: number;
  first_shipped_at: Date | null;
  last_shipped_at: Date | null;
}

const SHIP_COLS = `
  SELECT count(*) FILTER (WHERE sh.status IN ('SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'))::int AS shipped,
         min(sh.shipped_at) AS first_shipped_at,
         max(sh.shipped_at) AS last_shipped_at`;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function base(
  head: HeadRow,
): Omit<OrderTimelineFacts, 'audience' | 'priceWatch' | 'settlement' | 'payout' | 'shipping'> {
  const by = clearBy({
    status: head.status,
    windowClosesAt: head.window_closes_at ?? head.db_now,
    clearDeadlineAt: head.clear_deadline_at,
    oldestHoldAuthorizedAt: head.oldest_hold,
  });
  return {
    listingStatus: head.status,
    windowOpensAt: iso(head.window_opens_at),
    windowClosesAt: iso(head.window_closes_at),
    roundsStartedAt: iso(head.rounds_started_at),
    roundsEndAt: iso(head.rounds_end_at),
    clearByAt: by === null ? null : new Date(by).toISOString(),
    clearedAt: iso(head.cleared_at),
    cancelledAt: iso(head.cancelled_at),
    asOf: head.db_now.toISOString(),
  };
}

function settlementFacts(a: SettlementAgg | undefined): OrderTimelineFacts['settlement'] {
  if (!a || a.total === 0) return null;
  return {
    total: a.total,
    finished: a.finished,
    failed: a.failed,
    charged: a.charged,
    firstStartedAt: iso(a.first_started_at),
    lastFinishedAt: iso(a.last_finished_at),
  };
}

async function latestPayout(
  q: Queryable,
  listingId: string,
): Promise<OrderTimelineFacts['payout']> {
  const p = (
    await q.query(
      `SELECT status, created_at, completed_at FROM payouts
        WHERE listing_id = $1 ORDER BY attempt DESC LIMIT 1`,
      [listingId],
    )
  ).rows[0] as { status: PayoutStatus; created_at: Date; completed_at: Date | null } | undefined;
  return p
    ? { status: p.status, createdAt: p.created_at.toISOString(), completedAt: iso(p.completed_at) }
    : null;
}

/** `GET /api/listings/:id/timeline`. Null: not this brand's listing (or not a listing at all). */
export async function brandOrderTimeline(
  q: Queryable,
  brandId: string,
  listingId: string,
): Promise<OrderTimelineFacts | null> {
  if (!UUID.test(listingId)) return null;
  const head = (
    await q.query(`${HEAD_SQL} WHERE l.id = $1 AND l.brand_id = $2`, [listingId, brandId])
  ).rows[0] as HeadRow | undefined;
  if (!head) return null;

  const [watch, released, settlement, payout, ship] = await Promise.all([
    q.query(
      `SELECT count(*)::int AS events, max(at) AS last_at FROM audit_events
        WHERE listing_id = $1 AND action IN ('PRICE_IGNORED', 'PRICE_WATCH_RELEASED')`,
      [listingId],
    ),
    q.query(
      `SELECT count(*)::int AS n FROM bids WHERE listing_id = $1 AND void_reason = 'PRICE_DROP'`,
      [listingId],
    ),
    q.query(`${SETTLEMENT_AGG} WHERE s.listing_id = $1`, [listingId]),
    latestPayout(q, listingId),
    q.query(`${SHIP_COLS} FROM shipments sh WHERE sh.listing_id = $1`, [listingId]),
  ]);
  const w = watch.rows[0] as { events: number; last_at: Date | null };
  const charged = (settlement.rows[0] as SettlementAgg | undefined)?.charged ?? 0;
  const sh = ship.rows[0] as ShipAgg;

  return {
    audience: 'brand',
    ...base(head),
    priceWatch: {
      on: head.watch_on,
      events: w.events,
      released: (released.rows[0] as { n: number }).n,
      lastEventAt: iso(w.last_at),
    },
    settlement: settlementFacts(settlement.rows[0] as SettlementAgg | undefined),
    payout,
    shipping:
      charged > 0 || sh.shipped > 0
        ? {
            expected: Math.max(charged, sh.shipped),
            shipped: sh.shipped,
            firstShippedAt: iso(sh.first_shipped_at),
            lastShippedAt: iso(sh.last_shipped_at),
          }
        : null,
  };
}

const WON: ReadonlySet<string> = new Set(['WON', 'CAPTURED', 'SHIPPED', 'CAPTURE_FAILED']);

/**
 * `GET /api/bids/:id/order-timeline` (W15). The listing comes from the shopper's own bid; the
 * settlement, outcome and shipping facts cover every bid this shopper placed on that listing (a
 * raise chain is several bids, one live at a time). Null: not this shopper's bid.
 */
export async function shopperOrderTimeline(
  q: Queryable,
  shopperId: string,
  bidId: string,
): Promise<OrderTimelineFacts | null> {
  if (!UUID.test(bidId)) return null;
  const own = (
    await q.query(`SELECT listing_id FROM bids WHERE id = $1 AND shopper_id = $2`, [
      bidId,
      shopperId,
    ])
  ).rows[0] as { listing_id: string } | undefined;
  if (!own) return null;
  const listingId = own.listing_id;
  const head = (await q.query(`${HEAD_SQL} WHERE l.id = $1`, [listingId])).rows[0] as HeadRow;

  const scope = `b.listing_id = $1 AND b.shopper_id = $2`;
  const [bids, settlement, payout, ship] = await Promise.all([
    q.query(
      `SELECT id, status, void_reason, release_if_cheaper, placed_at FROM bids b WHERE ${scope}
        ORDER BY placed_at DESC, id`,
      [listingId, shopperId],
    ),
    q.query(`${SETTLEMENT_AGG} WHERE ${scope}`, [listingId, shopperId]),
    latestPayout(q, listingId),
    q.query(`${SHIP_COLS} FROM shipments sh JOIN bids b ON b.id = sh.bid_id WHERE ${scope}`, [
      listingId,
      shopperId,
    ]),
  ]);
  const mine = bids.rows as {
    id: string;
    status: string;
    void_reason: string | null;
    release_if_cheaper: boolean;
  }[];
  const won = mine.some((b) => WON.has(b.status));
  const declined = won && mine.every((b) => !WON.has(b.status) || b.status === 'CAPTURE_FAILED');
  const dropped = mine.filter((b) => b.void_reason === 'PRICE_DROP').length;
  const cleared = head.cleared_at !== null;
  const outcome: OrderTimelineFacts['outcome'] = declined
    ? 'declined'
    : won
      ? 'won'
      : dropped > 0
        ? 'released'
        : cleared
          ? 'lost'
          : null;
  const latest = mine.find((b) => b.id === bidId) ?? mine[0];
  const sh = ship.rows[0] as ShipAgg;

  return {
    audience: 'shopper',
    ...base(head),
    priceWatch: {
      on: latest?.release_if_cheaper ?? false,
      // The shopper sees only what happened to their own hold.
      events: 0,
      released: dropped > 0 ? 1 : 0,
      lastEventAt: null,
    },
    settlement: settlementFacts(settlement.rows[0] as SettlementAgg | undefined),
    payout: outcome === 'won' ? payout : null,
    shipping:
      outcome === 'won' || sh.shipped > 0
        ? {
            expected: 1,
            shipped: Math.min(sh.shipped, 1),
            firstShippedAt: iso(sh.first_shipped_at),
            lastShippedAt: iso(sh.last_shipped_at),
          }
        : null,
    outcome,
  };
}
