import { priceToCentsOrNull } from './money.js';
import type { Channel3Offer, Channel3Product, Channel3SelectedOption } from './types.js';

/**
 * Pure readers over Channel3 products (HF-009): variant keys, identifiers, brand matching and the
 * cheapest exact-match offer. No I/O; shared by the search proxy, `match.ts` and the products repo.
 */

// --- Variant ------------------------------------------------------------------------------------

/**
 * `products.channel3_variant`: the variant `selection` as a stable string, options sorted by name,
 * e.g. `Color=Green` or `Color=Black;Size=XL`. Null when the product has no variant options.
 * Reversible with `parseVariantKey`, so the subscription `selection` can be rebuilt from the row.
 */
export function variantKey(
  selection: readonly Channel3SelectedOption[] | null | undefined,
): string | null {
  if (!selection?.length) return null;
  return [...selection]
    .map((s) => ({ name: s.name.trim(), label: s.label.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `${s.name}=${s.label}`)
    .join(';');
}

export function parseVariantKey(key: string | null | undefined): Channel3SelectedOption[] | null {
  if (!key) return null;
  const out = key.split(';').flatMap((part) => {
    const eq = part.indexOf('=');
    return eq > 0 ? [{ name: part.slice(0, eq), label: part.slice(eq + 1) }] : [];
  });
  return out.length ? out : null;
}

/** Display label: `Green`, `Black / XL`. */
export function variantLabel(key: string | null | undefined): string | null {
  const sel = parseVariantKey(key);
  return sel ? sel.map((s) => s.label).join(' / ') : null;
}

/** Same variant, ignoring option order and case. Null and empty both mean "no variant". */
export function sameVariant(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (k: string | null | undefined) =>
    variantKey(parseVariantKey(k))?.toLowerCase() ?? null;
  return norm(a) === norm(b);
}

// --- Identifiers ---------------------------------------------------------------------------------

const attrKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
const GTIN_KEYS = new Set([
  'gtin',
  'gtin8',
  'gtin12',
  'gtin13',
  'gtin14',
  'upc',
  'upca',
  'ean',
  'ean13',
  'ean8',
  'isbn13',
]);
const MPN_KEYS = new Set(['mpn', 'manufacturerpartnumber', 'partnumber', 'modelnumber']);

/** Digits only; null unless 8, 12, 13 or 14 digits with a valid GS1 check digit. */
export function normalizeGtin(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[\s-]/g, '');
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return null;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    // Weights alternate 3,1,3,… from the digit next to the check digit.
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1)) ? digits : null;
}

/** Same trade item: GTIN-8/12/13 are GTIN-14 with leading zeros. */
export function sameGtin(a: string, b: string): boolean {
  return a.padStart(14, '0') === b.padStart(14, '0');
}

/** MPNs compare case-insensitively, ignoring spaces, dashes, dots and slashes. */
export function normalizeMpn(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  return v ? v : null;
}

export function sameMpn(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[\s\-./]/g, '');
  return n(a) === n(b);
}

/** GTIN and MPN from `structured_attributes`, when Channel3 has them (often it does not). */
export function identifiersOf(product: Pick<Channel3Product, 'structured_attributes'>): {
  gtin: string | null;
  mpn: string | null;
} {
  let gtin: string | null = null;
  let mpn: string | null = null;
  for (const [k, values] of Object.entries(product.structured_attributes ?? {})) {
    const key = attrKey(k);
    const first = Array.isArray(values)
      ? values.find((v) => typeof v === 'string' && v.trim())
      : undefined;
    if (!first) continue;
    if (!gtin && GTIN_KEYS.has(key)) gtin = normalizeGtin(first);
    if (!mpn && MPN_KEYS.has(key)) mpn = normalizeMpn(first);
  }
  return { gtin, mpn };
}

// --- Brand ---------------------------------------------------------------------------------------

/** Corporate and category suffixes that don't distinguish brands ("Aurel Audio Inc." ≈ "Aurel"). */
const BRAND_NOISE = new Set([
  'inc',
  'llc',
  'ltd',
  'co',
  'corp',
  'corporation',
  'company',
  'gmbh',
  'the',
  'audio',
  'brands',
  'brand',
]);

function brandTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !BRAND_NOISE.has(t));
}

/**
 * Fuzzy brand match (02 §Logic 1): equal after normalising case, accents, punctuation and
 * corporate suffixes, or every token of one name appears in the other. "Aurel Audio" matches
 * "AUREL" and "Aurel Audio Inc."; "JBL" does not match "HARMAN".
 */
export function brandMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = brandTokens(a);
  const tb = brandTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.join('') === tb.join('')) return true;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((t) => long.includes(t));
}

export function brandNamesOf(product: Pick<Channel3Product, 'brands'>): string[] {
  return (product.brands ?? []).map((b) => b.name).filter(Boolean);
}

// --- Offers --------------------------------------------------------------------------------------

export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

export function isNewCondition(condition: unknown): boolean {
  return typeof condition === 'string' && condition.trim().toLowerCase() === 'new';
}

export interface PublicOffer {
  domain: string;
  priceCents: number;
  url: string;
}

export interface BestOfferOptions {
  /** Only these merchant domains (D17 allowlist). Null = any domain (search display). */
  domains?: readonly string[] | null;
}

/**
 * The cheapest exact-match public offer (06 §Logic 4): new, in stock, USD, and (when given) on an
 * allowlisted domain. Recomputed from the full offer list, never `min(old, new)`, so price rises
 * and stock-outs are reflected. Null when no offer qualifies.
 */
export function bestOffer(
  offers: readonly Channel3Offer[] | undefined,
  opts: BestOfferOptions = {},
): PublicOffer | null {
  const allow = opts.domains ? new Set(opts.domains.map(normalizeDomain)) : null;
  let best: PublicOffer | null = null;
  for (const o of offers ?? []) {
    if (!isNewCondition(o.condition)) continue;
    if (o.availability !== 'InStock') continue;
    if (o.price?.currency?.toUpperCase() !== 'USD') continue;
    const domain = normalizeDomain(o.domain ?? '');
    if (!domain || (allow && !allow.has(domain))) continue;
    const priceCents = priceToCentsOrNull(o.price.price);
    if (priceCents === null) continue;
    if (!best || priceCents < best.priceCents) best = { domain, priceCents, url: o.url };
  }
  return best;
}

/** New USD offers (any stock state): the "offer count" the wizard shows. */
export function newUsdOfferCount(offers: readonly Channel3Offer[] | undefined): number {
  return (offers ?? []).filter(
    (o) => isNewCondition(o.condition) && o.price?.currency?.toUpperCase() === 'USD',
  ).length;
}

/** Main image: the cleaned (square, background-removed) one when Channel3 has it. */
export function imageUrlOf(product: Pick<Channel3Product, 'images'>): string | null {
  const images = product.images ?? [];
  const main = images.find((i) => i.is_main_image) ?? images[0];
  return main ? (main.cleaned_url ?? main.url) : null;
}
