import { priceToCentsOrNull } from './money.js';
import {
  brandMatches,
  brandNamesOf,
  identifiersOf,
  isNewCondition,
  normalizeDomain,
  normalizeGtin,
  normalizeMpn,
  sameGtin,
  sameMpn,
  sameVariant,
  variantKey,
} from './product.js';
import type {
  Channel3Offer,
  Channel3PriceChangedEvent,
  Channel3Product,
  Channel3SelectedOption,
} from './types.js';

/**
 * The exact-product gate, in two stages (M21, 02 §Logic 1, 06 §Logic 3). Pure functions: callers
 * load the product / offer and the brand allowlist, and audit `PRICE_IGNORED` with the reason.
 *
 *   Stage 1, at listing creation: pin the product to GTIN, or MPN + brand, from Channel3's
 *   `structured_attributes` or entered by hand (also the fallback when Channel3 is down).
 *
 *   Stage 2, per offer / webhook: Channel3 product id + variant equal to the listing's,
 *   `condition == "new"`, `domain` in `brands.authorized_domains` (D17), `currency == "USD"`.
 *   Offers carry no GTIN, so stage 2 relies on the identity pinned in stage 1.
 */

// --- Stage 1: listing creation -------------------------------------------------------------------

export type CreationMismatchReason =
  /** No Channel3 brand fuzzy-matches the verified brand name ("Not your brand"). */
  | 'BRAND_MISMATCH'
  /** Channel3 has no new offer for the product (used / refurbished only). */
  | 'NOT_NEW'
  /** The entered GTIN has the wrong length or check digit. */
  | 'INVALID_GTIN'
  /** The entered GTIN differs from Channel3's. */
  | 'GTIN_MISMATCH'
  /** The entered MPN differs from Channel3's. */
  | 'MPN_MISMATCH'
  /** Neither a GTIN nor an MPN: block, exact matching needs one (02 §Edge cases). */
  | 'NO_IDENTIFIER';

export interface CreationMatchInput {
  /** The verified brand's name (`brands.name`). */
  brandName: string;
  /** The Channel3 product picked in the wizard; null when Channel3 is down (manual entry). */
  product: Pick<Channel3Product, 'brands' | 'offers' | 'structured_attributes'> | null;
  /** Typed by the brand in the wizard. */
  entered?: { gtin?: string | null; mpn?: string | null };
}

export interface ProductIdentity {
  /** `GTIN` when a GTIN pins the product, else `MPN_BRAND`. */
  method: 'GTIN' | 'MPN_BRAND';
  gtin: string | null;
  mpn: string | null;
  /** Channel3's brand name when known, else the verified brand's. */
  brandName: string;
  /** Where the identifier came from. */
  source: 'CHANNEL3' | 'MANUAL';
}

export type CreationMatch =
  { ok: true; identity: ProductIdentity } | { ok: false; reason: CreationMismatchReason };

export function matchAtCreation(input: CreationMatchInput): CreationMatch {
  const { product, brandName } = input;
  let catalogBrand: string | null = null;

  if (product) {
    catalogBrand = brandNamesOf(product).find((b) => brandMatches(b, brandName)) ?? null;
    if (!catalogBrand) return { ok: false, reason: 'BRAND_MISMATCH' };
    if (!(product.offers ?? []).some((o) => isNewCondition(o.condition))) {
      return { ok: false, reason: 'NOT_NEW' };
    }
  }

  const catalog = product ? identifiersOf(product) : { gtin: null, mpn: null };
  const enteredGtinRaw = input.entered?.gtin?.trim() || null;
  const enteredGtin = enteredGtinRaw ? normalizeGtin(enteredGtinRaw) : null;
  if (enteredGtinRaw && !enteredGtin) return { ok: false, reason: 'INVALID_GTIN' };
  const enteredMpn = normalizeMpn(input.entered?.mpn);

  if (catalog.gtin && enteredGtin && !sameGtin(catalog.gtin, enteredGtin)) {
    return { ok: false, reason: 'GTIN_MISMATCH' };
  }
  if (catalog.mpn && enteredMpn && !sameMpn(catalog.mpn, enteredMpn)) {
    return { ok: false, reason: 'MPN_MISMATCH' };
  }

  const gtin = catalog.gtin ?? enteredGtin;
  const mpn = catalog.mpn ?? enteredMpn;
  if (!gtin && !mpn) return { ok: false, reason: 'NO_IDENTIFIER' };

  const fromCatalog = gtin ? catalog.gtin !== null : catalog.mpn !== null;
  return {
    ok: true,
    identity: {
      method: gtin ? 'GTIN' : 'MPN_BRAND',
      gtin,
      mpn,
      brandName: catalogBrand ?? brandName,
      source: fromCatalog ? 'CHANNEL3' : 'MANUAL',
    },
  };
}

// --- Stage 2: per offer / webhook ----------------------------------------------------------------

export type OfferIgnoredReason =
  | 'PRODUCT_MISMATCH'
  | 'VARIANT_MISMATCH'
  /** `used`, `refurbished` or anything else that is not `new`. */
  | 'NOT_NEW'
  /** Channel3 sent no condition and none could be hydrated from the detail endpoint. */
  | 'CONDITION_UNKNOWN'
  | 'DOMAIN_NOT_ALLOWED'
  | 'NOT_USD'
  | 'OUT_OF_STOCK'
  | 'INVALID_PRICE';

/** What the listing pins (from its `products` row and brand). */
export interface ListingMatchTarget {
  channel3Id: string;
  /** `products.channel3_variant` (see `variantKey`); null when the product has no variants. */
  channel3Variant: string | null;
  /** `brands.authorized_domains` (D17). */
  authorizedDomains: readonly string[];
}

/** One offer as seen by the gate: from a detail response, a webhook, or a replay fixture. */
export interface OfferObservation {
  productId: string;
  /** The offer's variant `selection` (or its key). Null = the product has no variant. */
  selection: readonly Channel3SelectedOption[] | string | null;
  domain: string;
  /** Decimal, as Channel3 sends it. */
  price: number;
  currency: string;
  condition: string | null | undefined;
  /** Unknown availability passes; a known `OutOfStock` offer is not a real price. */
  availability?: string | null;
  url?: string | null;
}

export type OfferMatch =
  | { match: true; priceCents: number; domain: string; url: string | null }
  | { match: false; ignored: true; reason: OfferIgnoredReason };

const ignored = (reason: OfferIgnoredReason): OfferMatch => ({
  match: false,
  ignored: true,
  reason,
});

export function matchOffer(target: ListingMatchTarget, offer: OfferObservation): OfferMatch {
  if (offer.productId !== target.channel3Id) return ignored('PRODUCT_MISMATCH');
  const key = typeof offer.selection === 'string' ? offer.selection : variantKey(offer.selection);
  if (!sameVariant(key, target.channel3Variant)) return ignored('VARIANT_MISMATCH');
  if (offer.condition === null || offer.condition === undefined)
    return ignored('CONDITION_UNKNOWN');
  if (!isNewCondition(offer.condition)) return ignored('NOT_NEW');
  const domain = normalizeDomain(offer.domain ?? '');
  const allowed = new Set(target.authorizedDomains.map(normalizeDomain));
  if (!domain || !allowed.has(domain)) return ignored('DOMAIN_NOT_ALLOWED');
  if (offer.currency?.toUpperCase() !== 'USD') return ignored('NOT_USD');
  if (offer.availability === 'OutOfStock') return ignored('OUT_OF_STOCK');
  const priceCents = priceToCentsOrNull(offer.price);
  if (priceCents === null || priceCents === 0) return ignored('INVALID_PRICE');
  return { match: true, priceCents, domain, url: offer.url ?? null };
}

/** An offer from a product-detail response (its variant is the product's `variants.selected`). */
export function observeDetailOffer(
  product: Pick<Channel3Product, 'id' | 'variants'>,
  offer: Channel3Offer,
): OfferObservation {
  return {
    productId: product.id,
    selection: product.variants?.selected ?? null,
    domain: offer.domain,
    price: offer.price?.price,
    currency: offer.price?.currency,
    condition: offer.condition,
    availability: offer.availability,
    url: offer.url,
  };
}

/**
 * An `offer.price.changed` event as a gate input. The event has no condition or availability:
 * pass the fresh detail response (free endpoint) and they are read from the offer on the same
 * domain; without it the gate ignores the event as `CONDITION_UNKNOWN`.
 */
export function observePriceChangedEvent(
  event: Channel3PriceChangedEvent,
  detail?: Pick<Channel3Product, 'id' | 'offers'> | null,
): OfferObservation {
  const { subject, current } = event.data;
  const domain = normalizeDomain(subject.domain);
  const same =
    detail?.id === subject.product_id
      ? (detail.offers ?? []).find((o) => normalizeDomain(o.domain) === domain)
      : undefined;
  return {
    productId: subject.product_id,
    selection: subject.selection ?? null,
    domain: subject.domain,
    price: current?.price,
    currency: current?.currency,
    condition: same?.condition,
    availability: same?.availability ?? null,
    url: same?.url ?? null,
  };
}
