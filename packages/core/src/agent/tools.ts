import { formatUsd, isBiddable, MAX_AMOUNT_CENTS, MIN_AMOUNT_CENTS } from '@holdfast/shared';
import { minRaiseTargetCents, raiseAmountProblem } from '../bid-raise.js';
import { listMyBids } from '../bid-views.js';
import type { Channel3Client } from '../channel3/client.js';
import { bestOffer, brandNamesOf, imageUrlOf } from '../channel3/product.js';
import { searchProducts } from '../channel3/search.js';
import type { Queryable } from '../db.js';
import { checkMandateLimits } from '../mandates.js';
import { likelyBand, suggestedBidCents } from '../offers/likely-band.js';
import { isUuid } from './history.js';
import type { ToolDefinition } from './model.js';
import {
  createPendingAction,
  offerPageUrl,
  type ActionArgs,
  type MoneyTool,
  type PendingActionRow,
} from './pending.js';

/**
 * The buyer agent's tools (HF-039; features/04 §Tools given to the model, §Guardrails).
 *
 * Guardrails live here, in code, not in the prompt:
 * - every listing / product / bid id must exist in our DB, and bids must be the shopper's own;
 * - no output contains a floor or another shopper's data (`floor_cents` is never selected, and
 *   demand hints come from the floor-blind `likelyBand()`, M22);
 * - money tools never execute: they store a pending action and end the turn (B10);
 * - a covering ACTIVE mandate's `max_price_cents` is enforced before anything is stored.
 */

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_open_books',
    description:
      "Search Holdfast's open listings (books) matching the shopper's words (product name, brand, GTIN), plus live public prices from Channel3 for comparison. Call this first for any product request.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product words, e.g. "Aurel headphones".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_product',
    description:
      'Product details, public offers and the cheapest public price for a Channel3 product id returned by search_open_books.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { channel3Id: { type: 'string' } },
      required: ['channel3Id'],
      additionalProperties: false,
    },
  },
  {
    name: 'suggest_bid',
    description:
      'Deterministic bid suggestion for one open listing: a suggested amount and the price band most likely to clear.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { listingId: { type: 'string' } },
      required: ['listingId'],
      additionalProperties: false,
    },
  },
  {
    name: 'place_bid',
    description:
      'Propose a held bid on a listing. This does NOT place the bid: it shows the shopper a confirm card and ends your turn. Nothing is held or charged until the shopper confirms.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        listingId: { type: 'string' },
        amountCents: { type: 'integer', description: 'Whole cents, e.g. 22900 for $229.' },
      },
      required: ['listingId', 'amountCents'],
      additionalProperties: false,
    },
  },
  {
    name: 'raise_bid',
    description:
      "Propose raising one of the shopper's held bids to a new total. Shows a confirm card and ends your turn; nothing changes until the shopper confirms.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        bidId: { type: 'string' },
        amountCents: { type: 'integer', description: 'The new total in cents, not the increment.' },
      },
      required: ['bidId', 'amountCents'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_bid',
    description:
      "Propose cancelling one of the shopper's live bids (releasing its hold), or all of them with all=true. Shows one confirm card; nothing changes until the shopper confirms.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        bidId: { type: 'string', description: 'The bid to cancel; "" with all=true.' },
        all: { type: 'boolean', description: 'Cancel every live bid ("cancel everything").' },
      },
      required: ['bidId', 'all'],
      additionalProperties: false,
    },
  },
  {
    name: 'my_bids',
    description:
      "The shopper's bids with status and amount. During live rounds, belowCutoff and cutoffCents say whether a bid is currently winning.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

export const MONEY_TOOLS: ReadonlySet<string> = new Set<MoneyTool>([
  'place_bid',
  'raise_bid',
  'cancel_bid',
]);

/** Sent to the client as `confirm_required` (W16 / M05 confirm card, HF-041). */
export interface ConfirmRequired {
  actionId: string;
  tool: MoneyTool;
  /** The stored amount (place / raise); the confirm executes exactly this. */
  amountCents: number | null;
  amountFormatted: string | null;
  product: { title: string | null; imageUrl: string | null } | null;
  listing: { id: string; slug: string | null; brandName: string | null } | null;
  /** Bids a cancel would release. */
  bids?: Array<{ bidId: string; amountCents: number; title: string | null }>;
  /** `INLINE`: confirm in chat (vaulted card, CIT). `OFFER_PAGE`: open `offerUrl` (W12). */
  confirmMode: 'INLINE' | 'OFFER_PAGE';
  offerUrl: string | null;
  expiresAt: string;
}

export interface ToolContext {
  db: Queryable;
  channel3: Channel3Client;
  shopperId: string;
  conversationId: string;
  toolUseId: string;
}

export interface ToolOutcome {
  /** JSON sent back to the model as the tool_result. */
  result: Record<string, unknown>;
  isError: boolean;
  /** Set by money tools: the turn ends and the client shows a confirm card. */
  confirm?: ConfirmRequired;
  /** For the audit row and the "bid directly" fallback link. */
  listingId?: string;
  slug?: string | null;
}

const fail = (code: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome => ({
  result: { error: { code, message, ...extra } },
  isError: true,
});

const LIVE_LISTING_STATUSES = ['OPEN', 'ROUNDS'];
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'under',
  'below',
  'less',
  'than',
  'about',
  'around',
  'want',
  'need',
  'buy',
  'get',
  'find',
  'some',
  'any',
  'class',
  'like',
  'pair',
  'new',
  'cheap',
  'best',
]);

/** Search terms from free text: lowercase words of 2+ characters, no prices or filler words. */
export function searchTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  // Singular forms too, so "headphones" matches "headphone".
  const out = new Set<string>();
  for (const w of words.slice(0, 8)) {
    out.add(w);
    if (w.length > 3 && w.endsWith('s')) out.add(w.slice(0, -1));
  }
  return [...out];
}

/** Product text is data: label it, cap it, never let it look like a separate instruction. */
const data = (s: string | null | undefined, max = 200) =>
  s == null ? null : s.replace(/\s+/g, ' ').trim().slice(0, max);

interface ListingInfo {
  id: string;
  slug: string | null;
  status: string;
  quantity: number;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  db_now: Date;
  product_id: string;
  brand_name: string;
  title: string | null;
  image_url: string | null;
  channel3_id: string | null;
  best_public_price_cents: number | null;
  best_public_merchant: string | null;
  best_public_offer_url: string | null;
  price_updated_at: Date | null;
}

/** Explicit columns only: `floor_cents` is never read by any agent tool (M22). */
const LISTING_COLUMNS = `l.id, l.slug, l.status, l.quantity, l.window_closes_at, l.rounds_end_at,
  clock_timestamp() AS db_now, l.product_id, b.name AS brand_name, p.title, p.image_url,
  p.channel3_id, p.best_public_price_cents, p.best_public_merchant, p.best_public_offer_url,
  p.price_updated_at`;

async function loadListing(q: Queryable, listingId: string): Promise<ListingInfo | null> {
  if (!isUuid(listingId)) return null;
  const res = await q.query(
    `SELECT ${LISTING_COLUMNS}
       FROM listings l JOIN brands b ON b.id = l.brand_id JOIN products p ON p.id = l.product_id
      WHERE l.id = $1 AND l.status <> 'DRAFT'`,
    [listingId],
  );
  return (res.rows[0] as ListingInfo | undefined) ?? null;
}

const biddableNow = (l: ListingInfo) =>
  !!l.window_closes_at &&
  isBiddable(
    { status: l.status as never, windowClosesAt: l.window_closes_at, roundsEndAt: l.rounds_end_at },
    l.db_now,
  );

function listingView(l: ListingInfo) {
  return {
    listingId: l.id,
    slug: l.slug,
    brand: data(l.brand_name, 80),
    productTitle: data(l.title),
    status: l.status,
    biddable: biddableNow(l),
    windowClosesAt: l.window_closes_at?.toISOString() ?? null,
    roundsEndAt: l.rounds_end_at?.toISOString() ?? null,
    channel3Id: l.channel3_id,
    publicOffer:
      l.best_public_price_cents == null
        ? null
        : {
            source: 'Channel3',
            priceCents: l.best_public_price_cents,
            price: formatUsd(l.best_public_price_cents),
            merchant: data(l.best_public_merchant, 80),
            updatedAt: l.price_updated_at?.toISOString() ?? null,
          },
  };
}

async function liveBidOn(q: Queryable, shopperId: string, listingId: string) {
  const res = await q.query(
    `SELECT id, amount_cents, status FROM bids
      WHERE shopper_id = $1 AND listing_id = $2 AND status IN ('PENDING_APPROVAL', 'HELD')
      ORDER BY placed_at DESC LIMIT 1`,
    [shopperId, listingId],
  );
  return (res.rows[0] as { id: string; amount_cents: number; status: string } | undefined) ?? null;
}

/** The shopper's ACTIVE mandate that covers this product (empty product list = any product). */
async function coveringMandate(q: Queryable, shopperId: string, productId: string) {
  const res = await q.query(
    `SELECT id, status, expires_at, max_price_cents, total_hold_cap_cents, allowed_product_ids
       FROM mandates
      WHERE shopper_id = $1 AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > now())
        AND (cardinality(allowed_product_ids) = 0 OR $2::uuid = ANY(allowed_product_ids))
      ORDER BY created_at DESC LIMIT 1`,
    [shopperId, productId],
  );
  return (
    (res.rows[0] as
      | {
          id: string;
          status: 'ACTIVE';
          expires_at: Date | null;
          max_price_cents: number;
          total_hold_cap_cents: number;
          allowed_product_ids: string[];
        }
      | undefined) ?? null
  );
}

const validAmount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= MIN_AMOUNT_CENTS && n <= MAX_AMOUNT_CENTS;

async function shopperHasVault(q: Queryable, shopperId: string): Promise<boolean> {
  const res = await q.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [shopperId]);
  return !!(res.rows[0] as { paypal_vault_id: string | null } | undefined)?.paypal_vault_id;
}

async function propose(
  ctx: ToolContext,
  tool: MoneyTool,
  args: ActionArgs,
  card: Omit<ConfirmRequired, 'actionId' | 'tool' | 'expiresAt' | 'confirmMode' | 'offerUrl'>,
  opts: { offerUrl?: string | null; inline: boolean },
): Promise<ToolOutcome> {
  const action: PendingActionRow = await createPendingAction(ctx.db, {
    conversationId: ctx.conversationId,
    shopperId: ctx.shopperId,
    toolUseId: ctx.toolUseId,
    tool,
    args,
  });
  const confirm: ConfirmRequired = {
    ...card,
    actionId: action.id,
    tool,
    confirmMode: opts.inline ? 'INLINE' : 'OFFER_PAGE',
    offerUrl: opts.offerUrl ?? null,
    expiresAt: new Date(action.expires_at).toISOString(),
  };
  return {
    result: {
      confirmRequired: true,
      actionId: action.id,
      status: action.status,
      note: 'Nothing has been held or charged. The shopper must confirm on the card; your turn ends now. Do not say it is placed.',
      amountCents: card.amountCents,
    },
    isError: false,
    confirm,
    listingId: card.listing?.id,
    slug: card.listing?.slug ?? null,
  };
}

type Input = Record<string, unknown>;

/** Run one tool call. Errors become `is_error` results; nothing here throws on bad input. */
export async function runTool(
  ctx: ToolContext,
  name: string,
  rawInput: unknown,
): Promise<ToolOutcome> {
  const input: Input = rawInput && typeof rawInput === 'object' ? (rawInput as Input) : {};
  switch (name) {
    case 'search_open_books':
      return searchOpenBooks(ctx, input);
    case 'lookup_product':
      return lookupProduct(ctx, input);
    case 'suggest_bid':
      return suggestBid(ctx, input);
    case 'place_bid':
      return proposePlace(ctx, input);
    case 'raise_bid':
      return proposeRaise(ctx, input);
    case 'cancel_bid':
      return proposeCancel(ctx, input);
    case 'my_bids':
      return myBids(ctx);
    default:
      return fail('UNKNOWN_TOOL', `There is no tool called ${String(name).slice(0, 40)}.`);
  }
}

async function searchOpenBooks(ctx: ToolContext, input: Input): Promise<ToolOutcome> {
  const query = typeof input.query === 'string' ? input.query.slice(0, 200) : '';
  const terms = searchTerms(query);
  if (!terms.length) return fail('VALIDATION_ERROR', 'Say which product to look for.');
  const patterns = terms.map((t) => `%${t.replace(/[%_\\]/g, '\\$&')}%`);
  const res = await ctx.db.query(
    `SELECT ${LISTING_COLUMNS},
            (SELECT count(*) FROM unnest($1::text[]) AS t(pat)
              WHERE p.title ILIKE t.pat OR b.name ILIKE t.pat OR p.brand_name ILIKE t.pat
                 OR p.gtin ILIKE t.pat OR p.mpn ILIKE t.pat) AS hits
       FROM listings l JOIN brands b ON b.id = l.brand_id JOIN products p ON p.id = l.product_id
      WHERE l.status = ANY($2::text[])
      ORDER BY hits DESC, l.window_closes_at ASC
      LIMIT 20`,
    [patterns, LIVE_LISTING_STATUSES],
  );
  const rows = (res.rows as Array<ListingInfo & { hits: string }>).filter(
    (r) => Number(r.hits) > 0,
  );
  const listings = await Promise.all(
    rows.slice(0, 5).map(async (l) => {
      const mine = await liveBidOn(ctx.db, ctx.shopperId, l.id);
      return {
        ...listingView(l),
        suggestedBidCents: suggestedBidCents(l.best_public_price_cents),
        myBid: mine
          ? { bidId: mine.id, amountCents: mine.amount_cents, status: mine.status }
          : null,
      };
    }),
  );

  // Real Channel3 public prices stay on screen (D15); an outage never fails the search.
  let publicMarket: unknown[] | null = null;
  let publicMarketError: string | null = null;
  try {
    const hits = await searchProducts(ctx.channel3, query, { limit: 5, db: ctx.db });
    publicMarket = hits.map((h) => ({
      channel3Id: h.channel3Id,
      title: data(h.title),
      brand: data(h.brandName, 80),
      cheapestPublicPriceCents: h.bestPublicPriceCents,
      cheapestPublicPrice:
        h.bestPublicPriceCents == null ? null : formatUsd(h.bestPublicPriceCents),
      offerCount: h.offerCount,
    }));
  } catch {
    publicMarketError = 'Channel3 public prices are unavailable right now.';
  }

  return {
    result: {
      listings,
      ...(listings.length ? {} : { note: 'No open Holdfast book matches this product right now.' }),
      publicMarket,
      ...(publicMarketError ? { publicMarketError } : {}),
    },
    isError: false,
    listingId: listings[0]?.listingId,
    slug: listings[0]?.slug ?? null,
  };
}

async function lookupProduct(ctx: ToolContext, input: Input): Promise<ToolOutcome> {
  const id = typeof input.channel3Id === 'string' ? input.channel3Id : '';
  // Product ids must come from our DB (a listing or an earlier search), never from free text.
  const known =
    /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
    !!(await ctx.db.query(`SELECT 1 FROM products WHERE channel3_id = $1 LIMIT 1`, [id])).rowCount;
  if (!known) {
    return fail('NOT_FOUND', 'Unknown product id. Use a channel3Id returned by search_open_books.');
  }
  let product;
  try {
    product = await ctx.channel3.product(id);
  } catch {
    return fail(
      'CHANNEL3_ERROR',
      'Channel3 is unavailable right now; use the cached public price.',
    );
  }
  const best = bestOffer(product.offers);
  const offers = (product.offers ?? [])
    .map((o) => ({ domain: o.domain, offer: bestOffer([o]) }))
    .filter((o) => o.offer)
    .sort((a, b) => a.offer!.priceCents - b.offer!.priceCents)
    .slice(0, 5)
    .map((o) => ({ merchant: data(o.domain, 80), priceCents: o.offer!.priceCents }));
  const listings = await ctx.db.query(
    `SELECT l.id, l.slug FROM listings l JOIN products p ON p.id = l.product_id
      WHERE p.channel3_id = $1 AND l.status = ANY($2::text[])`,
    [id, LIVE_LISTING_STATUSES],
  );
  return {
    result: {
      channel3Id: product.id,
      title: data(product.title),
      brand: data(brandNamesOf(product)[0], 80),
      imageUrl: imageUrlOf(product),
      // Untrusted retailer text: shown as data only.
      productText: data((product as { description?: string | null }).description, 500),
      cheapestPublicPriceCents: best?.priceCents ?? null,
      cheapestPublicPrice: best ? formatUsd(best.priceCents) : null,
      cheapestPublicMerchant: best ? data(best.domain, 80) : null,
      offers,
      openListings: (listings.rows as Array<{ id: string; slug: string | null }>).map((l) => ({
        listingId: l.id,
        slug: l.slug,
      })),
    },
    isError: false,
  };
}

async function suggestBid(ctx: ToolContext, input: Input): Promise<ToolOutcome> {
  const l = await loadListing(ctx.db, String(input.listingId ?? ''));
  if (!l) return fail('NOT_FOUND', 'Unknown listing id. Use a listingId from search_open_books.');
  const live = LIVE_LISTING_STATUSES.includes(l.status);
  // D8 eligibility, as the offer page: amounts only, never the floor or who bid them.
  const amounts = live
    ? (
        await ctx.db.query(
          `SELECT amount_cents FROM bids
            WHERE listing_id = $1 AND status = 'HELD'
              AND paypal_authorization_id IS NOT NULL AND paypal_authorization_id <> ''`,
          [l.id],
        )
      ).rows.map((r) => (r as { amount_cents: number }).amount_cents)
    : [];
  const band = live ? likelyBand(amounts, l.quantity) : null;
  const suggested = suggestedBidCents(l.best_public_price_cents);
  return {
    result: {
      ...listingView(l),
      suggestedBidCents: suggested,
      suggestedBid: suggested == null ? null : formatUsd(suggested),
      likelyToClearBand: band
        ? {
            fromCents: band.fromCents,
            toCents: band.toCents,
            text: `${formatUsd(band.fromCents)}–${formatUsd(band.toCents)}`,
          }
        : null,
    },
    isError: false,
    listingId: l.id,
    slug: l.slug,
  };
}

async function proposePlace(ctx: ToolContext, input: Input): Promise<ToolOutcome> {
  const l = await loadListing(ctx.db, String(input.listingId ?? ''));
  if (!l) return fail('NOT_FOUND', 'Unknown listing id. Use a listingId from search_open_books.');
  if (!validAmount(input.amountCents)) {
    return fail(
      'VALIDATION_ERROR',
      `amountCents must be whole cents between ${MIN_AMOUNT_CENTS} and ${MAX_AMOUNT_CENTS}.`,
    );
  }
  const amountCents = input.amountCents;
  if (!biddableNow(l)) {
    return fail('WINDOW_CLOSED', 'This book is not taking new bids right now.', {
      listingId: l.id,
    });
  }
  const live = await liveBidOn(ctx.db, ctx.shopperId, l.id);
  if (live) {
    // D3: one live bid per listing; surfaced as "Use raise".
    return fail(
      'ALREADY_BID',
      'The shopper already has a bid on this listing. Use raise_bid instead.',
      {
        bidId: live.id,
        amountCents: live.amount_cents,
      },
    );
  }
  const mandate = await coveringMandate(ctx.db, ctx.shopperId, l.product_id);
  if (mandate) {
    const denial = checkMandateLimits(mandate, {
      newHoldCents: amountCents,
      liveCents: 0,
      productId: l.product_id,
      now: l.db_now,
    });
    if (denial === 'ABOVE_MANDATE_MAX') {
      return fail('ABOVE_MANDATE_MAX', "This is above the shopper's agent max price.", {
        maxPriceCents: mandate.max_price_cents,
      });
    }
  }
  const inline = await shopperHasVault(ctx.db, ctx.shopperId);
  return propose(
    ctx,
    'place_bid',
    { listingId: l.id, amountCents, mandateId: mandate?.id ?? null },
    {
      amountCents,
      amountFormatted: formatUsd(amountCents),
      product: { title: l.title, imageUrl: l.image_url },
      listing: { id: l.id, slug: l.slug, brandName: l.brand_name },
    },
    { inline, offerUrl: inline ? null : await offerPageUrl(ctx.db, l.id, amountCents) },
  );
}

async function ownBid(q: Queryable, shopperId: string, bidId: unknown) {
  if (!isUuid(bidId)) return null;
  const res = await q.query(
    `SELECT bi.id, bi.status, bi.amount_cents, bi.listing_id, l.slug, p.title, p.image_url,
            b.name AS brand_name
       FROM bids bi JOIN listings l ON l.id = bi.listing_id
       JOIN brands b ON b.id = l.brand_id JOIN products p ON p.id = l.product_id
      WHERE bi.id = $1 AND bi.shopper_id = $2`,
    [bidId, shopperId],
  );
  return (
    (res.rows[0] as
      | {
          id: string;
          status: string;
          amount_cents: number;
          listing_id: string;
          slug: string | null;
          title: string | null;
          image_url: string | null;
          brand_name: string;
        }
      | undefined) ?? null
  );
}

async function proposeRaise(ctx: ToolContext, input: Input): Promise<ToolOutcome> {
  // Another shopper's bid is indistinguishable from an unknown one.
  const bid = await ownBid(ctx.db, ctx.shopperId, input.bidId);
  if (!bid) return fail('NOT_FOUND', 'Unknown bid id. Use a bidId from my_bids.');
  if (bid.status !== 'HELD') {
    return fail('STATE_CONFLICT', `Only a held bid can be raised; this one is ${bid.status}.`);
  }
  if (!validAmount(input.amountCents)) {
    return fail(
      'VALIDATION_ERROR',
      `amountCents must be whole cents between ${MIN_AMOUNT_CENTS} and ${MAX_AMOUNT_CENTS}.`,
    );
  }
  const amountCents = input.amountCents;
  const problem = raiseAmountProblem(bid.amount_cents, amountCents);
  if (problem) {
    return fail('VALIDATION_ERROR', problem, {
      minAmountCents: minRaiseTargetCents(bid.amount_cents),
    });
  }
  return propose(
    ctx,
    'raise_bid',
    { bidId: bid.id, amountCents },
    {
      amountCents,
      amountFormatted: formatUsd(amountCents),
      product: { title: bid.title, imageUrl: bid.image_url },
      listing: { id: bid.listing_id, slug: bid.slug, brandName: bid.brand_name },
    },
    { inline: true },
  );
}

async function proposeCancel(ctx: ToolContext, input: Input): Promise<ToolOutcome> {
  let bids: Array<{ id: string; amount_cents: number; title: string | null }>;
  if (input.all === true) {
    // "Cancel everything": the server enumerates the shopper's live bids and asks once.
    const res = await ctx.db.query(
      `SELECT bi.id, bi.amount_cents, p.title
         FROM bids bi JOIN listings l ON l.id = bi.listing_id JOIN products p ON p.id = l.product_id
        WHERE bi.shopper_id = $1 AND bi.status IN ('PENDING_APPROVAL', 'HELD')
        ORDER BY bi.placed_at`,
      [ctx.shopperId],
    );
    bids = res.rows as typeof bids;
    if (!bids.length) return fail('NOTHING_TO_CANCEL', 'The shopper has no live bids.');
  } else {
    const bid = await ownBid(ctx.db, ctx.shopperId, input.bidId);
    if (!bid) return fail('NOT_FOUND', 'Unknown bid id. Use a bidId from my_bids.');
    if (bid.status !== 'HELD' && bid.status !== 'PENDING_APPROVAL') {
      return fail('STATE_CONFLICT', `This bid is already ${bid.status}; nothing to cancel.`);
    }
    bids = [{ id: bid.id, amount_cents: bid.amount_cents, title: bid.title }];
  }
  const total = bids.reduce((s, b) => s + b.amount_cents, 0);
  return propose(
    ctx,
    'cancel_bid',
    { bidIds: bids.map((b) => b.id) },
    {
      amountCents: total,
      amountFormatted: formatUsd(total),
      product: null,
      listing: null,
      bids: bids.map((b) => ({ bidId: b.id, amountCents: b.amount_cents, title: b.title })),
    },
    { inline: true },
  );
}

async function myBids(ctx: ToolContext): Promise<ToolOutcome> {
  const { bids } = await listMyBids(ctx.db, ctx.shopperId);
  return {
    result: {
      bids: bids.slice(0, 25).map((b) => ({
        bidId: b.bidId,
        status: b.status,
        amountCents: b.amountCents,
        amount: formatUsd(b.amountCents),
        moneyText: b.moneyText,
        listingId: b.listing.id,
        slug: b.listing.slug,
        productTitle: data(b.listing.title),
        listingStatus: b.listing.status,
        onReserveList: b.onReserveList,
        // Only during live rounds (D18).
        ...(b.listing.status === 'ROUNDS' && b.belowCutoff !== null
          ? { belowCutoff: b.belowCutoff, cutoffCents: b.cutoffCents }
          : {}),
        // Released because a store sells it cheaper (HF-042a, D18): the offer, its affiliate
        // link and the disclosure to show with it.
        ...(b.priceDrop
          ? {
              priceDrop: {
                newCents: b.priceDrop.newCents,
                newPrice: b.priceDrop.newCents == null ? null : formatUsd(b.priceDrop.newCents),
                store: data(b.priceDrop.merchant),
                url: data(b.priceDrop.url, 2048),
                disclosure: b.priceDrop.disclosure,
                replayedDemoEvent: b.priceDrop.replayed,
              },
            }
          : {}),
      })),
    },
    isError: false,
  };
}
