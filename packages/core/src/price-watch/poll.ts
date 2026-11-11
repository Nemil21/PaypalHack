import { bestOffer, parseVariantKey, type Channel3PublicOffer } from '../channel3/product.js';
import type { Channel3PriceChangedEvent, Channel3Product } from '../channel3/types.js';
import { CLOSABLE_LISTING_STATUSES } from '../money/locks.js';
import { recordWebhookEvent } from '../webhooks.js';
import { checkChannel3Call } from './health.js';
import { processPriceWebhookRow, SELECTION_PREDICATE, type PriceWatchDeps } from './process.js';

/**
 * The nightly poll (HF-042b; features/06 §Edge cases "Channel3 outage": backup for missed
 * webhooks). For each product with a live (OPEN/ROUNDS) listing, fetch the free detail endpoint,
 * take the cheapest new, in-stock, allowlisted USD offer per brand allowlist, and feed it through
 * the price watcher's own path as a synthetic `offer.price.changed` (`data.source = 'poll'`).
 *
 * An event is only fed when there is something to catch up on: the best price differs from
 * `products.best_public_price_cents`, or a HELD bid on the product would be released at it. (The
 * offer page's 10-minute anchor refresh rewrites the stored price without releasing anything, so
 * a stored-price diff alone would miss a drop.) The event id is deterministic per product, store,
 * price and UTC day, so a second poll the same day dedupes in `webhook_events` and a change is
 * processed once.
 *
 * Runs hourly in-process (`price-poll` cron) and polls only when the last poll is ≥ 23 h old
 * (`channel3_health.last_poll_at`, claimed atomically), so a redeploy does not re-poll.
 */

export const PRICE_POLL_CHECK_INTERVAL_MS = 60 * 60_000;
export const PRICE_POLL_MIN_GAP_MS = 23 * 60 * 60_000;

const centsToPrice = (cents: number): number => cents / 100;

interface WatchedListing {
  listing_id: string;
  product_id: string;
  channel3_id: string;
  channel3_variant: string | null;
  channel3_subscription_id: string | null;
  best_public_price_cents: number | null;
  authorized_domains: string[];
}

export interface PricePollResult {
  /** False when the last poll was too recent (nothing done). */
  ran: boolean;
  products: number;
  /** Synthetic events recorded and processed. */
  events: number;
  /** Events skipped because the same poll event was already recorded. */
  duplicates: number;
  released: number;
  /** Products whose detail call failed (Channel3 down) or whose processing threw. */
  failed: number;
}

/** Claim the poll slot: true when the last poll is older than `minGapMs` (or never ran). */
async function claimPoll(deps: PriceWatchDeps, minGapMs: number): Promise<boolean> {
  const { rows } = await deps.db.pool.query(
    `UPDATE channel3_health SET last_poll_at = now()
      WHERE id AND (last_poll_at IS NULL OR last_poll_at < now() - make_interval(secs => $1))
      RETURNING last_poll_at`,
    [minGapMs / 1000],
  );
  return rows.length > 0;
}

export function pollEventId(productId: string, offer: Channel3PublicOffer, at: Date): string {
  return `poll_${productId}_${at.toISOString().slice(0, 10)}_${offer.domain}_${offer.priceCents}`;
}

/** The synthetic event for one product's best offer; carries the detail it was computed from. */
export function buildPollEvent(
  row: Pick<
    WatchedListing,
    | 'product_id'
    | 'channel3_id'
    | 'channel3_variant'
    | 'channel3_subscription_id'
    | 'best_public_price_cents'
  >,
  offer: Channel3PublicOffer,
  detail: Channel3Product,
  at: Date,
): Channel3PriceChangedEvent & { detail: Channel3Product; data: { source: 'poll' } } {
  return {
    id: pollEventId(row.product_id, offer, at),
    timestamp: at.toISOString(),
    type: 'offer.price.changed',
    data: {
      source: 'poll',
      subscription_id: row.channel3_subscription_id ?? 'poll',
      subject: {
        product_id: row.channel3_id,
        domain: offer.domain,
        selection: parseVariantKey(row.channel3_variant),
        locale: { language: 'en', country: 'US', currency: 'USD' },
      },
      previous: {
        price: centsToPrice(row.best_public_price_cents ?? offer.priceCents),
        currency: 'USD',
      },
      current: { price: centsToPrice(offer.priceCents), currency: 'USD' },
    },
    detail,
  };
}

/** Would any HELD bid on these listings be released at `priceCents`? */
async function anyQualifying(
  deps: PriceWatchDeps,
  listingIds: string[],
  priceCents: number,
): Promise<boolean> {
  const { rows } = await deps.db.pool.query(
    `SELECT 1 FROM bids b JOIN listings l ON l.id = b.listing_id
      WHERE b.listing_id = ANY($2::uuid[]) AND ${SELECTION_PREDICATE}
      LIMIT 1`,
    [priceCents, listingIds],
  );
  return rows.length > 0;
}

export async function pollPublicPrices(
  deps: PriceWatchDeps,
  opts: { force?: boolean; minGapMs?: number; now?: Date } = {},
): Promise<PricePollResult> {
  const out: PricePollResult = {
    ran: false,
    products: 0,
    events: 0,
    duplicates: 0,
    released: 0,
    failed: 0,
  };
  if (!opts.force && !(await claimPoll(deps, opts.minGapMs ?? PRICE_POLL_MIN_GAP_MS))) return out;
  out.ran = true;
  const now = opts.now ?? new Date();

  const { rows } = await deps.db.pool.query<WatchedListing>(
    `SELECT l.id AS listing_id, p.id AS product_id, p.channel3_id, p.channel3_variant,
            p.channel3_subscription_id, p.best_public_price_cents, b.authorized_domains
       FROM listings l JOIN products p ON p.id = l.product_id JOIN brands b ON b.id = l.brand_id
      WHERE l.status = ANY($1::text[]) AND p.channel3_id IS NOT NULL
      ORDER BY p.id, l.id`,
    [CLOSABLE_LISTING_STATUSES],
  );
  const byProduct = new Map<string, WatchedListing[]>();
  for (const r of rows) byProduct.set(r.product_id, [...(byProduct.get(r.product_id) ?? []), r]);

  for (const listings of byProduct.values()) {
    out.products++;
    const head = listings[0]!;
    let detail: Channel3Product | null = null;
    const answered = await checkChannel3Call(deps.db.pool, async () => {
      detail = await deps.channel3.product(head.channel3_id);
    });
    if (!answered) {
      out.failed++;
      continue;
    }
    if (!detail) continue; // NOT_FOUND: nothing to compare (e.g. the fictional demo product)

    // One candidate per distinct allowlist; the gate re-checks each listing's own allowlist.
    const seen = new Set<string>();
    for (const l of listings) {
      const offer = bestOffer((detail as Channel3Product).offers, {
        domains: l.authorized_domains,
      });
      if (!offer) continue;
      const event = buildPollEvent(head, offer, detail, now);
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const changed = offer.priceCents !== head.best_public_price_cents;
      if (
        !changed &&
        !(await anyQualifying(
          deps,
          listings.map((x) => x.listing_id),
          offer.priceCents,
        ))
      ) {
        continue;
      }
      const recorded = await recordWebhookEvent(deps.db.pool, {
        id: event.id,
        provider: 'CHANNEL3',
        eventType: event.type,
        payload: event,
      });
      if (recorded.status === 'DUPLICATE') {
        out.duplicates++;
        continue;
      }
      try {
        const r = await processPriceWebhookRow(deps, recorded.event);
        out.events++;
        out.released += r.released.length;
      } catch (err) {
        // Left unprocessed; the minute reprocess job retries it.
        out.failed++;
        deps.onError?.(err, { eventId: event.id, step: 'poll' });
      }
    }
  }
  return out;
}
