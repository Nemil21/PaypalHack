import {
  moneyCopyKey,
  moneyLine,
  promotedMessage,
  releasingHoldMessage,
  type BidStatus,
  type MoneyCopyKey,
} from '@holdfast/shared';
import type { Queryable } from './db.js';

/**
 * Shopper bid views (HF-016; api.md §`GET /bids/mine`, §`GET /bids/:id`, features/15 §Logic 3).
 * Read-only, owner-scoped: every query filters on `shopper_id`, so another shopper's bid is simply
 * not found. Payloads never carry the listing floor (M22): nudge numbers come from HF-036a's
 * `nudges` snapshot, which holds `clear()` output only.
 */

export interface MyBidListing {
  id: string;
  slug: string | null;
  status: string;
  title: string | null;
  imageUrl: string | null;
  windowClosesAt: string | null;
  roundsEndAt: string | null;
  roundEndsAt: string | null;
}

export interface MyBid {
  bidId: string;
  status: BidStatus;
  amountCents: number;
  /** `releasing` while VOIDING, `released` only once VOIDED (D14). */
  moneyKey: MoneyCopyKey;
  /** "$229 held", "Releasing your $229 hold.", "$229 released. Your bank may show it…". */
  moneyText: string;
  voidReason: string | null;
  paymentMethod: string | null;
  source: string | null;
  placedAt: string;
  authorizedAt: string | null;
  releaseIfCheaper: boolean;
  raiseCount: number;
  /** The bid this one replaced (raise / roll / move), and the bid that replaced this one. */
  replacesBidId: string | null;
  replacedByBidId: string | null;
  /** LOST and not yet voided: "On the reserve list" (D14). */
  onReserveList: boolean;
  listing: MyBidListing;
  /**
   * Only for a live bid while its listing is in ROUNDS (D18), from the current round's nudge
   * snapshot (HF-036a); `null` otherwise. `cutoffCents` is null when the shopper was not nudged.
   */
  belowCutoff: boolean | null;
  cutoffCents: number | null;
}

const LIVE: ReadonlySet<string> = new Set(['PENDING_APPROVAL', 'HELD']);

interface BidViewRow {
  id: string;
  status: BidStatus;
  amount_cents: number;
  void_reason: string | null;
  payment_method: string | null;
  source: string | null;
  placed_at: Date;
  authorized_at: Date | null;
  release_if_cheaper: boolean;
  raise_count: number | null;
  replaces_bid_id: string | null;
  replaced_by_bid_id: string | null;
  listing_id: string;
  listing_slug: string | null;
  listing_status: string;
  listing_title: string | null;
  listing_image_url: string | null;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  round_ends_at: Date | null;
  cleared_at: Date | null;
  nudge_bid_id: string | null;
  nudge_cutoff_cents: number | null;
}

/** One query for both views; `ids` narrows it to a bid chain. */
const VIEW_SQL = `
  SELECT b.id, b.status, b.amount_cents, b.void_reason, b.payment_method, b.source, b.placed_at,
         b.authorized_at, b.release_if_cheaper, b.raise_count, b.replaces_bid_id,
         succ.id AS replaced_by_bid_id,
         l.id AS listing_id, l.slug AS listing_slug, l.status AS listing_status,
         p.title AS listing_title, p.image_url AS listing_image_url,
         l.window_closes_at, l.rounds_end_at, l.round_ends_at, l.cleared_at,
         n.bid_id AS nudge_bid_id, n.cutoff_cents AS nudge_cutoff_cents
    FROM bids b
    JOIN listings l ON l.id = b.listing_id
    JOIN products p ON p.id = l.product_id
    LEFT JOIN bids succ ON succ.replaces_bid_id = b.id
    LEFT JOIN nudges n ON l.status = 'ROUNDS' AND n.listing_id = b.listing_id
                      AND n.shopper_id = b.shopper_id AND n.round = l.current_round
   WHERE b.shopper_id = $1 AND ($2::uuid[] IS NULL OR b.id = ANY($2::uuid[]))
   ORDER BY b.placed_at DESC
   LIMIT 500`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function moneyText(status: BidStatus, amountCents: number): string {
  return status === 'VOIDING' ? releasingHoldMessage(amountCents) : moneyLine(status, amountCents);
}

function toMyBid(r: BidViewRow): MyBid {
  let belowCutoff: boolean | null = null;
  let cutoffCents: number | null = null;
  if (r.listing_status === 'ROUNDS' && LIVE.has(r.status)) {
    belowCutoff = false;
    if (r.nudge_cutoff_cents != null) {
      cutoffCents = r.nudge_cutoff_cents;
      // The nudged bid itself is below; a later raise is below unless it beat the cutoff (a tie
      // at the cutoff loses on time priority).
      belowCutoff =
        r.nudge_bid_id === r.id || r.nudge_bid_id == null || r.amount_cents <= r.nudge_cutoff_cents;
    }
  }
  return {
    bidId: r.id,
    status: r.status,
    amountCents: r.amount_cents,
    moneyKey: moneyCopyKey(r.status),
    moneyText: moneyText(r.status, r.amount_cents),
    voidReason: r.void_reason,
    paymentMethod: r.payment_method,
    source: r.source,
    placedAt: r.placed_at.toISOString(),
    authorizedAt: iso(r.authorized_at),
    releaseIfCheaper: r.release_if_cheaper,
    raiseCount: r.raise_count ?? 0,
    replacesBidId: r.replaces_bid_id,
    replacedByBidId: r.replaced_by_bid_id,
    onReserveList: r.status === 'LOST',
    listing: {
      id: r.listing_id,
      slug: r.listing_slug,
      status: r.listing_status,
      title: r.listing_title,
      imageUrl: r.listing_image_url,
      windowClosesAt: iso(r.window_closes_at),
      roundsEndAt: iso(r.rounds_end_at),
      roundEndsAt: iso(r.round_ends_at),
    },
    belowCutoff,
    cutoffCents,
  };
}

/** `GET /bids/mine`: every bid of this shopper, newest first. Clients poll it every 5 s in ROUNDS. */
export async function listMyBids(q: Queryable, shopperId: string): Promise<{ bids: MyBid[] }> {
  const res = await q.query(VIEW_SQL, [shopperId, null]);
  return { bids: (res.rows as BidViewRow[]).map(toMyBid) };
}

// ---------------------------------------------------------------------------------------------
// GET /bids/:id
// ---------------------------------------------------------------------------------------------

export type TimelineStep =
  | 'PLACED'
  | 'CONFIRMING'
  | 'HELD'
  | 'RAISED'
  | 'NUDGED'
  | 'RELEASING'
  | 'RELEASED'
  | 'HOLD_FAILED'
  | 'HOLD_REJECTED'
  | 'ABANDONED'
  | 'WON'
  | 'LOST'
  | 'PROMOTED'
  | (string & {});

export interface TimelineEvent {
  at: string;
  /** Which bid of the chain the event belongs to. */
  bidId: string;
  step: TimelineStep;
  /** The raw audit action (`BID_HELD`, …); null for derived steps (nudges, Clear outcome). */
  action: string | null;
  amountCents: number;
  actorType: string | null;
  paypalId: string | null;
  reason: string | null;
  /** RAISED: the bid and amount this hold replaced. */
  fromBidId?: string;
  fromCents?: number;
  /** NUDGED: the round's cutoff (`clear()` output). */
  cutoffCents?: number | null;
  /** PROMOTED: "A unit opened up. You won at your bid of $219. Charged $219." (D14, D18). */
  message?: string;
}

export interface ChainEntry {
  bidId: string;
  amountCents: number;
  status: BidStatus;
  moneyKey: MoneyCopyKey;
  moneyText: string;
  voidReason: string | null;
}

export interface BidDetail {
  bid: MyBid;
  /** The `replaces_bid_id` chain, oldest first (the money box: one hold per entry). */
  chain: ChainEntry[];
  timeline: TimelineEvent[];
}

const STEP_FOR: Record<string, TimelineStep> = {
  BID_PENDING: 'PLACED',
  BID_NEEDS_RECONCILE: 'CONFIRMING',
  BID_HELD: 'HELD',
  BID_VOID_REQUESTED: 'RELEASING',
  BID_VOIDED: 'RELEASED',
  BID_HOLD_FAILED: 'HOLD_FAILED',
  BID_HOLD_REJECTED: 'HOLD_REJECTED',
  BID_ABANDONED: 'ABANDONED',
  BID_WON: 'WON',
  BID_LOST: 'LOST',
  CAPTURE_SUCCEEDED: 'CHARGED',
};

const WON_STATUSES: ReadonlySet<string> = new Set(['WON', 'CAPTURED', 'SHIPPED', 'CAPTURE_FAILED']);

/** Every bid id on `bidId`'s `replaces_bid_id` chain (both directions), owner-scoped. */
async function chainIds(q: Queryable, shopperId: string, bidId: string): Promise<string[]> {
  const res = await q.query(
    `WITH RECURSIVE
       up(id, replaces_bid_id, depth) AS (
         SELECT id, replaces_bid_id, 0 FROM bids WHERE id = $1 AND shopper_id = $2
         UNION ALL
         SELECT b.id, b.replaces_bid_id, up.depth + 1 FROM bids b
           JOIN up ON b.id = up.replaces_bid_id
          WHERE b.shopper_id = $2 AND up.depth < 100),
       down(id, depth) AS (
         SELECT id, 0 FROM bids WHERE id = $1 AND shopper_id = $2
         UNION ALL
         SELECT b.id, down.depth + 1 FROM bids b
           JOIN down ON b.replaces_bid_id = down.id
          WHERE b.shopper_id = $2 AND down.depth < 100)
     SELECT id FROM up UNION SELECT id FROM down`,
    [bidId, shopperId],
  );
  return (res.rows as { id: string }[]).map((r) => r.id);
}

/** `GET /bids/:id`: the bid, its raise chain and one merged timeline. `null` = not this shopper's. */
export async function getBidDetail(
  q: Queryable,
  shopperId: string,
  bidId: string,
): Promise<BidDetail | null> {
  const ids = await chainIds(q, shopperId, bidId);
  if (ids.length === 0) return null;

  const rows = (await q.query(VIEW_SQL, [shopperId, ids])).rows as BidViewRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const self = byId.get(bidId);
  if (!self) return null;
  const oldestFirst = [...rows].sort((a, b) => a.placed_at.getTime() - b.placed_at.getTime());

  const audits = await q.query(
    `SELECT id, at, actor_type, entity, entity_id, action, paypal_id, data
       FROM audit_events
      WHERE (entity = 'bid' AND entity_id = ANY($1::uuid[]))
         OR (data->>'bidId') = ANY($1::text[])
      ORDER BY at, id`,
    [ids],
  );
  const nudges = await q.query(
    `SELECT bid_id, round, cutoff_cents, your_bid_cents, COALESCE(sent_at, created_at) AS at
       FROM nudges WHERE shopper_id = $1 AND bid_id = ANY($2::uuid[])`,
    [shopperId, ids],
  );

  // [event, tiebreak] so derived steps keep a stable order among equal timestamps.
  const events: Array<[TimelineEvent, number]> = [];
  let order = 0;
  const outcomeSeen = new Set<string>();
  // Promoted bids (HF-031) were on the reserve list at Clear: their Clear outcome is LOST.
  const promoted = new Set<string>();
  for (const a of audits.rows as Array<{
    at: Date;
    actor_type: string;
    entity: string;
    entity_id: string | null;
    action: string;
    paypal_id: string | null;
    data: Record<string, unknown> | null;
  }>) {
    const data = a.data ?? {};
    const owner = a.entity === 'bid' ? a.entity_id : (data.bidId as string | undefined);
    const bid = owner ? byId.get(owner) : undefined;
    if (!bid) continue;
    const step = STEP_FOR[a.action] ?? a.action;
    if (step === 'WON' || step === 'LOST') outcomeSeen.add(bid.id);
    if (a.action === 'PROMOTED') promoted.add(bid.id);
    const base = {
      at: a.at.toISOString(),
      bidId: bid.id,
      amountCents: bid.amount_cents,
      actorType: a.actor_type,
      paypalId: a.paypal_id,
      reason:
        (data.reason as string | undefined) ?? (data.voidReason as string | undefined) ?? null,
    };
    const replaced = a.action === 'BID_HELD' ? (data.replacesBidId as string | null) : null;
    const old = replaced ? byId.get(replaced) : undefined;
    if (old) {
      events.push([
        {
          ...base,
          step: 'RAISED',
          action: null,
          paypalId: null,
          reason: null,
          fromBidId: old.id,
          fromCents: old.amount_cents,
        },
        order++,
      ]);
    }
    const message =
      a.action === 'PROMOTED'
        ? promotedMessage(bid.amount_cents, { captured: moneyCopyKey(bid.status) === 'charged' })
        : undefined;
    events.push([{ ...base, step, action: a.action, ...(message ? { message } : {}) }, order++]);
  }

  for (const n of nudges.rows as Array<{
    bid_id: string;
    cutoff_cents: number | null;
    at: Date;
  }>) {
    const bid = byId.get(n.bid_id);
    if (!bid) continue;
    events.push([
      {
        at: n.at.toISOString(),
        bidId: bid.id,
        step: 'NUDGED',
        action: null,
        amountCents: bid.amount_cents,
        actorType: 'SYSTEM',
        paypalId: null,
        reason: null,
        cutoffCents: n.cutoff_cents,
      },
      order++,
    ]);
  }

  // Clear writes no per-bid audit row for the outcome: derive Won / Lost from the bid's status at
  // the listing's `cleared_at`, unless a later ticket audited it explicitly.
  for (const bid of oldestFirst) {
    if (!bid.cleared_at || outcomeSeen.has(bid.id)) continue;
    const step = promoted.has(bid.id)
      ? 'LOST'
      : WON_STATUSES.has(bid.status)
        ? 'WON'
        : bid.status === 'LOST' || bid.void_reason === 'LOST'
          ? 'LOST'
          : null;
    if (!step) continue;
    events.push([
      {
        at: bid.cleared_at.toISOString(),
        bidId: bid.id,
        step,
        action: null,
        amountCents: bid.amount_cents,
        actorType: 'SYSTEM',
        paypalId: null,
        reason: null,
      },
      order++,
    ]);
  }

  events.sort(([a, ai], [b, bi]) => a.at.localeCompare(b.at) || ai - bi);

  return {
    bid: toMyBid(self),
    chain: oldestFirst.map((r) => ({
      bidId: r.id,
      amountCents: r.amount_cents,
      status: r.status,
      moneyKey: moneyCopyKey(r.status),
      moneyText: moneyText(r.status, r.amount_cents),
      voidReason: r.void_reason,
    })),
    timeline: events.map(([e]) => e),
  };
}
