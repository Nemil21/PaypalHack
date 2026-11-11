import type { Queryable } from '../db.js';
import type { Channel3Client } from './client.js';
import { isChannel3Error } from './errors.js';
import {
  bestOffer,
  brandNamesOf,
  identifiersOf,
  imageUrlOf,
  isNewCondition,
  parseVariantKey,
  variantKey,
  type PublicOffer,
} from './product.js';
import type { Channel3Product } from './types.js';

/**
 * `products` rows for Channel3 products (HF-009), keyed by `channel3_id` + `channel3_variant`.
 *
 * Identity (ids, title, brand, GTIN/MPN, image) is cached forever: an upsert only fills columns
 * that are still null. `condition` is not identity (it reflects the current offers), so every
 * snapshot that has offers overwrites it. The public price is written only by `refreshPublicOffer`, from the free
 * detail endpoint and the brand's allowlist, at most every 10 minutes; search results never touch
 * it (their prices are unfiltered and cost credits).
 */

export const PRICE_MAX_AGE_MS = 10 * 60 * 1000;

export interface ProductRow {
  id: string;
  channel3Id: string | null;
  channel3Variant: string | null;
  channel3SubscriptionId: string | null;
  gtin: string | null;
  mpn: string | null;
  brandName: string | null;
  title: string | null;
  imageUrl: string | null;
  condition: string | null;
  bestPublicPriceCents: number | null;
  bestPublicOfferUrl: string | null;
  bestPublicMerchant: string | null;
  priceUpdatedAt: Date | null;
}

const COLUMNS = `
  id, channel3_id AS "channel3Id", channel3_variant AS "channel3Variant",
  channel3_subscription_id AS "channel3SubscriptionId", gtin, mpn, brand_name AS "brandName",
  title, image_url AS "imageUrl", condition, best_public_price_cents AS "bestPublicPriceCents",
  best_public_offer_url AS "bestPublicOfferUrl", best_public_merchant AS "bestPublicMerchant",
  price_updated_at AS "priceUpdatedAt"`;

export interface ProductIdentityInput {
  channel3Id: string;
  channel3Variant: string | null;
  title: string;
  brandName: string | null;
  gtin: string | null;
  mpn: string | null;
  imageUrl: string | null;
  /** `NEW` when Channel3 has at least one new offer. */
  condition: 'NEW' | 'USED' | null;
  structuredAttributes: Record<string, string[]> | null;
}

/** Identity columns from a Channel3 product; `variant` overrides `variants.selected`. */
export function identityOf(
  product: Channel3Product,
  variant?: string | null,
): ProductIdentityInput {
  const ids = identifiersOf(product);
  const offers = product.offers ?? [];
  return {
    channel3Id: product.id,
    channel3Variant: variant !== undefined ? variant : variantKey(product.variants?.selected),
    title: product.title,
    brandName: brandNamesOf(product)[0] ?? null,
    gtin: ids.gtin,
    mpn: ids.mpn,
    imageUrl: imageUrlOf(product),
    condition: offers.some((o) => isNewCondition(o.condition))
      ? 'NEW'
      : offers.length
        ? 'USED'
        : null,
    structuredAttributes: product.structured_attributes ?? null,
  };
}

/**
 * Insert, or fill the null identity columns of the existing row; `condition` always takes the
 * fresh value when the snapshot has one. Returns the row.
 */
export async function upsertProduct(q: Queryable, p: ProductIdentityInput): Promise<ProductRow> {
  const { rows } = await q.query<ProductRow>(
    `INSERT INTO products (channel3_id, channel3_variant, title, brand_name, gtin, mpn, image_url,
                           condition, structured_attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (channel3_id, coalesce(channel3_variant, '')) WHERE channel3_id IS NOT NULL
     DO UPDATE SET
       title = coalesce(products.title, EXCLUDED.title),
       brand_name = coalesce(products.brand_name, EXCLUDED.brand_name),
       gtin = coalesce(products.gtin, EXCLUDED.gtin),
       mpn = coalesce(products.mpn, EXCLUDED.mpn),
       image_url = coalesce(products.image_url, EXCLUDED.image_url),
       condition = coalesce(EXCLUDED.condition, products.condition),
       structured_attributes = coalesce(products.structured_attributes, EXCLUDED.structured_attributes)
     RETURNING ${COLUMNS}`,
    [
      p.channel3Id,
      p.channel3Variant,
      p.title,
      p.brandName,
      p.gtin,
      p.mpn,
      p.imageUrl,
      p.condition,
      p.structuredAttributes === null ? null : JSON.stringify(p.structuredAttributes),
    ],
  );
  return rows[0]!;
}

export async function findProduct(
  q: Queryable,
  channel3Id: string,
  channel3Variant: string | null,
): Promise<ProductRow | null> {
  const { rows } = await q.query<ProductRow>(
    `SELECT ${COLUMNS} FROM products
      WHERE channel3_id = $1 AND coalesce(channel3_variant, '') = coalesce($2, '')`,
    [channel3Id, channel3Variant],
  );
  return rows[0] ?? null;
}

export async function getProduct(q: Queryable, id: string): Promise<ProductRow | null> {
  const { rows } = await q.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The cached row for a Channel3 product + variant, or fetch it through the free detail endpoint
 * and insert it (no search credit). A cached row that is not `NEW` is re-read too, since new
 * offers may have appeared since it was cached. `variant` undefined = the detail's
 * `variants.selected`. Throws `Channel3Error` when the detail call is needed and Channel3 is down.
 */
export async function ensureProduct(
  q: Queryable,
  client: Channel3Client,
  channel3Id: string,
  variant?: string | null,
): Promise<ProductRow> {
  if (variant !== undefined) {
    const cached = await findProduct(q, channel3Id, variant);
    if (cached?.condition === 'NEW') return cached;
  }
  const product = await client.product(channel3Id);
  return upsertProduct(q, identityOf(product, variant));
}

export interface PublicOfferResult {
  /** Cheapest new, in-stock, allowlisted USD offer; null when none qualifies (or never fetched). */
  publicOffer: PublicOffer | null;
  priceUpdatedAt: Date | null;
  /** True when Channel3 was called just now. */
  refreshed: boolean;
  /** True when a refresh was due but Channel3 failed: the last known values are returned. */
  stale: boolean;
}

function offerOfRow(row: ProductRow): PublicOffer | null {
  return row.bestPublicPriceCents !== null && row.bestPublicOfferUrl && row.bestPublicMerchant
    ? {
        priceCents: row.bestPublicPriceCents,
        url: row.bestPublicOfferUrl,
        domain: row.bestPublicMerchant,
      }
    : null;
}

/**
 * The offer page anchor (`publicOffer`, api.md): the row's public offer, refreshed from the free
 * detail endpoint when older than 10 minutes. Recomputed from the full offer list (rises and
 * stock-outs show), filtered by the brand allowlist (D17). Never throws for a Channel3 outage.
 */
export async function refreshPublicOffer(
  q: Queryable,
  client: Channel3Client,
  row: ProductRow,
  authorizedDomains: readonly string[],
  opts: { now?: Date; maxAgeMs?: number } = {},
): Promise<PublicOfferResult> {
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeMs ?? PRICE_MAX_AGE_MS;
  const fresh = row.priceUpdatedAt && now.getTime() - row.priceUpdatedAt.getTime() < maxAge;
  if (fresh || !row.channel3Id) {
    return {
      publicOffer: offerOfRow(row),
      priceUpdatedAt: row.priceUpdatedAt,
      refreshed: false,
      stale: false,
    };
  }
  let offer: PublicOffer | null;
  try {
    offer = bestOffer(await client.offers(row.channel3Id), { domains: authorizedDomains });
  } catch (err) {
    if (!isChannel3Error(err)) throw err;
    return {
      publicOffer: offerOfRow(row),
      priceUpdatedAt: row.priceUpdatedAt,
      refreshed: false,
      stale: true,
    };
  }
  // Conditional: a slower concurrent refresh never overwrites a newer one.
  await q.query(
    `UPDATE products
        SET best_public_price_cents = $2, best_public_offer_url = $3, best_public_merchant = $4,
            price_updated_at = $5
      WHERE id = $1 AND (price_updated_at IS NULL OR price_updated_at < $5)`,
    [row.id, offer?.priceCents ?? null, offer?.url ?? null, offer?.domain ?? null, now],
  );
  return { publicOffer: offer, priceUpdatedAt: now, refreshed: true, stale: false };
}

/**
 * The product's Channel3 subscription (D17: one per product + variant, shared by every listing
 * and bid), created on first use with the brand allowlist as the domain list. Call outside any
 * DB transaction (it calls Channel3). If two publishes race, the first stored id wins and is
 * returned to both; the loser's subscription is left unused.
 */
export async function ensureProductSubscription(
  q: Queryable,
  client: Channel3Client,
  row: ProductRow,
  domains: readonly string[],
): Promise<string> {
  if (row.channel3SubscriptionId) return row.channel3SubscriptionId;
  if (!row.channel3Id) throw new Error('product has no Channel3 id');
  const sub = await client.subscribe({
    productId: row.channel3Id,
    selection: parseVariantKey(row.channel3Variant),
    domains,
  });
  const { rows } = await q.query<{ id: string }>(
    `UPDATE products SET channel3_subscription_id = coalesce(channel3_subscription_id, $2)
      WHERE id = $1 RETURNING channel3_subscription_id AS id`,
    [row.id, sub.subscriptionId],
  );
  return rows[0]?.id ?? sub.subscriptionId;
}
