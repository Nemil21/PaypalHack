import type { Queryable } from '../db.js';
import type { Channel3Client } from './client.js';
import {
  bestOffer,
  brandMatches,
  brandNamesOf,
  identifiersOf,
  imageUrlOf,
  isNewCondition,
  newUsdOfferCount,
  variantKey,
  variantLabel,
} from './product.js';
import { identityOf, upsertProduct } from './products.js';
import type { Channel3Product } from './types.js';

/** One row of `GET /products/search` (api.md). */
export interface ProductSearchResult {
  channel3Id: string;
  /** `products.channel3_variant` key, e.g. `Color=Green`; null when the product has no variants. */
  variant: string | null;
  /** Display label, e.g. `Green`. */
  variantLabel: string | null;
  title: string;
  brandName: string | null;
  /** From `structured_attributes` when Channel3 has it (often not: enter by hand). */
  gtin: string | null;
  mpn: string | null;
  imageUrl: string | null;
  /** Cheapest new, in-stock USD offer on any domain (display only; the allowlist applies later). */
  bestPublicPriceCents: number | null;
  offerCount: number;
  condition: 'NEW' | 'USED';
  /** Brand sessions only: whether the product's brand matches the signed-in brand (02 §Logic 1). */
  brandMatch: boolean | null;
}

export function toSearchResult(
  product: Channel3Product,
  opts: { brandName?: string | null } = {},
): ProductSearchResult {
  const variant = variantKey(product.variants?.selected);
  const ids = identifiersOf(product);
  const brands = brandNamesOf(product);
  return {
    channel3Id: product.id,
    variant,
    variantLabel: variantLabel(variant),
    title: product.title,
    brandName: brands[0] ?? null,
    gtin: ids.gtin,
    mpn: ids.mpn,
    imageUrl: imageUrlOf(product),
    bestPublicPriceCents: bestOffer(product.offers)?.priceCents ?? null,
    offerCount: newUsdOfferCount(product.offers),
    condition: (product.offers ?? []).some((o) => isNewCondition(o.condition)) ? 'NEW' : 'USED',
    brandMatch: opts.brandName ? brands.some((b) => brandMatches(b, opts.brandName)) : null,
  };
}

export interface SearchProductsOptions {
  limit?: number;
  /** The signed-in brand's name, to flag "Not your brand". */
  brandName?: string | null;
  /** When given, each hit's identity is cached in `products` (no price; see `products.ts`). */
  db?: Queryable;
}

/**
 * Search Channel3 (one credit) for the wizard or the buyer agent. Throws `Channel3Error` on an
 * outage; identity caching is best-effort and never fails the search.
 */
export async function searchProducts(
  client: Channel3Client,
  query: string,
  opts: SearchProductsOptions = {},
): Promise<ProductSearchResult[]> {
  const res = await client.search(query, opts.limit === undefined ? {} : { limit: opts.limit });
  if (opts.db) {
    const db = opts.db;
    await Promise.allSettled(res.products.map((p) => upsertProduct(db, identityOf(p))));
  }
  return res.products.map((p) => toSearchResult(p, { brandName: opts.brandName ?? null }));
}
