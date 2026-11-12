import { DEMAND_MILESTONES_CENTS, netCents } from '@holdfast/shared';
import type { Queryable } from '../db.js';
import { SHIPPED_OR_LATER } from '../shipments/shipments.js';
import type { NotificationDraft } from './notify.js';

/**
 * Audit event → notification drafts (HF-054a; features/13 §Templates). Reads the money tracks'
 * audit rows after they committed, so no money code calls `notify()` itself. Each mapper re-reads
 * the current bid / listing row and only notifies when that state still holds (a reserve bid
 * already VOIDED gets `lost`, not `reserve`; a retried capture failure is not `payment_failed`).
 *
 * Drafts carry amounts, names and our own ids only; the audit row's `paypal_id` and `request_id`
 * are never read.
 */

/** The audit columns a mapper needs. */
export interface AuditEventLike {
  id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  listing_id: string | null;
  data: Record<string, unknown>;
}

/** Actions some mapper handles; everything else is skipped without a query. */
export const NOTIFY_ACTIONS = [
  'BID_HELD',
  'BID_ROLLED',
  'BID_VOIDED',
  'NUDGE_SENT',
  'LISTING_CLEARED',
  'CAPTURE_SUCCEEDED',
  'CAPTURE_FAILED',
  'VOID_SUCCEEDED',
  'LISTING_SETTLED',
  'PAYOUT_FAILED',
] as const;

/** HF-059b's tracking events: any shipment-entity row, or a bid action about shipping. */
export function isShippingEvent(e: Pick<AuditEventLike, 'action' | 'entity'>): boolean {
  return e.entity === 'shipment' || /SHIP/.test(e.action);
}

export function isNotifyEvent(e: Pick<AuditEventLike, 'action' | 'entity'>): boolean {
  return (NOTIFY_ACTIONS as readonly string[]).includes(e.action) || isShippingEvent(e);
}

/** Void reasons that end a bid and let a mandate roll it into a new window (HF-053). */
const ROLL_FROM_REASONS = new Set(['LOST', 'WINDOW_EXPIRED', 'WINDOW_CLOSED', 'EXPIRED']);

interface BidCtx {
  id: string;
  listing_id: string;
  shopper_id: string;
  status: string;
  amount_cents: number;
  void_reason: string | null;
  unit_root_bid_id: string | null;
  replaces_bid_id: string | null;
  is_simulated: boolean;
  window_closes_at: Date | null;
  brand_id: string;
  brand_name: string | null;
  floor_cents: number;
  prev_reason: string | null;
  prev_listing_id: string | null;
}

async function loadBids(q: Queryable, ids: readonly string[]): Promise<BidCtx[]> {
  if (ids.length === 0) return [];
  const res = await q.query(
    `SELECT b.id, b.listing_id, b.shopper_id, b.status, b.amount_cents, b.void_reason,
            b.unit_root_bid_id, b.replaces_bid_id, s.is_simulated,
            l.window_closes_at, l.brand_id, l.floor_cents, br.name AS brand_name,
            prev.void_reason AS prev_reason, prev.listing_id AS prev_listing_id
       FROM bids b
       JOIN shoppers s ON s.id = b.shopper_id
       JOIN listings l ON l.id = b.listing_id
       JOIN brands br ON br.id = l.brand_id
       LEFT JOIN bids prev ON prev.id = b.replaces_bid_id
      WHERE b.id = ANY($1::uuid[])`,
    [ids],
  );
  return res.rows as BidCtx[];
}

async function loadBid(q: Queryable, id: unknown): Promise<BidCtx | null> {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  return (await loadBids(q, [id]))[0] ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The bid an event is about: the entity for `bid` rows, else `data.bidId`. */
function bidIdOf(e: AuditEventLike): unknown {
  return e.entity === 'bid' ? e.entity_id : (e.data.bidId ?? e.data.newBidId);
}

/** Shopper drafts go to real shoppers only (simulated demo bidders have no inbox). */
const shopperOk = (b: BidCtx | null): b is BidCtx => b !== null && !b.is_simulated;

const ref = (b: BidCtx) => ({ bidId: b.id, listingId: b.listing_id });

export async function draftsForAuditEvent(
  q: Queryable,
  e: AuditEventLike,
): Promise<NotificationDraft[]> {
  if (isShippingEvent(e)) return shipped(q, e);
  switch (e.action) {
    case 'BID_HELD':
      return bidHeld(q, e);
    case 'BID_ROLLED': {
      const b = await loadBid(q, bidIdOf(e));
      return shopperOk(b) ? [rolled(b)] : [];
    }
    case 'BID_VOIDED':
      return bidVoided(q, e);
    case 'VOID_SUCCEEDED': {
      const b = await loadBid(q, bidIdOf(e));
      return shopperOk(b) && b.status === 'VOIDED' && b.void_reason === 'LOST' ? [lost(b)] : [];
    }
    case 'NUDGE_SENT':
      return nudge(q, e);
    case 'LISTING_CLEARED':
      return reserve(q, e);
    case 'CAPTURE_SUCCEEDED': {
      const b = await loadBid(q, bidIdOf(e));
      if (!shopperOk(b) || !['CAPTURED', 'SHIPPED'].includes(b.status)) return [];
      // A promoted bid keeps the original winner's unit root (HF-031).
      const promoted = b.unit_root_bid_id !== null && b.unit_root_bid_id !== b.id;
      return [
        {
          template: promoted ? 'promoted' : 'won',
          recipientId: b.shopper_id,
          entityId: b.id,
          payload: { ...ref(b), amountCents: b.amount_cents },
        },
      ];
    }
    case 'CAPTURE_FAILED': {
      // Only the terminal failure (WON → CAPTURE_FAILED, then released); a retried attempt
      // leaves the bid WON.
      const b = await loadBid(q, bidIdOf(e));
      if (!shopperOk(b)) return [];
      if (b.status !== 'CAPTURE_FAILED' && b.void_reason !== 'CAPTURE_FAILED') return [];
      return [
        {
          template: 'payment_failed',
          recipientId: b.shopper_id,
          entityId: b.id,
          payload: { ...ref(b), amountCents: b.amount_cents },
        },
      ];
    }
    case 'LISTING_SETTLED':
      return cleared(q, e);
    case 'PAYOUT_FAILED':
      return payoutFailed(q, e);
    default:
      return [];
  }
}

function rolled(b: BidCtx): NotificationDraft {
  return {
    template: 'bid_rolled',
    recipientId: b.shopper_id,
    entityId: b.id,
    payload: { ...ref(b), amountCents: b.amount_cents, brandName: b.brand_name },
  };
}

function lost(b: BidCtx): NotificationDraft {
  return {
    template: 'lost',
    recipientId: b.shopper_id,
    entityId: b.id,
    payload: { ...ref(b), amountCents: b.amount_cents },
  };
}

async function bidHeld(q: Queryable, e: AuditEventLike): Promise<NotificationDraft[]> {
  const b = await loadBid(q, bidIdOf(e));
  if (!b) return [];
  const out: NotificationDraft[] = [];
  if (shopperOk(b)) {
    // A new bid that replaces one which lost or expired (or sits on another listing) is a
    // mandate's auto-roll (HF-053); a raise replaces a bid on the same live listing.
    const isRoll =
      b.replaces_bid_id !== null &&
      (b.prev_listing_id !== b.listing_id ||
        (b.prev_reason !== null && ROLL_FROM_REASONS.has(b.prev_reason)));
    out.push(
      isRoll
        ? rolled(b)
        : {
            template: 'bid_held',
            recipientId: b.shopper_id,
            entityId: b.id,
            payload: {
              ...ref(b),
              amountCents: b.amount_cents,
              windowClosesAt: b.window_closes_at ? b.window_closes_at.toISOString() : null,
            },
          },
    );
  }
  out.push(...(await demandMilestones(q, b)));
  return out;
}

/** Held demand (D8-eligible holds at or above the floor) crossing $10k / $25k / $50k. */
async function demandMilestones(q: Queryable, b: BidCtx): Promise<NotificationDraft[]> {
  const res = await q.query(
    `SELECT COALESCE(sum(amount_cents), 0)::bigint AS held
       FROM bids
      WHERE listing_id = $1 AND status = 'HELD' AND amount_cents >= $2
        AND paypal_authorization_id IS NOT NULL AND paypal_authorization_id <> ''`,
    [b.listing_id, b.floor_cents],
  );
  const held = Number((res.rows[0] as { held: string }).held);
  return DEMAND_MILESTONES_CENTS.filter((m) => held >= m).map((m) => ({
    template: 'brand_demand_milestone' as const,
    recipientId: b.brand_id,
    entityId: `${b.listing_id}:${m}`,
    payload: {
      listingId: b.listing_id,
      thresholdCents: m,
      heldCents: held,
      floorCents: b.floor_cents,
    },
  }));
}

async function bidVoided(q: Queryable, e: AuditEventLike): Promise<NotificationDraft[]> {
  const b = await loadBid(q, bidIdOf(e));
  if (!shopperOk(b) || b.status !== 'VOIDED') return [];
  if (b.void_reason === 'LOST') return [lost(b)];
  if (b.void_reason !== 'PRICE_DROP') return [];
  // The watcher's void request carries the store's price and link (price-watch/process.ts).
  const req = await q.query(
    `SELECT data FROM audit_events
      WHERE entity = 'bid' AND entity_id = $1 AND action = 'BID_VOID_REQUESTED'
        AND data->>'reason' = 'PRICE_DROP'
      ORDER BY id DESC LIMIT 1`,
    [b.id],
  );
  const data = ((req.rows[0] as { data?: Record<string, unknown> } | undefined)?.data ??
    {}) as Record<string, unknown>;
  return [
    {
      template: 'price_drop_released',
      recipientId: b.shopper_id,
      entityId: b.id,
      payload: {
        ...ref(b),
        amountCents: b.amount_cents,
        publicPriceCents: num(data.newPriceCents),
        merchant: str(data.merchant),
        url: str(data.url),
      },
    },
  ];
}

async function nudge(q: Queryable, e: AuditEventLike): Promise<NotificationDraft[]> {
  const d = e.data;
  const nudgeId = str(d.nudgeId);
  const yourBidCents = num(d.yourBidCents);
  const cutoffCents = num(d.cutoffCents);
  const targetQuantity = num(d.targetQuantity);
  const suggestedCents = num(d.suggestedCents);
  if (!nudgeId || yourBidCents === null || cutoffCents === null) return [];
  if (targetQuantity === null || suggestedCents === null) return [];
  const b = await loadBid(q, bidIdOf(e));
  if (!shopperOk(b)) return [];
  return [
    {
      template: 'round_nudge',
      recipientId: b.shopper_id,
      entityId: nudgeId,
      payload: { ...ref(b), nudgeId, yourBidCents, cutoffCents, targetQuantity, suggestedCents },
    },
  ];
}

/** Reserve-list losers (D10) whose hold is still live: "on the reserve list" until VOIDED. */
async function reserve(q: Queryable, e: AuditEventLike): Promise<NotificationDraft[]> {
  const ranked = Array.isArray(e.data.ranked) ? (e.data.ranked as Record<string, unknown>[]) : [];
  const ids = ranked
    .filter((r) => r.outcome === 'RESERVE' && typeof r.bidId === 'string' && UUID.test(r.bidId))
    .map((r) => r.bidId as string);
  const bids = await loadBids(q, ids);
  return bids
    .filter((b) => shopperOk(b) && b.status === 'LOST')
    .map((b) => ({
      template: 'reserve' as const,
      recipientId: b.shopper_id,
      entityId: b.id,
      payload: { ...ref(b), amountCents: b.amount_cents },
    }));
}

async function cleared(q: Queryable, e: AuditEventLike): Promise<NotificationDraft[]> {
  const listingId = e.listing_id ?? e.entity_id;
  if (!listingId) return [];
  const res = await q.query(
    `SELECT l.brand_id, br.fee_bps, count(b.id)::int AS units,
            min(b.amount_cents)::int AS lowest, COALESCE(sum(b.amount_cents), 0)::bigint AS gross
       FROM listings l
       JOIN brands br ON br.id = l.brand_id
       LEFT JOIN bids b ON b.listing_id = l.id AND b.status IN ('CAPTURED', 'SHIPPED')
      WHERE l.id = $1
      GROUP BY l.brand_id, br.fee_bps`,
    [listingId],
  );
  const r = res.rows[0] as
    | { brand_id: string; fee_bps: number; units: number; lowest: number | null; gross: string }
    | undefined;
  if (!r || r.units === 0 || r.lowest === null) return [];
  const gross = Number(r.gross);
  return [
    {
      template: 'brand_cleared',
      recipientId: r.brand_id,
      entityId: listingId,
      payload: {
        listingId,
        units: r.units,
        lowestCents: r.lowest,
        grossCents: gross,
        payoutNetCents: netCents(gross, r.fee_bps),
      },
    },
  ];
}

async function payoutFailed(q: Queryable, e: AuditEventLike): Promise<NotificationDraft[]> {
  const listingId = e.listing_id;
  if (!listingId) return [];
  const res = await q.query(`SELECT brand_id FROM listings WHERE id = $1`, [listingId]);
  const brandId = (res.rows[0] as { brand_id: string } | undefined)?.brand_id;
  // Once per listing: retries of the same payout do not ring the bell again.
  return brandId
    ? [
        {
          template: 'brand_payout_failed',
          recipientId: brandId,
          entityId: listingId,
          payload: { listingId },
        },
      ]
    : [];
}

async function shipped(q: Queryable, e: AuditEventLike): Promise<NotificationDraft[]> {
  const res = await q.query(
    `SELECT sh.bid_id, sh.carrier, sh.tracking_number
       FROM shipments sh
      WHERE (sh.id::text = $1 OR sh.bid_id::text = $2) AND sh.status = ANY($3::text[])
      LIMIT 1`,
    [e.entity === 'shipment' ? e.entity_id : null, bidIdOf(e) ?? null, [...SHIPPED_OR_LATER]],
  );
  const s = res.rows[0] as
    { bid_id: string; carrier: string | null; tracking_number: string | null } | undefined;
  if (!s) return [];
  const b = await loadBid(q, s.bid_id);
  if (!shopperOk(b)) return [];
  return [
    {
      template: 'shipped',
      recipientId: b.shopper_id,
      entityId: b.id,
      payload: { ...ref(b), carrier: s.carrier, trackingNumber: s.tracking_number },
    },
  ];
}
