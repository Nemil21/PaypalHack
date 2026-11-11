import { AFFILIATE_DISCLOSURE } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Queryable } from '../db.js';
import type { Channel3Client } from '../channel3/client.js';
import { isChannel3Error } from '../channel3/errors.js';
import {
  matchOffer,
  observePriceChangedEvent,
  type OfferIgnoredReason,
} from '../channel3/match.js';
import {
  bestOffer,
  sameVariant,
  variantKey,
  type Channel3PublicOffer,
} from '../channel3/product.js';
import type { Channel3PriceChangedEvent, Channel3Product } from '../channel3/types.js';
import type { Actor, MoneyDeps } from '../money/deps.js';
import { emit } from '../money/emit.js';
import { CLOSABLE_LISTING_STATUSES, lockListing } from '../money/locks.js';
import type { BidRow } from '../money/rows.js';
import { emitVoided, voidBid, voidKey } from '../money/void.js';
import {
  markWebhookFailed,
  markWebhookProcessed,
  pendingWebhookEvents,
  type WebhookEventRow,
} from '../webhooks.js';

/**
 * The price watcher's shared processing path (HF-042a; features/06 §Logic 3–8, M13, M14). The
 * labelled demo replay (`replay.ts`) and the live Channel3 webhook (HF-042b) both record a
 * `webhook_events` row and run `processPriceWebhookRow`, so they behave identically.
 *
 * 1. Exact-match gate per live listing on the product (HF-009 stage 2: product id + variant,
 *    `condition == new`, domain in the brand's `authorized_domains`, USD). A failing listing is
 *    audited `PRICE_IGNORED` with the reason.
 * 2. `products.best_public_price_cents` is recomputed from the product-detail response (cheapest
 *    new, in-stock, allowlisted USD offer), never `min(old, new)`, so rises and stock-outs show.
 * 3. Selection: HELD bids on the product's OPEN/ROUNDS listings with `release_if_cheaper` and
 *    `newPrice < amount_cents` and `newPrice < public_price_at_placement` (a bid placed with no
 *    known public price did not knowingly bid above one, so a null placement price qualifies).
 * 4. Per listing, one transaction: the listing `FOR SHARE` (lock order listing → bids, D2), then a
 *    conditional `HELD → VOIDING` joined to `listings.status IN ('OPEN','ROUNDS')` that repeats the
 *    predicate, so a concurrent Clear, toggle-off or cancel wins cleanly. `bid.voided`, the
 *    WATCHER audit (cheaper offer, affiliate link, `AFFILIATE_DISCLOSURE`) and
 *    `pricewatch.released` commit with it. Then `voidBid(…, { resume: true })` outside it
 *    (`void-<bidId>`, D4) → VOIDED with `void_reason = PRICE_DROP`. A void still failing after its
 *    retries stays VOIDING for the HF-034 sweeper, under the same key.
 * 5. The selection re-runs until it returns zero rows, catching raises that landed mid-run.
 *
 * `processed_at` is set only after processing; a throw (Channel3 detail unreachable, database
 * error) leaves the row for the minute / boot reprocess job (`reprocessPriceEvents`).
 */

export const WATCHER_ACTOR: Actor = { type: 'WATCHER', id: 'price-watch' };
/** Shown wherever a replayed event surfaces (audit `data.label`, UI from `data.replayed`). */
export const REPLAYED_EVENT_LABEL = 'replayed event (demo)';
/** Safety stop for the re-run loop; each round only finds bids that landed during the last. */
export const MAX_SELECTION_ROUNDS = 20;
const VOID_CONCURRENCY = 5;

export interface PriceWatchDeps extends MoneyDeps {
  /** The free product-detail endpoint, for condition / availability and the best-price recompute. */
  channel3: Pick<Channel3Client, 'product'>;
  /** Test hook: runs after each selection, before its bids are flipped. */
  afterSelect?: (round: number, bidIds: readonly string[]) => Promise<void>;
  onError?: (err: unknown, ctx: { eventId: string; step: string; bidId?: string }) => void;
}

/** A recorded Channel3 event: the wire event plus what a replay stamps on the payload. */
export interface PriceEvent {
  id: string;
  type: string;
  /** Present for `offer.price.changed`. */
  priceChanged: Channel3PriceChangedEvent | null;
  /** `payload.replayed = true` (data-model §webhook_events). */
  replayed: boolean;
  /**
   * A product-detail snapshot carried by a replay, used instead of calling Channel3 (the demo
   * product is fictional, D15). Ignored on live events.
   */
  detail: Channel3Product | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parse a `webhook_events.payload`; null when it is not a Channel3 event. */
export function parsePriceEvent(payload: unknown): PriceEvent | null {
  const p = obj(payload);
  const id = str(p.id);
  const type = str(p.type);
  if (!id || !type) return null;
  const replayed = p.replayed === true;
  const d = obj(p.data);
  const subject = obj(d.subject);
  const current = obj(d.current);
  const priceChanged =
    type === 'offer.price.changed' &&
    str(subject.product_id) &&
    str(subject.domain) &&
    typeof current.price === 'number'
      ? (p as unknown as Channel3PriceChangedEvent)
      : null;
  const detail = obj(p.detail);
  return {
    id,
    type,
    priceChanged,
    replayed,
    detail: replayed && str(detail.id) ? (detail as unknown as Channel3Product) : null,
  };
}

export interface PriceWatchOffer {
  priceCents: number;
  merchant: string;
  url: string | null;
}

export interface ReleasedBid {
  bidId: string;
  listingId: string;
  shopperId: string;
  amountCents: number;
  /** VOIDED, or VOIDING when PayPal kept failing (the sweeper finishes it). */
  status: string;
}

export type PriceEventOutcome =
  /** At least one listing passed the gate (bids may or may not have been released). */
  | 'MATCHED'
  /** Every live listing's gate refused the offer (audited `PRICE_IGNORED`). */
  | 'IGNORED'
  /** No product of ours with that Channel3 id + variant, or no OPEN/ROUNDS listing on it. */
  | 'UNWATCHED'
  /** Not an `offer.price.changed` event (availability events are HF-042b). */
  | 'UNSUPPORTED';

export interface PriceEventResult {
  eventId: string;
  outcome: PriceEventOutcome;
  replayed: boolean;
  productId: string | null;
  /** The matched offer: the store that now sells it cheaper. */
  cheaper: PriceWatchOffer | null;
  /** `products.best_public_price_cents` after the recompute (null: none qualifies or not run). */
  bestPublicPriceCents: number | null;
  released: ReleasedBid[];
  ignored: Array<{ listingId: string; reason: OfferIgnoredReason }>;
  /** Selection rounds run (the last one found nothing). */
  rounds: number;
}

interface ProductHit {
  id: string;
  channel3_id: string;
  channel3_variant: string | null;
}

interface LiveListing {
  id: string;
  brand_id: string;
  authorized_domains: string[];
}

/**
 * The selection predicate (features/06 §Logic 5, M13), shared by the read and the conditional
 * flip. `$1` = new price in cents.
 */
export const SELECTION_PREDICATE = `
      b.status = 'HELD'
  AND b.release_if_cheaper
  AND $1::int < b.amount_cents
  AND (b.public_price_at_placement IS NULL OR $1::int < b.public_price_at_placement)
  AND l.status = ANY('{OPEN,ROUNDS}'::text[])`;

/** The same rule in code, for unit tests and callers that hold a row already. */
export function qualifiesForRelease(
  bid: Pick<BidRow, 'status' | 'release_if_cheaper' | 'amount_cents'> & {
    public_price_at_placement: number | null;
  },
  listingStatus: string,
  newPriceCents: number,
): boolean {
  return (
    bid.status === 'HELD' &&
    bid.release_if_cheaper === true &&
    newPriceCents < bid.amount_cents &&
    (bid.public_price_at_placement == null || newPriceCents < bid.public_price_at_placement) &&
    (CLOSABLE_LISTING_STATUSES as readonly string[]).includes(listingStatus)
  );
}

/** Process one event. Throws when the detail endpoint or the database fails (row is retried). */
export async function processPriceEvent(
  deps: PriceWatchDeps,
  event: PriceEvent,
): Promise<PriceEventResult> {
  const result: PriceEventResult = {
    eventId: event.id,
    outcome: 'UNSUPPORTED',
    replayed: event.replayed,
    productId: null,
    cheaper: null,
    bestPublicPriceCents: null,
    released: [],
    ignored: [],
    rounds: 0,
  };
  const pc = event.priceChanged;
  if (!pc) return result;
  const pool = deps.db.pool;
  const subject = pc.data.subject;

  const products = (
    await pool.query<ProductHit>(
      `SELECT id, channel3_id, channel3_variant FROM products WHERE channel3_id = $1 ORDER BY id`,
      [subject.product_id],
    )
  ).rows;
  // The variant's own row; otherwise any row on the id, so the gate audits VARIANT_MISMATCH.
  const eventVariant = variantKey(subject.selection);
  const product =
    products.find((p) => sameVariant(p.channel3_variant, eventVariant)) ?? products[0];
  result.outcome = 'UNWATCHED';
  if (!product) return result;
  result.productId = product.id;

  const listings = (
    await pool.query<LiveListing>(
      `SELECT l.id, l.brand_id, b.authorized_domains
         FROM listings l JOIN brands b ON b.id = l.brand_id
        WHERE l.product_id = $1 AND l.status = ANY($2::text[])
        ORDER BY l.id`,
      [product.id, CLOSABLE_LISTING_STATUSES],
    )
  ).rows;
  if (listings.length === 0) return result;

  // Condition and availability come from the detail response (the event carries neither).
  let detail: Channel3Product | null = event.detail;
  if (!detail) {
    try {
      detail = await deps.channel3.product(subject.product_id);
    } catch (err) {
      // An unknown product is an answer (the gate says CONDITION_UNKNOWN); an outage is retried.
      if (!(isChannel3Error(err) && err.kind === 'NOT_FOUND')) throw err;
      detail = null;
    }
  }

  const observation = observePriceChangedEvent(pc, detail);
  const matched: LiveListing[] = [];
  let cheaper: PriceWatchOffer | null = null;
  await deps.db.tx(async (tx) => {
    for (const l of listings) {
      const m = matchOffer(
        {
          channel3Id: product.channel3_id,
          channel3Variant: product.channel3_variant,
          authorizedDomains: l.authorized_domains,
        },
        observation,
      );
      if (m.match) {
        matched.push(l);
        cheaper ??= { priceCents: m.priceCents, merchant: m.domain, url: m.url };
        continue;
      }
      result.ignored.push({ listingId: l.id, reason: m.reason });
      await audit(tx, {
        actorType: WATCHER_ACTOR.type,
        actorId: WATCHER_ACTOR.id,
        brandId: l.brand_id,
        listingId: l.id,
        entity: 'product',
        entityId: product.id,
        action: 'PRICE_IGNORED',
        data: {
          reason: m.reason,
          eventId: event.id,
          channel3ProductId: subject.product_id,
          domain: subject.domain,
          price: pc.data.current?.price ?? null,
          currency: pc.data.current?.currency ?? null,
          replayed: event.replayed,
          ...(event.replayed ? { label: REPLAYED_EVENT_LABEL } : {}),
        },
      });
    }
  });
  if (!cheaper || matched.length === 0) {
    result.outcome = 'IGNORED';
    return result;
  }
  result.outcome = 'MATCHED';
  result.cheaper = cheaper;

  // Recompute from the full detail offer list with the brand allowlist (M13), not min(old, new).
  const best: Channel3PublicOffer | null = bestOffer(detail?.offers, {
    domains: matched[0]!.authorized_domains,
  });
  await pool.query(
    `UPDATE products
        SET best_public_price_cents = $2, best_public_offer_url = $3, best_public_merchant = $4,
            price_updated_at = now()
      WHERE id = $1`,
    [product.id, best?.priceCents ?? null, best?.url ?? null, best?.domain ?? null],
  );
  result.bestPublicPriceCents = best?.priceCents ?? null;

  const offer: PriceWatchOffer = cheaper;
  const listingIds = matched.map((l) => l.id);
  for (let round = 1; round <= MAX_SELECTION_ROUNDS; round++) {
    result.rounds = round;
    const selected = (
      await pool.query<{ id: string; listing_id: string }>(
        `SELECT b.id, b.listing_id FROM bids b JOIN listings l ON l.id = b.listing_id
          WHERE b.listing_id = ANY($2::uuid[]) AND ${SELECTION_PREDICATE}
          ORDER BY b.listing_id, b.id`,
        [offer.priceCents, listingIds],
      )
    ).rows;
    await deps.afterSelect?.(
      round,
      selected.map((r) => r.id),
    );
    if (selected.length === 0) break;

    const byListing = new Map<string, string[]>();
    for (const r of selected)
      byListing.set(r.listing_id, [...(byListing.get(r.listing_id) ?? []), r.id]);

    const flipped: BidRow[] = [];
    for (const [listingId, bidIds] of byListing) {
      flipped.push(...(await flipListing(deps, event, offer, listingId, bidIds)));
    }
    result.released.push(...(await finishVoids(deps, event.id, flipped)));
  }
  return result;
}

/** One listing's flip transaction: listing FOR SHARE, then bids in id order (D2). */
async function flipListing(
  deps: PriceWatchDeps,
  event: PriceEvent,
  offer: PriceWatchOffer,
  listingId: string,
  bidIds: string[],
): Promise<BidRow[]> {
  return deps.db.tx(async (tx) => {
    const listing = await lockListing(tx, listingId, 'share');
    if (!listing || !(CLOSABLE_LISTING_STATUSES as readonly string[]).includes(listing.status)) {
      return [];
    }
    const out: BidRow[] = [];
    for (const id of [...bidIds].sort()) {
      const bid = await flipBid(tx, id, offer.priceCents);
      if (!bid) continue; // cancelled, toggled off, raised or cleared since the selection
      out.push(bid);
      await emitVoided(tx, bid);
      await audit(tx, {
        actorType: WATCHER_ACTOR.type,
        actorId: WATCHER_ACTOR.id,
        listingId: bid.listing_id,
        entity: 'bid',
        entityId: bid.id,
        action: 'BID_VOID_REQUESTED',
        paypalId: bid.paypal_authorization_id,
        requestId: voidKey(bid.id),
        // bid-views.ts (W15, W21, M06, my bids) reads newPriceCents / merchant / url / replayed.
        data: priceDropData(event, offer, { amountCents: bid.amount_cents }),
      });
    }
    if (out.length > 0) {
      await audit(tx, {
        actorType: WATCHER_ACTOR.type,
        actorId: WATCHER_ACTOR.id,
        listingId,
        entity: 'listing',
        entityId: listingId,
        action: 'PRICE_WATCH_RELEASED',
        data: { ...priceDropData(event, offer), count: out.length, bidIds: out.map((b) => b.id) },
      });
      await emit(tx, listingId, {
        type: 'pricewatch.released',
        listingId,
        at: new Date().toISOString(),
        count: out.length,
        priceCents: offer.priceCents,
        merchant: offer.merchant,
      });
    }
    return out;
  });
}

function priceDropData(
  event: PriceEvent,
  offer: PriceWatchOffer,
  extra: { amountCents?: number } = {},
): Json {
  return {
    reason: 'PRICE_DROP',
    trigger: 'PRICE_EVENT',
    eventId: event.id,
    newPriceCents: offer.priceCents,
    merchant: offer.merchant,
    url: offer.url,
    disclosure: AFFILIATE_DISCLOSURE,
    replayed: event.replayed,
    ...(event.replayed ? { label: REPLAYED_EVENT_LABEL } : {}),
    ...(extra.amountCents !== undefined ? { bidAmountCents: extra.amountCents } : {}),
  };
}

/** The conditional HELD → VOIDING, joined to the listing status and repeating the predicate. */
async function flipBid(
  tx: Queryable,
  bidId: string,
  newPriceCents: number,
): Promise<BidRow | null> {
  const res = await tx.query(
    `UPDATE bids b SET status = 'VOIDING', void_reason = 'PRICE_DROP', void_request_id = $3
       FROM listings l
      WHERE b.id = $2 AND l.id = b.listing_id AND ${SELECTION_PREDICATE}
      RETURNING b.*`,
    [newPriceCents, bidId, voidKey(bidId)],
  );
  return (res.rows[0] as BidRow | undefined) ?? null;
}

/** PayPal voids outside any transaction (INV-1), a few at a time. */
async function finishVoids(
  deps: PriceWatchDeps,
  eventId: string,
  bids: BidRow[],
): Promise<ReleasedBid[]> {
  const out: ReleasedBid[] = [];
  const queue = [...bids];
  const worker = async () => {
    for (let bid = queue.shift(); bid; bid = queue.shift()) {
      let status = 'VOIDING';
      try {
        const r = await voidBid(deps, bid.id, 'PRICE_DROP', WATCHER_ACTOR, { resume: true });
        status = r.bid.status;
      } catch (err) {
        // Left VOIDING: the sweeper (HF-034) resumes it with the same void-<bidId> key.
        deps.onError?.(err, { eventId, step: 'void', bidId: bid.id });
      }
      out.push({
        bidId: bid.id,
        listingId: bid.listing_id,
        shopperId: bid.shopper_id,
        amountCents: bid.amount_cents,
        status,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(VOID_CONCURRENCY, bids.length) }, worker));
  return out.sort((a, b) => a.bidId.localeCompare(b.bidId));
}

// ---------------------------------------------------------------------------------------------
// webhook_events rows
// ---------------------------------------------------------------------------------------------

/**
 * Process a recorded `webhook_events` row, then set `processed_at`. On failure the row stays
 * unprocessed with `last_error` and the error is rethrown.
 */
export async function processPriceWebhookRow(
  deps: PriceWatchDeps,
  row: Pick<WebhookEventRow, 'id' | 'payload'>,
): Promise<PriceEventResult> {
  const event = parsePriceEvent(row.payload);
  if (!event) {
    await markWebhookProcessed(deps.db.pool, row.id);
    return {
      eventId: row.id,
      outcome: 'UNSUPPORTED',
      replayed: false,
      productId: null,
      cheaper: null,
      bestPublicPriceCents: null,
      released: [],
      ignored: [],
      rounds: 0,
    };
  }
  let result: PriceEventResult;
  try {
    result = await processPriceEvent(deps, event);
  } catch (err) {
    await markWebhookFailed(deps.db.pool, row.id, err);
    throw err;
  }
  await markWebhookProcessed(deps.db.pool, row.id);
  return result;
}

export interface ReprocessPriceEventsResult {
  processed: number;
  failed: number;
  released: number;
}

/**
 * The minute job (and boot, M14): Channel3 rows still unprocessed after `olderThanMs` (default
 * 1 min, so an in-flight run is not raced needlessly), oldest first.
 */
export async function reprocessPriceEvents(
  deps: PriceWatchDeps,
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<ReprocessPriceEventsResult> {
  const rows = await pendingWebhookEvents(deps.db.pool, {
    provider: 'CHANNEL3',
    olderThanMs: opts.olderThanMs ?? 60_000,
    limit: opts.limit ?? 100,
  });
  const out: ReprocessPriceEventsResult = { processed: 0, failed: 0, released: 0 };
  for (const row of rows) {
    try {
      const r = await processPriceWebhookRow(deps, row);
      out.processed++;
      out.released += r.released.length;
    } catch (err) {
      out.failed++;
      deps.onError?.(err, { eventId: row.id, step: 'reprocess' });
    }
  }
  return out;
}
