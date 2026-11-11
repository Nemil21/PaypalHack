import { randomBytes } from 'node:crypto';
import {
  CLEAR_AFTER_CLOSE_HOURS,
  CLEAR_MAX_AFTER_OPEN_HOURS,
  LISTING_WINDOW_HOURS,
  offerPathOf,
  type BrandListingView,
  type CreateListingResponse,
  type ListingStatus,
  type ListingWindowHours,
  type PublishListingResponse,
} from '@holdfast/shared';
import { audit } from '../audit.js';
import { BrandNotVerifiedError, lockVerifiedBrand } from '../brands/verify.js';
import type { Channel3Client } from '../channel3/client.js';
import { isChannel3Error } from '../channel3/errors.js';
import {
  matchAtCreation,
  type CreationMismatchReason,
  type ProductIdentity,
} from '../channel3/match.js';
import {
  bestOffer,
  brandMatches,
  sameGtin,
  sameMpn,
  sameVariant,
  variantKey,
  variantLabel,
} from '../channel3/product.js';
import {
  ensureProductSubscription,
  findProduct,
  getProduct,
  identityOf,
  upsertProduct,
  type ProductRow,
} from '../channel3/products.js';
import type { Db, Queryable } from '../db.js';
import { emit } from '../money/emit.js';
import type { ListingRow } from '../money/rows.js';
import { transition } from '../money/transition.js';
import { forBrand, isUuid } from '../tenancy.js';

/**
 * Listing create and publish (HF-012a; features/02 §Logic 5, api.md §`POST /listings`,
 * §`/publish`, data-model §Listing).
 *
 *   createListing   validate, pin the product (HF-009 stage-1 gate + brand rule), floor below the
 *                   cheapest exact-match public offer, insert a DRAFT with a slug. Unverified
 *                   brands may create drafts.
 *   publishListing  one transaction: brand VERIFIED (`lockVerifiedBrand`), every D6 deadline from
 *                   the database's `now()`, DRAFT→OPEN through `transition()`, `LISTING_PUBLISHED`
 *                   and a `listing.status` event. One live listing per (brand, product) → DUPLICATE.
 *                   After COMMIT: the product's Channel3 subscription (D17), reused when present;
 *                   a Channel3 outage leaves the listing OPEN with price watch off, and
 *                   `retryPriceWatchSubscriptions` tries again later.
 *
 * The draft's window length: the schema has no `window_hours` column (frozen at CP1), so a DRAFT
 * stores its chosen window as `window_opens_at` = creation time and `window_closes_at` = + 24/48 h.
 * Nothing reads a DRAFT's window as a real one; publish rebases both on its own `now()` ("Start
 * now" only: `window_opens_at` is always publish time).
 */

const HOUR_MS = 3_600_000;
const LIVE_STATUSES = ['OPEN', 'ROUNDS', 'CLEARING'] as const;
const ONE_LIVE_INDEX = 'listings_one_live_per_product';

export interface ListingDeps {
  db: Db;
  channel3: Channel3Client;
}

export interface BrandActor {
  type: 'BRAND_USER';
  id: string;
}

export type ListingError =
  | {
      code: 'VALIDATION_ERROR';
      message: string;
      field: string;
      reason: string;
      bestPublicPriceCents?: number;
      fallback?: 'MANUAL_IDENTIFIER';
    }
  | {
      code: 'PRODUCT_MISMATCH';
      reason: CreationMismatchReason | 'VARIANT_MISMATCH' | 'NOT_FOUND';
      message: string;
    }
  | { code: 'DUPLICATE'; existingListingId: string; existingSlug: string | null }
  | { code: 'NOT_FOUND' }
  | { code: 'BRAND_NOT_VERIFIED'; verificationStatus: string }
  | { code: 'STATE_CONFLICT'; reason: 'NOT_DRAFT'; status: ListingStatus };

export type ListingResult<T> = { ok: true; value: T } | { ok: false; error: ListingError };

const fail = <T>(error: ListingError): ListingResult<T> => ({ ok: false, error });

// --- Pure rules -----------------------------------------------------------------------------------

export function isListingWindowHours(h: unknown): h is ListingWindowHours {
  return LISTING_WINDOW_HOURS.includes(h as ListingWindowHours);
}

export interface PublishDeadlines {
  windowOpensAt: Date;
  windowClosesAt: Date;
  clearDeadlineAt: Date;
}

/**
 * Every deadline set at publish (D6): the window opens now and closes after 24 or 48 h;
 * `clear_deadline_at = least(window_closes_at + 6 h, window_opens_at + 60 h)`. Rounds deadlines
 * are set when rounds start (HF-036a), not here. Mirrors the HF-002 CHECKs.
 */
export function publishDeadlines(now: Date, windowHours: number): PublishDeadlines {
  if (!isListingWindowHours(windowHours)) {
    throw new RangeError(`window must be ${LISTING_WINDOW_HOURS.join(' or ')} hours`);
  }
  const opens = now.getTime();
  const closes = opens + windowHours * HOUR_MS;
  return {
    windowOpensAt: new Date(opens),
    windowClosesAt: new Date(closes),
    clearDeadlineAt: new Date(
      Math.min(
        closes + CLEAR_AFTER_CLOSE_HOURS * HOUR_MS,
        opens + CLEAR_MAX_AFTER_OPEN_HOURS * HOUR_MS,
      ),
    ),
  };
}

/**
 * The listing brand rule (HF-012a): the product's brand matches the verified brand name by
 * case-insensitive token containment after stripping "(demo)" and corporate suffixes
 * (`brandMatches`, shared with the search proxy's "Not your brand").
 */
export function productBrandMatches(
  productBrand: string | null | undefined,
  verifiedBrandName: string,
): boolean {
  return brandMatches(productBrand, verifiedBrandName);
}

/** Floor must sit below the cheapest exact-match public offer; skipped when that is unknown. */
export function floorBelowPublic(floorCents: number, bestPublicPriceCents: number | null): boolean {
  return bestPublicPriceCents === null || floorCents < bestPublicPriceCents;
}

/** `jbl-tune-770nc-a7f2`: up to four title words, ≤ 40 characters, plus 4 random hex digits. */
export function makeSlug(
  title: string | null | undefined,
  suffix = randomBytes(2).toString('hex'),
) {
  const words = (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
  let base = '';
  for (const w of words) {
    const next = base ? `${base}-${w}` : w;
    if (next.length > 40) break;
    base = next;
  }
  return `${base || 'offer'}-${suffix}`;
}

/** Draft window length in hours, from the placeholder window (see the module comment). */
export function draftWindowHours(listing: {
  window_opens_at?: unknown;
  window_closes_at?: unknown;
}): number | null {
  const opens = listing.window_opens_at;
  const closes = listing.window_closes_at;
  if (!(opens instanceof Date) || !(closes instanceof Date)) return null;
  return Math.round((closes.getTime() - opens.getTime()) / HOUR_MS);
}

// --- Create ---------------------------------------------------------------------------------------

export interface CreateListingInput {
  /** From the session (`forBrand`), never the body. */
  brandId: string;
  actor: BrandActor;
  channel3Id?: string | undefined;
  variant?: string | null | undefined;
  gtin?: string | null | undefined;
  mpn?: string | null | undefined;
  title?: string | undefined;
  quantity: number;
  floorCents: number;
  liquidationQuoteCents: number;
  windowHours: number;
}

interface BrandFacts {
  id: string;
  name: string;
  verification_status: string;
  authorized_domains: string[];
}

async function loadBrand(q: Queryable, brandId: string): Promise<BrandFacts | null> {
  const { rows } = await q.query<BrandFacts>(
    `SELECT id, name, verification_status, authorized_domains FROM brands WHERE id = $1`,
    [brandId],
  );
  return rows[0] ?? null;
}

const MISMATCH_MESSAGES: Record<string, string> = {
  BRAND_MISMATCH: 'This product is not your brand.',
  NOT_NEW: 'Only new products can be listed.',
  GTIN_MISMATCH: 'The GTIN you entered does not match this product.',
  MPN_MISMATCH: 'The MPN you entered does not match this product.',
  VARIANT_MISMATCH: 'That variant does not match this product.',
  NOT_FOUND: 'Channel3 has no product with that id.',
};

function mismatch(reason: Extract<ListingError, { code: 'PRODUCT_MISMATCH' }>['reason']) {
  return fail<never>({
    code: 'PRODUCT_MISMATCH',
    reason,
    message: MISMATCH_MESSAGES[reason] ?? 'This product cannot be listed.',
  });
}

function identityFailure(reason: CreationMismatchReason, channel3Down: boolean) {
  if (reason === 'INVALID_GTIN') {
    return fail<never>({
      code: 'VALIDATION_ERROR',
      field: 'gtin',
      reason,
      message: 'That GTIN is not valid (8, 12, 13 or 14 digits with a check digit).',
    });
  }
  if (reason === 'NO_IDENTIFIER') {
    return fail<never>({
      code: 'VALIDATION_ERROR',
      field: 'gtin',
      reason,
      message: 'Enter the GTIN or MPN so the product can be matched exactly.',
      ...(channel3Down ? { fallback: 'MANUAL_IDENTIFIER' as const } : {}),
    });
  }
  return mismatch(reason);
}

interface ResolvedProduct {
  row: ProductRow;
  identity: ProductIdentity;
  bestPublicPriceCents: number | null;
  channel3Available: boolean;
}

/** Product from Channel3's free detail endpoint, gated (stage 1 + variant + NEW). */
async function resolveFromChannel3(
  deps: ListingDeps,
  brand: BrandFacts,
  input: CreateListingInput & { channel3Id: string },
): Promise<ListingResult<ResolvedProduct> | 'DOWN'> {
  let product;
  try {
    product = await deps.channel3.product(input.channel3Id);
  } catch (err) {
    if (!isChannel3Error(err)) throw err;
    if (err.kind === 'NOT_FOUND') return mismatch('NOT_FOUND');
    return 'DOWN';
  }

  // The detail's offers belong to its selected variant; a different variant is another product.
  const selected = variantKey(product.variants?.selected);
  if (
    input.variant !== undefined &&
    !sameVariant(input.variant, selected) &&
    (input.variant ?? '').toLowerCase() !== (variantLabel(selected) ?? '').toLowerCase()
  ) {
    return mismatch('VARIANT_MISMATCH');
  }

  const match = matchAtCreation({
    brandName: brand.name,
    product,
    entered: { gtin: input.gtin ?? null, mpn: input.mpn ?? null },
  });
  if (!match.ok) return identityFailure(match.reason, false);

  // Stage-2 gate for the floor anchor: new, in stock, USD, on the brand's allowlist (D17).
  const offer = bestOffer(product.offers, { domains: brand.authorized_domains });
  const row = await upsertProduct(deps.db.pool, {
    ...identityOf(product, selected),
    gtin: match.identity.gtin,
    mpn: match.identity.mpn,
  });
  const now = new Date();
  await deps.db.pool.query(
    `UPDATE products
        SET best_public_price_cents = $2, best_public_offer_url = $3, best_public_merchant = $4,
            price_updated_at = $5
      WHERE id = $1 AND (price_updated_at IS NULL OR price_updated_at < $5)`,
    [row.id, offer?.priceCents ?? null, offer?.url ?? null, offer?.domain ?? null, now],
  );
  return {
    ok: true,
    value: {
      row,
      identity: match.identity,
      bestPublicPriceCents: offer?.priceCents ?? null,
      channel3Available: true,
    },
  };
}

/**
 * Channel3 down (02 §Edge cases): the cached row if search cached it, else a row from the manual
 * GTIN / MPN. The public price is unknown (floor check skipped) and price watch starts off.
 */
async function resolveManually(
  deps: ListingDeps,
  brand: BrandFacts,
  input: CreateListingInput,
): Promise<ListingResult<ResolvedProduct>> {
  const channel3Id = input.channel3Id ?? null;
  const cached = channel3Id
    ? await findProduct(deps.db.pool, channel3Id, input.variant ?? null)
    : null;
  if (cached?.brandName && !productBrandMatches(cached.brandName, brand.name)) {
    return mismatch('BRAND_MISMATCH');
  }
  if (cached && cached.condition && cached.condition !== 'NEW') return mismatch('NOT_NEW');

  const match = matchAtCreation({
    brandName: brand.name,
    product: null,
    entered: { gtin: input.gtin ?? cached?.gtin ?? null, mpn: input.mpn ?? cached?.mpn ?? null },
  });
  if (!match.ok) return identityFailure(match.reason, channel3Id !== null);
  const { gtin, mpn } = match.identity;
  // Cached identifiers act as the catalogue's: typed ones must agree with them.
  if (cached?.gtin && gtin && !sameGtin(cached.gtin, gtin)) return mismatch('GTIN_MISMATCH');
  if (cached?.mpn && mpn && !sameMpn(cached.mpn, mpn)) return mismatch('MPN_MISMATCH');

  let row: ProductRow;
  if (channel3Id) {
    row = await upsertProduct(deps.db.pool, {
      channel3Id,
      channel3Variant: input.variant ?? null,
      title: input.title ?? cached?.title ?? gtin ?? mpn ?? channel3Id,
      brandName: cached?.brandName ?? brand.name,
      gtin,
      mpn,
      imageUrl: null,
      // A brand listing its own overstock asserts new stock; Channel3 re-checks on the next read.
      condition: 'NEW',
      structuredAttributes: null,
    });
  } else {
    row = await manualProduct(deps.db.pool, {
      title: input.title!,
      brandName: brand.name,
      gtin,
      mpn,
    });
  }
  return {
    ok: true,
    value: {
      row,
      identity: match.identity,
      bestPublicPriceCents: null,
      channel3Available: false,
    },
  };
}

/** A product with no Channel3 id, reused by GTIN (or MPN + brand) so DUPLICATE still works. */
async function manualProduct(
  q: Queryable,
  p: { title: string; brandName: string; gtin: string | null; mpn: string | null },
): Promise<ProductRow> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM products
      WHERE channel3_id IS NULL
        AND (($1::text IS NOT NULL AND gtin = $1)
             OR ($1::text IS NULL AND $2::text IS NOT NULL AND mpn = $2 AND brand_name = $3))
      ORDER BY created_at LIMIT 1`,
    [p.gtin, p.mpn, p.brandName],
  );
  const id =
    rows[0]?.id ??
    (
      await q.query<{ id: string }>(
        `INSERT INTO products (title, brand_name, gtin, mpn, condition)
         VALUES ($1, $2, $3, $4, 'NEW') RETURNING id`,
        [p.title, p.brandName, p.gtin, p.mpn],
      )
    ).rows[0]!.id;
  return (await getProduct(q, id))!;
}

async function liveListingFor(
  q: Queryable,
  brandId: string,
  productId: string,
  exceptId: string | null = null,
): Promise<{ id: string; slug: string | null } | null> {
  const { rows } = await q.query<{ id: string; slug: string | null }>(
    `SELECT id, slug FROM listings
      WHERE brand_id = $1 AND product_id = $2 AND status = ANY($3::text[])
        AND ($4::uuid IS NULL OR id <> $4)
      LIMIT 1`,
    [brandId, productId, LIVE_STATUSES, exceptId],
  );
  return rows[0] ?? null;
}

const duplicate = (existing: { id: string; slug: string | null }) =>
  fail<never>({ code: 'DUPLICATE', existingListingId: existing.id, existingSlug: existing.slug });

function pgCode(err: unknown): { code?: string; constraint?: string } {
  return (err ?? {}) as { code?: string; constraint?: string };
}

/** `POST /api/listings`: a DRAFT with a slug. Channel3 is called before any transaction. */
export async function createListing(
  deps: ListingDeps,
  input: CreateListingInput,
): Promise<ListingResult<CreateListingResponse>> {
  if (!isListingWindowHours(input.windowHours)) {
    return fail({
      code: 'VALIDATION_ERROR',
      field: 'windowHours',
      reason: 'WINDOW_HOURS',
      message: 'The window must be 24 or 48 hours.',
    });
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    return fail({
      code: 'VALIDATION_ERROR',
      field: 'quantity',
      reason: 'QUANTITY',
      message: 'Quantity must be at least 1.',
    });
  }
  const brand = await loadBrand(deps.db.pool, input.brandId);
  if (!brand) return fail({ code: 'NOT_FOUND' });

  let resolved: ListingResult<ResolvedProduct> | 'DOWN' = 'DOWN';
  if (input.channel3Id) {
    resolved = await resolveFromChannel3(deps, brand, { ...input, channel3Id: input.channel3Id });
  }
  if (resolved === 'DOWN') resolved = await resolveManually(deps, brand, input);
  if (!resolved.ok) return resolved;
  const product = resolved.value;

  if (!floorBelowPublic(input.floorCents, product.bestPublicPriceCents)) {
    return fail({
      code: 'VALIDATION_ERROR',
      field: 'floorCents',
      reason: 'FLOOR_NOT_BELOW_PUBLIC_PRICE',
      message: 'No one will bid above a cheaper store: set the floor below the public price.',
      bestPublicPriceCents: product.bestPublicPriceCents!,
    });
  }

  const existing = await liveListingFor(deps.db.pool, brand.id, product.row.id);
  if (existing) return duplicate(existing);

  for (let attempt = 0; ; attempt++) {
    const slug = makeSlug(product.row.title);
    try {
      const listing = await deps.db.tx(async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO listings (brand_id, product_id, slug, status, quantity, floor_cents,
                                 liquidation_quote_cents, window_opens_at, window_closes_at)
           VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, now(), now() + make_interval(hours => $7))
           RETURNING id`,
          [
            brand.id,
            product.row.id,
            slug,
            input.quantity,
            input.floorCents,
            input.liquidationQuoteCents,
            input.windowHours,
          ],
        );
        const id = rows[0]!.id;
        await audit(tx, {
          actorType: input.actor.type,
          actorId: input.actor.id,
          brandId: brand.id,
          listingId: id,
          entity: 'listing',
          entityId: id,
          action: 'LISTING_CREATED',
          data: {
            productId: product.row.id,
            channel3Id: product.row.channel3Id,
            variant: product.row.channel3Variant,
            identity: product.identity,
            quantity: input.quantity,
            windowHours: input.windowHours,
            bestPublicPriceCents: product.bestPublicPriceCents,
            channel3Available: product.channel3Available,
          },
        });
        return { id };
      });
      return {
        ok: true,
        value: {
          listingId: listing.id,
          status: 'DRAFT',
          slug,
          productId: product.row.id,
          windowHours: input.windowHours,
          bestPublicPriceCents: product.bestPublicPriceCents,
          channel3Available: product.channel3Available,
        },
      };
    } catch (err) {
      const { code, constraint } = pgCode(err);
      if (code === '23505' && constraint === 'listings_slug_key' && attempt < 5) continue;
      throw err;
    }
  }
}

// --- Publish --------------------------------------------------------------------------------------

export interface PublishListingInput {
  brandId: string;
  listingId: string;
  actor: BrandActor;
}

/**
 * After COMMIT, outside any transaction (it calls Channel3): the product's subscription, reused
 * when the product already has one (D17). Returns whether price watch is on. Never throws for a
 * Channel3 outage; the retrier picks the product up later.
 */
export async function ensurePriceWatch(
  deps: ListingDeps,
  productId: string,
  authorizedDomains: readonly string[],
): Promise<boolean> {
  const row = await getProduct(deps.db.pool, productId);
  if (!row?.channel3Id) return false;
  try {
    await ensureProductSubscription(deps.db.pool, deps.channel3, row, authorizedDomains);
    return true;
  } catch (err) {
    if (isChannel3Error(err)) return false;
    throw err;
  }
}

/** `POST /api/listings/:id/publish`. */
export async function publishListing(
  deps: ListingDeps,
  input: PublishListingInput,
): Promise<ListingResult<PublishListingResponse>> {
  if (!isUuid(input.listingId)) return fail({ code: 'NOT_FOUND' });
  let published: { listing: ListingRow; brand: BrandFacts } | ListingError;
  try {
    published = await deps.db.tx(async (tx) => {
      // Publish guard first (HF-011a), with the brand row share-locked for the transaction.
      if (!(await lockVerifiedBrand(tx, input.brandId))) return { code: 'NOT_FOUND' } as const;
      const brand = (await loadBrand(tx, input.brandId))!;
      const { rows } = await tx.query<ListingRow>(
        `SELECT * FROM listings WHERE id = $1 AND brand_id = $2 FOR UPDATE`,
        [input.listingId, input.brandId],
      );
      const draft = rows[0];
      if (!draft) return { code: 'NOT_FOUND' } as const;
      if (draft.status !== 'DRAFT') {
        return { code: 'STATE_CONFLICT', reason: 'NOT_DRAFT', status: draft.status } as const;
      }
      const existing = await liveListingFor(
        tx,
        input.brandId,
        draft.product_id as string,
        draft.id,
      );
      if (existing) {
        return {
          code: 'DUPLICATE',
          existingListingId: existing.id,
          existingSlug: existing.slug,
        } as const;
      }

      // `now()` is the transaction's start time: read once, every deadline derives from it.
      const { rows: clock } = await tx.query<{ now: Date }>(`SELECT now() AS now`);
      const hours = draftWindowHours(draft);
      const d = publishDeadlines(clock[0]!.now, isListingWindowHours(hours) ? hours : 48);
      const listing = await transition<'listings', ListingRow>(
        tx,
        'listings',
        draft.id,
        'DRAFT',
        'OPEN',
        {
          window_opens_at: d.windowOpensAt,
          window_closes_at: d.windowClosesAt,
          clear_deadline_at: d.clearDeadlineAt,
          published_at: d.windowOpensAt,
        },
      );
      // Unreachable while the row is locked, but `transition` is the only status writer.
      if (!listing)
        return { code: 'STATE_CONFLICT', reason: 'NOT_DRAFT', status: draft.status } as const;

      await audit(tx, {
        actorType: input.actor.type,
        actorId: input.actor.id,
        brandId: input.brandId,
        listingId: listing.id,
        entity: 'listing',
        entityId: listing.id,
        action: 'LISTING_PUBLISHED',
        data: {
          from: 'DRAFT',
          to: 'OPEN',
          slug: listing.slug,
          windowHours: hours,
          windowOpensAt: d.windowOpensAt.toISOString(),
          windowClosesAt: d.windowClosesAt.toISOString(),
          clearDeadlineAt: d.clearDeadlineAt.toISOString(),
        },
      });
      await emit(tx, listing.id, {
        type: 'listing.status',
        listingId: listing.id,
        at: d.windowOpensAt.toISOString(),
        from: 'DRAFT',
        to: 'OPEN',
      });
      return { listing, brand };
    });
  } catch (err) {
    if (err instanceof BrandNotVerifiedError) {
      return fail({ code: 'BRAND_NOT_VERIFIED', verificationStatus: err.verificationStatus });
    }
    const { code, constraint } = pgCode(err);
    // Two drafts of one product published at once: the partial unique index decides.
    if (code === '23505' && constraint === ONE_LIVE_INDEX) {
      const { rows } = await deps.db.pool.query<{ product_id: string }>(
        `SELECT product_id FROM listings WHERE id = $1`,
        [input.listingId],
      );
      const existing = rows[0]
        ? await liveListingFor(deps.db.pool, input.brandId, rows[0].product_id, input.listingId)
        : null;
      if (existing) return duplicate(existing);
    }
    throw err;
  }
  if ('code' in published) return fail(published);

  const { listing, brand } = published;
  const priceWatch = await ensurePriceWatch(
    deps,
    listing.product_id as string,
    brand.authorized_domains,
  );
  if (!priceWatch) {
    await audit(deps.db.pool, {
      actorType: 'SYSTEM',
      brandId: brand.id,
      listingId: listing.id,
      entity: 'listing',
      entityId: listing.id,
      action: 'PRICE_WATCH_OFF',
      data: { productId: listing.product_id, retry: true },
    });
  }
  return {
    ok: true,
    value: {
      listingId: listing.id,
      status: 'OPEN',
      slug: listing.slug as string,
      offerPath: offerPathOf(listing.slug as string),
      windowOpensAt: (listing.window_opens_at as Date).toISOString(),
      windowClosesAt: listing.window_closes_at!.toISOString(),
      clearDeadlineAt: listing.clear_deadline_at!.toISOString(),
      priceWatch,
    },
  };
}

// --- Price-watch retry ----------------------------------------------------------------------------

/** Default retry tick for products of live listings that have no Channel3 subscription yet. */
export const PRICE_WATCH_RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * One retry pass: every product with a Channel3 id, an OPEN or ROUNDS listing and no subscription
 * gets `ensureProductSubscription` (idempotent: the first stored id wins). Returns how many are
 * now subscribed. A subscription's domain list is the first live listing brand's allowlist.
 */
export async function retryPriceWatchSubscriptions(
  deps: ListingDeps,
): Promise<{ subscribed: number; failed: number }> {
  const { rows } = await deps.db.pool.query<{ product_id: string; authorized_domains: string[] }>(
    `SELECT DISTINCT ON (p.id) p.id AS product_id, b.authorized_domains
       FROM products p
       JOIN listings l ON l.product_id = p.id AND l.status IN ('OPEN', 'ROUNDS')
       JOIN brands b ON b.id = l.brand_id
      WHERE p.channel3_id IS NOT NULL AND p.channel3_subscription_id IS NULL
      ORDER BY p.id, l.published_at`,
  );
  let subscribed = 0;
  for (const r of rows) {
    if (await ensurePriceWatch(deps, r.product_id, r.authorized_domains)) subscribed++;
  }
  return { subscribed, failed: rows.length - subscribed };
}

/** In-process retrier (one web instance; the subscribe call is idempotent per product). */
export function startPriceWatchRetrier(
  deps: ListingDeps,
  opts: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await retryPriceWatchSubscriptions(deps);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? PRICE_WATCH_RETRY_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// --- List -----------------------------------------------------------------------------------------

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);

/** `GET /api/listings`: the session brand's listings, newest first (`forBrand`). */
export async function listBrandListings(
  q: Queryable,
  brandId: string,
  opts: { status?: readonly string[] } = {},
): Promise<BrandListingView[]> {
  const listings = await forBrand(q, brandId).listings(opts);
  if (!listings.length) return [];
  const { rows: products } = await q.query<ProductRow>(
    `SELECT id, channel3_id AS "channel3Id", channel3_variant AS "channel3Variant",
            channel3_subscription_id AS "channel3SubscriptionId", gtin, mpn,
            brand_name AS "brandName", title, image_url AS "imageUrl",
            best_public_price_cents AS "bestPublicPriceCents"
       FROM products WHERE id = ANY($1::uuid[])`,
    [[...new Set(listings.map((l) => l.product_id as string))]],
  );
  const byId = new Map(products.map((p) => [p.id, p]));
  return listings.map((l) => {
    const p = byId.get(l.product_id as string);
    const slug = (l.slug as string | null) ?? null;
    return {
      listingId: l.id,
      slug,
      status: l.status,
      offerPath: slug && l.status !== 'DRAFT' ? offerPathOf(slug) : null,
      quantity: l.quantity,
      floorCents: l.floor_cents,
      liquidationQuoteCents: (l.liquidation_quote_cents as number | null) ?? null,
      windowHours: draftWindowHours(l),
      windowOpensAt: l.status === 'DRAFT' ? null : iso(l.window_opens_at),
      windowClosesAt: l.status === 'DRAFT' ? null : iso(l.window_closes_at),
      clearDeadlineAt: iso(l.clear_deadline_at),
      publishedAt: iso(l.published_at),
      createdAt: iso(l.created_at)!,
      priceWatch: Boolean(p?.channel3SubscriptionId),
      product: {
        productId: l.product_id as string,
        title: p?.title ?? null,
        brandName: p?.brandName ?? null,
        imageUrl: p?.imageUrl ?? null,
        channel3Id: p?.channel3Id ?? null,
        variant: p?.channel3Variant ?? null,
        gtin: p?.gtin ?? null,
        mpn: p?.mpn ?? null,
        bestPublicPriceCents: p?.bestPublicPriceCents ?? null,
      },
    };
  });
}
