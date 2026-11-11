import {
  isRaisable,
  moneyCopyKey,
  moneyLine,
  nudgeText,
  promotedMessage,
  releasingHoldMessage,
  suggestedRaiseCents,
  type BidStatus,
  type ListingStatus,
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
  /** For the W13 "Let my agent manage this" mandate prefill (HF-017b `?productId=`). */
  productId: string;
  slug: string | null;
  status: string;
  title: string | null;
  imageUrl: string | null;
  windowClosesAt: string | null;
  roundsEndAt: string | null;
  roundEndsAt: string | null;
  /**
   * D7 `isRaisable` at the database clock: OPEN before `window_closes_at`, or ROUNDS before
   * `rounds_end_at`. ROUNDS and false = frozen book ("Rounds ended. Waiting for the brand to clear.").
   */
  raisable: boolean;
}

/**
 * The current round's nudge for a live bid that is still below the cutoff (HF-038a, W14/W15):
 * "You're out at $219. The cutoff is $240. Raise to $241?". Numbers are `clear()` output and the
 * shopper's own bid only, never the floor. When the shopper raised since the nudge but is still
 * below, `suggestedCents` and `text` are recomputed for the current bid with the same formula.
 */
export interface MyBidNudge {
  id: string;
  round: number;
  cutoffCents: number;
  /** `max(cutoff + minRaise(cutoff), current + minRaise(current))` (19 §Logic 4). */
  suggestedCents: number;
  text: string;
  sentAt: string;
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
  /** Why a hold failed or a bid was abandoned (`HOLD_FAILED`, `WINDOW_CLOSED`, …); W21 reads it. */
  errorCode: string | null;
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
  /** Set only while `belowCutoff` is true (ROUNDS, live bid, nudged this round); else null. */
  nudge: MyBidNudge | null;
}

const LIVE: ReadonlySet<string> = new Set(['PENDING_APPROVAL', 'HELD']);

interface BidViewRow {
  id: string;
  status: BidStatus;
  amount_cents: number;
  void_reason: string | null;
  error_code: string | null;
  payment_method: string | null;
  source: string | null;
  placed_at: Date;
  voided_at: Date | null;
  authorized_at: Date | null;
  release_if_cheaper: boolean;
  raise_count: number | null;
  replaces_bid_id: string | null;
  replaced_by_bid_id: string | null;
  listing_id: string;
  product_id: string;
  listing_slug: string | null;
  listing_status: string;
  listing_title: string | null;
  listing_image_url: string | null;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  round_ends_at: Date | null;
  cleared_at: Date | null;
  nudge_id: string | null;
  nudge_round: number | null;
  nudge_bid_id: string | null;
  nudge_cutoff_cents: number | null;
  nudge_target_cents: number | null;
  nudge_text: string | null;
  nudge_sent_at: Date | null;
  nudge_round_ends_at: Date | null;
  db_now: Date;
  best_public_price_cents: number | null;
  best_public_merchant: string | null;
  best_public_offer_url: string | null;
  price_updated_at: Date | null;
}

/** One query for both views; `ids` narrows it to a bid chain. */
const VIEW_SQL = `
  SELECT b.id, b.status, b.amount_cents, b.void_reason, b.error_code, b.payment_method, b.source,
         b.placed_at, b.voided_at, b.authorized_at, b.release_if_cheaper, b.raise_count, b.replaces_bid_id,
         succ.id AS replaced_by_bid_id,
         l.id AS listing_id, l.product_id, l.slug AS listing_slug, l.status AS listing_status,
         p.title AS listing_title, p.image_url AS listing_image_url,
         l.window_closes_at, l.rounds_end_at, l.round_ends_at, l.cleared_at,
         n.id AS nudge_id, n.round AS nudge_round, n.bid_id AS nudge_bid_id,
         n.cutoff_cents AS nudge_cutoff_cents, n.target_cents AS nudge_target_cents,
         n.text AS nudge_text, COALESCE(n.sent_at, n.created_at) AS nudge_sent_at,
         n.round_ends_at AS nudge_round_ends_at, clock_timestamp() AS db_now,
         p.best_public_price_cents, p.best_public_merchant, p.best_public_offer_url,
         p.price_updated_at
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
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);

export function moneyText(status: BidStatus, amountCents: number): string {
  return status === 'VOIDING' ? releasingHoldMessage(amountCents) : moneyLine(status, amountCents);
}

function nudgeOf(r: BidViewRow, cutoffCents: number): MyBidNudge | null {
  if (!r.nudge_id || r.nudge_round == null) return null;
  // The nudged bid itself keeps its snapshot (and HF-036b's phrasing); a later, still-low raise
  // gets the same template recomputed for its own amount.
  const own = r.nudge_bid_id === r.id && r.nudge_target_cents != null && !!r.nudge_text;
  const suggestedCents = own
    ? r.nudge_target_cents!
    : suggestedRaiseCents(cutoffCents, r.amount_cents);
  return {
    id: r.nudge_id,
    round: r.nudge_round,
    cutoffCents,
    suggestedCents,
    text: own
      ? r.nudge_text!
      : nudgeText({ yourBidCents: r.amount_cents, cutoffCents, suggestedCents }),
    sentAt: iso(r.nudge_sent_at) ?? r.db_now.toISOString(),
    roundEndsAt: iso(r.nudge_round_ends_at),
  };
}

function toMyBid(r: BidViewRow): MyBid {
  let belowCutoff: boolean | null = null;
  let cutoffCents: number | null = null;
  let nudge: MyBidNudge | null = null;
  if (r.listing_status === 'ROUNDS' && LIVE.has(r.status)) {
    belowCutoff = false;
    if (r.nudge_cutoff_cents != null) {
      cutoffCents = r.nudge_cutoff_cents;
      // The nudged bid itself is below; a later raise is below unless it beat the cutoff (a tie
      // at the cutoff loses on time priority).
      belowCutoff =
        r.nudge_bid_id === r.id || r.nudge_bid_id == null || r.amount_cents <= r.nudge_cutoff_cents;
      if (belowCutoff) nudge = nudgeOf(r, r.nudge_cutoff_cents);
    }
  }
  return {
    bidId: r.id,
    status: r.status,
    amountCents: r.amount_cents,
    moneyKey: moneyCopyKey(r.status),
    moneyText: moneyText(r.status, r.amount_cents),
    voidReason: r.void_reason,
    errorCode: r.error_code,
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
      productId: r.product_id,
      slug: r.listing_slug,
      status: r.listing_status,
      title: r.listing_title,
      imageUrl: r.listing_image_url,
      windowClosesAt: iso(r.window_closes_at),
      roundsEndAt: iso(r.rounds_end_at),
      roundEndsAt: iso(r.round_ends_at),
      raisable: isRaisable(
        {
          status: r.listing_status as ListingStatus,
          // No window yet (DRAFT) = never biddable.
          windowClosesAt: r.window_closes_at ?? 0,
          roundsEndAt: r.rounds_end_at,
        },
        r.db_now,
      ),
    },
    belowCutoff,
    cutoffCents,
    nudge,
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

/**
 * The price watch on the selected bid (HF-020; W15 "Price watch on since <time>" row, features/06).
 * `on` mirrors `release_if_cheaper`; the public price is `products.best_public_*`.
 */
export interface PriceWatch {
  on: boolean;
  /** When the watch started covering this chain: the first hold of the chain. */
  since: string | null;
  bestPublicPriceCents: number | null;
  merchant: string | null;
  url: string | null;
  checkedAt: string | null;
}

/**
 * A price-drop release (M06 sheet, W21 "Price dropped"): the bid voided with `PRICE_DROP`, the
 * cheaper store from the void's audit row (HF-020 toggle, HF-042 watcher), else the product's
 * current best public offer.
 */
export interface PriceDrop {
  bidId: string;
  at: string;
  oldCents: number;
  newCents: number | null;
  merchant: string | null;
  url: string | null;
  /** VOIDED: "released"; still VOIDING: "releasing" (D14). */
  released: boolean;
  /** HF-042a replay path stamps `replayed=true`; the UI labels it "replayed event (demo)". */
  replayed: boolean;
}

export interface BidDetail {
  bid: MyBid;
  /** The `replaces_bid_id` chain, oldest first (the money box: one hold per entry). */
  chain: ChainEntry[];
  timeline: TimelineEvent[];
  priceWatch: PriceWatch;
  priceDrop: PriceDrop | null;
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
  const priceDropAudit = new Map<string, { at: string; data: Record<string, unknown> }>();
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
    if (a.action === 'BID_VOID_REQUESTED' && data.reason === 'PRICE_DROP') {
      priceDropAudit.set(bid.id, { at: a.at.toISOString(), data });
    }
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

  const firstHeld = oldestFirst.find((r) => r.authorized_at)?.authorized_at ?? null;
  const priceWatch: PriceWatch = {
    on: self.release_if_cheaper,
    since: iso(firstHeld),
    bestPublicPriceCents: self.best_public_price_cents,
    merchant: self.best_public_merchant,
    url: self.best_public_offer_url,
    checkedAt: iso(self.price_updated_at),
  };

  let priceDrop: PriceDrop | null = null;
  const dropped = [...oldestFirst].reverse().find((r) => r.void_reason === 'PRICE_DROP');
  if (dropped) {
    const req = priceDropAudit.get(dropped.id);
    priceDrop = {
      bidId: dropped.id,
      at: req?.at ?? iso(dropped.voided_at) ?? dropped.placed_at.toISOString(),
      oldCents: dropped.amount_cents,
      newCents: num(req?.data.newPriceCents) ?? dropped.best_public_price_cents,
      merchant: str(req?.data.merchant) ?? dropped.best_public_merchant,
      url: str(req?.data.url) ?? dropped.best_public_offer_url,
      released: dropped.status === 'VOIDED',
      replayed: req?.data.replayed === true,
    };
  }

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
    priceWatch,
    priceDrop,
  };
}
