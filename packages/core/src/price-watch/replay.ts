import { randomUUID } from 'node:crypto';
import { audit } from '../audit.js';
import { isChannel3Error } from '../channel3/errors.js';
import { normalizeDomain, parseVariantKey } from '../channel3/product.js';
import type {
  Channel3Offer,
  Channel3PriceChangedEvent,
  Channel3Product,
} from '../channel3/types.js';
import { recordWebhookEvent } from '../webhooks.js';
import {
  processPriceWebhookRow,
  REPLAYED_EVENT_LABEL,
  type PriceEventResult,
  type PriceWatchDeps,
} from './process.js';

/**
 * The labelled price-drop replay (HF-042a; features/06 §Logic 8, features/17 `demo:price-drop`).
 * Builds an `offer.price.changed` event for a listing's product, stamps `replayed = true`, records
 * it in `webhook_events` and runs the same path as the live webhook (`processPriceWebhookRow`).
 *
 * The demo product is fictional (D15), so the event carries a product-detail snapshot: Channel3's
 * detail when it knows the product, else the product's current public offer; either way with the
 * replayed store's offer set to the new price (new, in stock). The UI and audit show
 * "replayed event (demo)" from `replayed`.
 */

export interface ReplayPriceDropInput {
  listingId: string;
  /** The new public price at the store. */
  priceCents: number;
  /** Store domain; default the product's current public-offer store if allowlisted, else the first allowlisted domain. */
  domain?: string | null;
  /** Buy link; default the store's existing link, else `https://<domain>/`. */
  url?: string | null;
  /** Event id; default `replay_<uuid>`. A repeated id is deduped like a redelivery. */
  eventId?: string | null;
  actor?: { type: string; id?: string | null };
}

export type ReplayError =
  | { code: 'NOT_FOUND' }
  | { code: 'NO_ALLOWLIST' }
  | { code: 'DOMAIN_NOT_ALLOWED'; domain: string }
  | { code: 'INVALID_PRICE' };

export type ReplayResult =
  | { ok: true; duplicate: false; result: PriceEventResult }
  | { ok: true; duplicate: true; eventId: string }
  | { ok: false; error: ReplayError };

/** Channel3 prices are decimals (types.ts). */
const centsToPrice = (cents: number): number => cents / 100;

interface ListingProduct {
  listing_id: string;
  brand_id: string;
  authorized_domains: string[];
  product_id: string;
  channel3_id: string | null;
  channel3_variant: string | null;
  channel3_subscription_id: string | null;
  title: string | null;
  best_public_price_cents: number | null;
  best_public_offer_url: string | null;
  best_public_merchant: string | null;
}

/** Build and replay a price drop for one listing's product. */
export async function replayPriceDrop(
  deps: PriceWatchDeps,
  input: ReplayPriceDropInput,
): Promise<ReplayResult> {
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents <= 0) {
    return { ok: false, error: { code: 'INVALID_PRICE' } };
  }
  const built = await buildReplayEvent(deps, input);
  if (!built.ok) return built;
  return replayPriceEvent(deps, built.payload, input.actor);
}

/**
 * Record any Channel3 event body as a replay (`replayed = true`) and process it. Used by the admin
 * endpoint for raw fixture bodies, and by `replayPriceDrop`.
 */
export async function replayPriceEvent(
  deps: PriceWatchDeps,
  body: Record<string, unknown>,
  actor: { type: string; id?: string | null } = { type: 'ADMIN' },
): Promise<ReplayResult> {
  const id = typeof body.id === 'string' && body.id ? body.id : `replay_${randomUUID()}`;
  const payload = { ...body, id, replayed: true, label: REPLAYED_EVENT_LABEL };
  const recorded = await recordWebhookEvent(deps.db.pool, {
    id,
    provider: 'CHANNEL3',
    eventType: typeof body.type === 'string' ? body.type : null,
    payload,
  });
  if (recorded.status === 'DUPLICATE') return { ok: true, duplicate: true, eventId: id };
  await audit(deps.db.pool, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    entity: 'webhook_event',
    action: 'PRICE_EVENT_REPLAYED',
    data: { eventId: id, type: body.type ?? null, label: REPLAYED_EVENT_LABEL },
  });
  const result = await processPriceWebhookRow(deps, recorded.event);
  return { ok: true, duplicate: false, result };
}

type Built =
  | { ok: true; payload: Record<string, unknown> & Channel3PriceChangedEvent }
  | { ok: false; error: ReplayError };

export async function buildReplayEvent(
  deps: PriceWatchDeps,
  input: ReplayPriceDropInput,
): Promise<Built> {
  const row = (
    await deps.db.pool.query<ListingProduct>(
      `SELECT l.id AS listing_id, l.brand_id, b.authorized_domains, p.id AS product_id,
              p.channel3_id, p.channel3_variant, p.channel3_subscription_id, p.title,
              p.best_public_price_cents, p.best_public_offer_url, p.best_public_merchant
         FROM listings l JOIN brands b ON b.id = l.brand_id JOIN products p ON p.id = l.product_id
        WHERE l.id = $1`,
      [input.listingId],
    )
  ).rows[0];
  if (!row) return { ok: false, error: { code: 'NOT_FOUND' } };
  const allow = row.authorized_domains.map(normalizeDomain);
  if (allow.length === 0) return { ok: false, error: { code: 'NO_ALLOWLIST' } };

  const current = row.best_public_merchant ? normalizeDomain(row.best_public_merchant) : null;
  const domain = input.domain
    ? normalizeDomain(input.domain)
    : current && allow.includes(current)
      ? current
      : allow[0]!;
  if (!allow.includes(domain)) return { ok: false, error: { code: 'DOMAIN_NOT_ALLOWED', domain } };

  // A product with no Channel3 id (seeded by hand) gets a labelled demo id once, so the gate
  // compares like for like.
  let channel3Id = row.channel3_id;
  if (!channel3Id) {
    channel3Id = (
      await deps.db.pool.query<{ channel3_id: string }>(
        `UPDATE products SET channel3_id = coalesce(channel3_id, $2) WHERE id = $1
         RETURNING channel3_id`,
        [row.product_id, `demo-${row.product_id.slice(0, 8)}`],
      )
    ).rows[0]!.channel3_id;
  }

  let detail: Channel3Product | null = null;
  try {
    detail = await deps.channel3.product(channel3Id);
  } catch (err) {
    if (!isChannel3Error(err)) throw err;
  }
  const offers: Channel3Offer[] = [...(detail?.offers ?? [])];
  // Keep the public anchor the shopper saw (fictional product: only our row knows it).
  if (
    row.best_public_merchant &&
    row.best_public_price_cents != null &&
    !offers.some((o) => normalizeDomain(o.domain) === normalizeDomain(row.best_public_merchant!))
  ) {
    offers.push({
      url: row.best_public_offer_url ?? `https://${row.best_public_merchant}/`,
      domain: row.best_public_merchant,
      price: { price: centsToPrice(row.best_public_price_cents), currency: 'USD' },
      availability: 'InStock',
      condition: 'new',
    });
  }
  const i = offers.findIndex((o) => normalizeDomain(o.domain) === domain);
  const before = i >= 0 ? offers[i]! : null;
  const url =
    input.url ??
    before?.url ??
    (current === domain ? row.best_public_offer_url : null) ??
    `https://${domain}/`;
  const dropped: Channel3Offer = {
    url,
    domain,
    price: { price: centsToPrice(input.priceCents), currency: 'USD' },
    availability: 'InStock',
    condition: 'new',
  };
  if (i >= 0) offers[i] = dropped;
  else offers.push(dropped);

  const selection = parseVariantKey(row.channel3_variant);
  const snapshot: Channel3Product = {
    ...(detail ?? { id: channel3Id, title: row.title ?? 'Demo product' }),
    id: channel3Id,
    offers,
    variants: detail?.variants ?? (selection ? { options: [], selected: selection } : null),
  };
  const event: Channel3PriceChangedEvent = {
    id: input.eventId ?? `replay_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    type: 'offer.price.changed',
    data: {
      subscription_id: row.channel3_subscription_id ?? 'sub_replay',
      subject: {
        product_id: channel3Id,
        domain,
        selection,
        locale: { language: 'en', country: 'US', currency: 'USD' },
      },
      previous: before?.price ?? {
        price: centsToPrice(row.best_public_price_cents ?? input.priceCents),
        currency: 'USD',
      },
      current: { price: centsToPrice(input.priceCents), currency: 'USD' },
    },
  };
  return { ok: true, payload: { ...event, detail: snapshot } };
}
