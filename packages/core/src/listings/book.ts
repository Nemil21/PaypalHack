import {
  HOLD_MAX_AGE_HOURS,
  bookOrder,
  buildDemandCurve,
  clearBy,
  listingPhase,
  simulateClear,
  toMs,
  type BookBid,
  type BookPendingBid,
  type BookResponse,
  type ClearBid,
  type ClearInput,
  type ListingStatus,
  type SimulateResponse,
} from '@holdfast/shared';
import { loadClearInput } from '../clearInput.js';
import type { Db, Tx } from '../db.js';
import { NotFoundError, forBrand } from '../tenancy.js';

/**
 * The brand console read model (HF-022): `GET /listings/:id/book` and `/simulate`. Both read the
 * book through the shared `loadClearInput` (D8: HELD with a real PayPal hold) and compute every
 * number with the shared `clear()` / `feeCents()`, so they match what Clear (HF-027) will do.
 * Each call reads one consistent snapshot (REPEATABLE READ, read only) and takes no locks.
 */

const HOLD_MAX_AGE_MS = HOLD_MAX_AGE_HOURS * 3_600_000;
/** Shopper labels start here: "Shopper #1001" is the listing's first bidder. */
const SHOPPER_LABEL_BASE = 1000;

/** `/simulate` quantity outside `1 … listing.quantity` (400 `VALIDATION_ERROR`). */
export class SimulateQuantityError extends Error {
  constructor(readonly maxQuantity: number) {
    super(`quantity must be between 1 and ${maxQuantity}`);
    this.name = 'SimulateQuantityError';
  }
}

interface ListingHead {
  id: string;
  slug: string | null;
  status: ListingStatus;
  quantity: number;
  floor_cents: number;
  liquidation_quote_cents: number | null;
  window_opens_at: Date | null;
  window_closes_at: Date | null;
  rounds_started_at: Date | null;
  rounds_end_at: Date | null;
  round_ends_at: Date | null;
  current_round: number | null;
  target_quantity: number | null;
  clear_deadline_at: Date | null;
  title: string | null;
  image_url: string | null;
  best_public_price_cents: number | null;
  best_public_merchant: string | null;
  best_public_offer_url: string | null;
  price_updated_at: Date | null;
  channel3_subscription_id: string | null;
  fee_bps: number;
  released_by_price_watch: string;
  simulated_no_hold_bids: string;
  db_now: Date;
}

interface DisplayRow {
  id: string;
  status: string;
  amount_cents: number;
  source: string | null;
  placed_at_us: string;
  is_simulated: boolean;
  label: string;
}

interface Snapshot {
  head: ListingHead;
  input: ClearInput;
}

/** Run `fn` in a read-only REPEATABLE READ transaction: every query sees the same book. */
function snapshot<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.tx(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return fn(tx);
  });
}

/** Tenant check (`forBrand`, 404 for another brand) plus the listing, product and fee. */
async function loadSnapshot(tx: Tx, brandId: string, listingId: string): Promise<Snapshot> {
  await forBrand(tx, brandId).getListing(listingId);
  const head = (
    await tx.query<ListingHead>(
      `SELECT l.id, l.slug, l.status, l.quantity, l.floor_cents, l.liquidation_quote_cents,
              l.window_opens_at, l.window_closes_at, l.rounds_started_at, l.rounds_end_at,
              l.round_ends_at, l.current_round, l.target_quantity, l.clear_deadline_at,
              p.title, p.image_url, p.best_public_price_cents, p.best_public_merchant,
              p.best_public_offer_url, p.price_updated_at, p.channel3_subscription_id,
              br.fee_bps,
              (SELECT count(*) FROM bids
                WHERE listing_id = l.id AND void_reason = 'PRICE_DROP') AS released_by_price_watch,
              (SELECT count(*) FROM bids
                WHERE listing_id = l.id AND status = 'HELD' AND paypal_authorization_id IS NULL
                  AND source = 'SIM') AS simulated_no_hold_bids,
              now() AS db_now
         FROM listings l
         JOIN products p ON p.id = l.product_id
         JOIN brands br ON br.id = l.brand_id
        WHERE l.id = $1 AND l.brand_id = $2`,
      [listingId, brandId],
    )
  ).rows[0];
  const input = head ? await loadClearInput(tx, listingId) : null;
  if (!head || !input) throw new NotFoundError('listing');
  return { head, input };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function agedAt(nowMs: number) {
  return (b: ClearBid) =>
    b.authorizedAt !== null && nowMs - toMs(b.authorizedAt) >= HOLD_MAX_AGE_MS;
}

/** `GET /api/listings/:id/book` for the brand in the session. */
export async function loadBook(db: Db, brandId: string, listingId: string): Promise<BookResponse> {
  return snapshot(db, async (tx) => {
    const { head, input } = await loadSnapshot(tx, brandId, listingId);

    // Display columns for the Clear input rows and the pending rows. Labels number shoppers by
    // their first bid on this listing: stable, per listing, and say nothing about who they are.
    const display = (
      await tx.query<DisplayRow>(
        `WITH labels AS (
           SELECT shopper_id, row_number() OVER (ORDER BY min(seq)) AS n
             FROM bids WHERE listing_id = $1 GROUP BY shopper_id
         )
         SELECT b.id, b.status, b.amount_cents, b.source,
                (extract(epoch FROM b.placed_at) * 1000000)::bigint::text AS placed_at_us,
                (s.is_simulated OR b.source = 'SIM') IS TRUE AS is_simulated,
                ($2::int + lb.n)::text AS label
           FROM bids b
           JOIN shoppers s ON s.id = b.shopper_id
           JOIN labels lb ON lb.shopper_id = b.shopper_id
          WHERE b.listing_id = $1 AND b.status IN ('HELD', 'PENDING_APPROVAL', 'VOIDING')`,
        [listingId, SHOPPER_LABEL_BASE],
      )
    ).rows;
    const byId = new Map(display.map((r) => [r.id, r]));

    const { ordered, rank, belowFloor } = bookOrder(input.bids, input.floorCents);
    const bids: BookBid[] = ordered.map((b) => {
      const d = byId.get(b.id)!;
      return {
        id: b.id,
        amountCents: b.amountCents,
        rank: rank[b.id] ?? null,
        placedAtUs: d.placed_at_us,
        source: d.source,
        isSimulated: b.isSimulated,
        shopperLabel: `Shopper #${d.label}`,
        status: 'HELD',
        belowFloor: belowFloor.has(b.id),
      };
    });
    const pending: BookPendingBid[] = display
      .filter((d) => d.status === 'PENDING_APPROVAL' || d.status === 'VOIDING')
      .sort((a, b) => b.amount_cents - a.amount_cents || (a.id < b.id ? -1 : 1))
      .map((d) => ({
        id: d.id,
        amountCents: d.amount_cents,
        placedAtUs: d.placed_at_us,
        source: d.source,
        isSimulated: d.is_simulated,
        shopperLabel: `Shopper #${d.label}`,
        status: d.status as BookPendingBid['status'],
      }));

    let heldCents = 0;
    let simulatedHeldCents = 0;
    for (const b of input.bids) {
      heldCents += b.amountCents;
      if (b.isSimulated) simulatedHeldCents += b.amountCents;
    }

    const timing = {
      status: head.status,
      windowClosesAt: head.window_closes_at ?? head.db_now,
      roundsStartedAt: head.rounds_started_at,
      roundsEndAt: head.rounds_end_at,
      clearDeadlineAt: head.clear_deadline_at,
      currentRound: head.current_round,
      roundEndsAt: head.round_ends_at,
      oldestHoldAuthorizedAt: input.oldestHoldAuthorizedAt,
    };
    const clearByMs = clearBy(timing);

    return {
      listing: {
        id: head.id,
        slug: head.slug,
        status: head.status,
        phase: listingPhase(timing, head.db_now).phase,
        product: { title: head.title, imageUrl: head.image_url },
        quantity: head.quantity,
        floorCents: head.floor_cents,
        liquidationQuoteCents: head.liquidation_quote_cents,
        feeBps: head.fee_bps,
        windowOpensAt: iso(head.window_opens_at),
        windowClosesAt: iso(head.window_closes_at),
        roundsStartedAt: iso(head.rounds_started_at),
        roundsEndAt: iso(head.rounds_end_at),
        roundEndsAt: iso(head.round_ends_at),
        currentRound: head.current_round,
        targetQuantity: head.target_quantity,
        clearDeadlineAt: iso(head.clear_deadline_at),
        oldestHoldAuthorizedAt: input.oldestHoldAuthorizedAt,
        clearByAt: clearByMs === null ? null : new Date(clearByMs).toISOString(),
        priceWatch: {
          on: head.channel3_subscription_id !== null,
          bestPublicPriceCents: head.best_public_price_cents,
          merchant: head.best_public_merchant,
          offerUrl: head.best_public_offer_url,
          priceUpdatedAt: iso(head.price_updated_at),
        },
      },
      stats: {
        liveBids: input.bids.length,
        heldCents,
        simulatedHeldCents,
        bestPublicPriceCents: head.best_public_price_cents,
        releasedByPriceWatch: Number(head.released_by_price_watch),
        simulatedNoHoldBids: Number(head.simulated_no_hold_bids),
      },
      // Per-shopper deduped, same as clear() sees it (superseded bids are not extra demand).
      curve: buildDemandCurve(ordered.filter((b) => rank[b.id] || belowFloor.has(b.id))),
      bids,
      pending,
      bookVersion: input.bookVersion,
      asOf: head.db_now.toISOString(),
    };
  });
}

/**
 * `GET /api/listings/:id/simulate?quantity=`: `clear()` on the Clear input at `quantity`
 * (default: the listing quantity), with fee, net and the liquidation comparison.
 */
export async function simulateListing(
  db: Db,
  brandId: string,
  listingId: string,
  quantity?: number,
): Promise<SimulateResponse> {
  return snapshot(db, async (tx) => {
    const { head, input } = await loadSnapshot(tx, brandId, listingId);
    const q = quantity ?? head.quantity;
    if (!Number.isSafeInteger(q) || q < 1 || q > head.quantity) {
      throw new SimulateQuantityError(head.quantity);
    }
    return simulateClear(input, q, {
      feeBps: head.fee_bps,
      liquidationQuoteCents: head.liquidation_quote_cents,
      isAged: agedAt(head.db_now.getTime()),
    });
  });
}
