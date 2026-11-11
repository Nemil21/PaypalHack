import { formatUsd, isBiddable } from '@holdfast/shared';
import { isUuid } from './agent/history.js';
import { cancelBid, cancelMessage } from './bid-cancel.js';
import { listMyBids } from './bid-views.js';
import {
  findByKey,
  placeBid,
  placeBidResponse,
  type BidPaymentMethod,
  type PlaceBidDeps,
  type PlaceBidError,
  type PlaceBidResult,
} from './bids.js';
import type { Queryable } from './db.js';
import { runIdempotent, shouldStoreResponse, type IdempotentResponse } from './idempotency.js';
import { checkMandateLimits, liveHoldCents, type MandateDenial } from './mandates.js';
import type { Actor } from './money/deps.js';
import { publicBookBands } from './offers/public-book.js';

/**
 * MCP tools (HF-044a; features/07 §Logic 2–6, api.md §MCP server). Transport-free: `apps/api`
 * registers these with the MCP SDK; each tool calls the same service as REST (`placeBid`,
 * `cancelBid`, `listMyBids`), so mandate checks, idempotency and audit are shared. Audit rows
 * carry `actor_type = MCP_CLIENT` with the token's `mcp_clients.id`.
 *
 * Every result echoes `amountFormatted` next to integer cents (M23). Failures are tool errors
 * (`{ ok: false, code, message }`, rendered as `isError: true`), never protocol errors.
 */

/** Who is calling: the bearer token's row and its shopper (HF-043 `McpPrincipal`). */
export interface McpCaller {
  clientId: string;
  shopperId: string;
}

export type McpToolOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

const ok = (result: Record<string, unknown>): McpToolOutcome => ({ ok: true, result });
const toolError = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
): McpToolOutcome => ({ ok: false, code, message, ...(details ? { details } : {}) });

const actorOf = (caller: McpCaller): Actor => ({ type: 'MCP_CLIENT', id: caller.clientId });

// ---------------------------------------------------------------------------------------------
// get_book
// ---------------------------------------------------------------------------------------------

/** Floor-blind public book (`publicBookBands`); never the tenant-scoped brand `/book`. */
export async function mcpGetBook(
  q: Queryable,
  input: { listingSlug: string },
): Promise<McpToolOutcome> {
  const book = await publicBookBands(q, input.listingSlug);
  if (!book) return notFoundListing(input.listingSlug);
  return ok({
    listingSlug: book.listingSlug,
    brand: book.brand,
    product: book.product,
    bestPublicPriceCents: book.bestPublicPriceCents,
    bestPublicPriceFormatted:
      book.bestPublicPriceCents == null ? null : formatUsd(book.bestPublicPriceCents),
    bestPublicMerchant: book.bestPublicMerchant,
    status: book.status,
    phase: book.phase,
    biddable: book.biddable,
    windowClosesAt: book.windowClosesAt,
    roundsEndAt: book.roundsEndAt,
    demandBands: book.demandBands.map((b) => ({
      fromCents: b.fromCents,
      toCents: b.toCents,
      bids: b.bids,
      rangeFormatted: `${formatUsd(b.fromCents)}–${formatUsd(b.toCents)}`,
    })),
  });
}

function notFoundListing(slug: string): McpToolOutcome {
  return toolError('NOT_FOUND', `No open listing has the slug "${slug}".`);
}

// ---------------------------------------------------------------------------------------------
// place_bid
// ---------------------------------------------------------------------------------------------

export interface McpPlaceBidDeps extends PlaceBidDeps {
  /** `APP_BASE_URL`: makes the offer-page link absolute. Relative without it. */
  appBaseUrl?: string;
}

export interface McpPlaceBidInput {
  listingSlug: string;
  amountCents: number;
  idempotencyKey: string;
}

/** Idempotency route for MCP `place_bid` (part of the request hash, M3). */
export const MCP_PLACE_BID_ROUTE = 'MCP place_bid';

/** Why `place_bid` answered with the offer-page link instead of holding. */
export type OfferLinkReason = 'NO_SAVED_PAYMENT_METHOD' | 'NO_ACTIVE_MANDATE' | MandateDenial;

interface ListingRef {
  id: string;
  slug: string;
  status: string;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  product_id: string;
  db_now: Date;
}

/**
 * `place_bid`: a VAULT hold when the shopper has a saved payment method and an ACTIVE mandate
 * that covers this bid; otherwise our offer-page link (`/o/:slug?amount=…&src=mcp`) and no hold.
 *
 * Idempotency is per shopper (M3): HF-003b's `runIdempotent` with the shopper as principal and a
 * hash of `{listingSlug, amountCents}`, on top of the bid row's `unique(shopper_id,
 * idempotency_key)`. Another shopper's identical key is a different key. The same key with a
 * different body is `DUPLICATE`. The offer-link answer is not stored (no money moved), so the
 * same key can place the hold once the shopper is ready.
 */
export async function mcpPlaceBid(
  deps: McpPlaceBidDeps,
  caller: McpCaller,
  input: McpPlaceBidInput,
): Promise<McpToolOutcome> {
  const listing = await loadListingBySlug(deps.db.pool, input.listingSlug);
  if (!listing) return notFoundListing(input.listingSlug);

  const outcome = await runIdempotent(
    deps.db,
    {
      principal: { type: 'SHOPPER', id: caller.shopperId },
      key: input.idempotencyKey,
      route: MCP_PLACE_BID_ROUTE,
      body: { listingSlug: input.listingSlug, amountCents: input.amountCents },
    },
    async () => toResponse(await decidePlace(deps, caller, input, listing)),
    (r) => shouldStoreResponse(r) && !isOfferLink(r),
  );
  switch (outcome.kind) {
    case 'MISMATCH':
      return duplicateKey(deps.db.pool, caller.shopperId, input.idempotencyKey);
    case 'IN_PROGRESS':
      return toolError(
        'IN_PROGRESS',
        'A place_bid with this idempotencyKey is still running. Wait a moment and retry with the same key.',
      );
    default:
      return fromResponse(outcome.response);
  }
}

async function decidePlace(
  deps: McpPlaceBidDeps,
  caller: McpCaller,
  input: McpPlaceBidInput,
  listing: ListingRef,
): Promise<McpToolOutcome> {
  const pool = deps.db.pool;
  const base = {
    shopperId: caller.shopperId,
    listingId: listing.id,
    amountCents: input.amountCents,
    source: 'MCP' as const,
    initiator: 'CUSTOMER' as const,
    idempotencyKey: input.idempotencyKey,
    actor: actorOf(caller),
  };

  // The key already made a bid (REST or an earlier MCP call whose answer wasn't stored, e.g. a
  // PayPal timeout): let the bid service replay it with the same PayPal-Request-Id.
  const prior = await findByKey(pool, caller.shopperId, input.idempotencyKey);
  if (prior) {
    const result = await placeBid(deps, {
      ...base,
      paymentMethod: prior.payment_method as BidPaymentMethod,
      mandateId: prior.mandate_id,
    });
    return placedOutcome(result, input, listing.slug);
  }

  if (!biddable(listing)) return windowClosed(input.amountCents, false);

  const live = await pool.query(
    `SELECT id, amount_cents FROM bids
      WHERE shopper_id = $1 AND listing_id = $2 AND status IN ('PENDING_APPROVAL', 'HELD')
      ORDER BY placed_at DESC LIMIT 1`,
    [caller.shopperId, listing.id],
  );
  const existing = live.rows[0] as { id: string; amount_cents: number } | undefined;
  if (existing) return alreadyBid(existing.id, existing.amount_cents);

  const ready = await readiness(pool, caller.shopperId, listing, input.amountCents);
  if (!ready.ok) return offerLink(deps, listing.slug, input.amountCents, ready.reason, ready);

  // `placeBid` re-checks everything under its locks (window, one live bid, mandate cap).
  const result = await placeBid(deps, {
    ...base,
    paymentMethod: 'VAULT',
    mandateId: ready.mandateId,
  });
  return placedOutcome(result, input, listing.slug);
}

async function loadListingBySlug(q: Queryable, slug: string): Promise<ListingRef | null> {
  const res = await q.query(
    `SELECT id, slug, status, window_closes_at, rounds_end_at, product_id,
            clock_timestamp() AS db_now
       FROM listings WHERE slug = $1 AND status <> 'DRAFT'`,
    [slug],
  );
  return (res.rows[0] as ListingRef | undefined) ?? null;
}

const biddable = (l: ListingRef) =>
  !!l.window_closes_at &&
  isBiddable(
    { status: l.status as never, windowClosesAt: l.window_closes_at, roundsEndAt: l.rounds_end_at },
    l.db_now,
  );

type Readiness =
  { ok: true; mandateId: string } | { ok: false; reason: OfferLinkReason; maxPriceCents?: number };

/** Vaulted payment method + an ACTIVE mandate whose limits cover this bid right now. */
async function readiness(
  q: Queryable,
  shopperId: string,
  listing: ListingRef,
  amountCents: number,
): Promise<Readiness> {
  const shopper = await q.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [shopperId]);
  const vaulted = !!(shopper.rows[0] as { paypal_vault_id: string | null } | undefined)
    ?.paypal_vault_id;
  if (!vaulted) return { ok: false, reason: 'NO_SAVED_PAYMENT_METHOD' };

  const res = await q.query(
    `SELECT id, status, expires_at, max_price_cents, total_hold_cap_cents, allowed_product_ids
       FROM mandates
      WHERE shopper_id = $1 AND status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC`,
    [shopperId],
  );
  const mandates = res.rows as Array<{
    id: string;
    status: 'ACTIVE';
    expires_at: Date | null;
    max_price_cents: number;
    total_hold_cap_cents: number;
    allowed_product_ids: string[];
  }>;
  if (!mandates.length) return { ok: false, reason: 'NO_ACTIVE_MANDATE' };

  let first: { reason: MandateDenial; maxPriceCents: number } | null = null;
  for (const m of mandates) {
    const denial = checkMandateLimits(m, {
      newHoldCents: amountCents,
      liveCents: await liveHoldCents(q, m.id),
      productId: listing.product_id,
      now: listing.db_now,
    });
    if (!denial) return { ok: true, mandateId: m.id };
    first ??= { reason: denial, maxPriceCents: m.max_price_cents };
  }
  return { ok: false, ...first! };
}

const LINK_NOTES: Record<OfferLinkReason, string> = {
  NO_SAVED_PAYMENT_METHOD: "You don't have a saved payment method on Holdfast yet.",
  NO_ACTIVE_MANDATE: "You haven't set up an active agent mandate on Holdfast.",
  ABOVE_MANDATE_MAX: "This bid is above your agent mandate's max price.",
  MANDATE_EXCEEDED: "This bid would go over your agent mandate's total hold limit.",
  PRODUCT_NOT_ALLOWED: "Your agent mandate doesn't cover this product.",
  MANDATE_INACTIVE: "Your agent mandate isn't active.",
  MANDATE_EXPIRED: 'Your agent mandate has expired.',
  MANDATE_NOT_FOUND: "You haven't set up an active agent mandate on Holdfast.",
};

/** Our own offer page (M23), never a PayPal approveUrl. */
export function mcpOfferUrl(slug: string, amountCents: number, appBaseUrl?: string): string {
  const path = `/o/${encodeURIComponent(slug)}?amount=${amountCents}&src=mcp`;
  return appBaseUrl ? new URL(path, appBaseUrl).toString() : path;
}

function offerLink(
  deps: McpPlaceBidDeps,
  slug: string,
  amountCents: number,
  reason: OfferLinkReason,
  extra: { maxPriceCents?: number },
): McpToolOutcome {
  return ok({
    bidId: null,
    status: 'NEEDS_APPROVAL',
    amountCents,
    amountFormatted: formatUsd(amountCents),
    listingSlug: slug,
    offerUrl: mcpOfferUrl(slug, amountCents, deps.appBaseUrl),
    reason,
    ...(reason === 'ABOVE_MANDATE_MAX' && extra.maxPriceCents != null
      ? { maxPriceCents: extra.maxPriceCents, maxPriceFormatted: formatUsd(extra.maxPriceCents) }
      : {}),
    message: `${LINK_NOTES[reason]} No hold was placed. Open this link to approve the PayPal hold.`,
  });
}

function placedOutcome(
  result: PlaceBidResult,
  input: McpPlaceBidInput,
  slug: string,
): McpToolOutcome {
  if (!result.ok) return placeError(result.error, input);
  const { bid } = result;
  const amount = formatUsd(bid.amount_cents);
  return ok({
    bidId: bid.id,
    status: bid.status,
    amountCents: bid.amount_cents,
    amountFormatted: amount,
    listingSlug: slug,
    replayed: result.replayed,
    message:
      bid.status === 'HELD'
        ? `${amount} is held on your saved payment method. If you win, you're charged exactly ${amount}; otherwise it's released.`
        : `Bid ${bid.status.toLowerCase().replace(/_/g, ' ')}.`,
  });
}

function windowClosed(amountCents: number, released: boolean, bidId: string | null = null) {
  return toolError(
    'WINDOW_CLOSED',
    released
      ? `This listing's window has closed. Your ${formatUsd(amountCents)} hold was released.`
      : "This listing isn't taking new bids right now. Nothing was held.",
    { bidId, released },
  );
}

function alreadyBid(bidId: string, amountCents: number): McpToolOutcome {
  return toolError(
    'ALREADY_BID',
    `You already have a ${formatUsd(amountCents)} bid on this listing (bidId ${bidId}). Use raise_bid to raise it, or cancel_bid and place a new bid to lower it.`,
    { bidId, amountCents, amountFormatted: formatUsd(amountCents) },
  );
}

function placeError(error: PlaceBidError, input: McpPlaceBidInput): McpToolOutcome {
  switch (error.code) {
    case 'ALREADY_BID':
      return alreadyBid(error.bidId, error.amountCents);
    case 'WINDOW_CLOSED':
      return windowClosed(error.amountCents, error.released, error.bidId);
    case 'IDEMPOTENCY_MISMATCH':
      // The bid row made with this key differs (e.g. a REST bid): same answer as the hash check.
      return toolError('DUPLICATE', 'This idempotencyKey was already used for a different bid.');
    case 'ABOVE_MANDATE_MAX':
      return toolError(
        'ABOVE_MANDATE_MAX',
        `This bid is above your agent mandate's max price of ${formatUsd(error.maxPriceCents)}.`,
        { maxPriceCents: error.maxPriceCents },
      );
    case 'MANDATE_EXCEEDED':
      return toolError(
        'MANDATE_EXCEEDED',
        error.reason === 'PRODUCT_NOT_ALLOWED'
          ? "Your agent mandate doesn't cover this product."
          : "This bid would go over your agent mandate's total hold limit.",
        { bidId: error.bidId, released: error.released },
      );
    case 'MANDATE_PAUSED':
      return toolError(
        'MANDATE_PAUSED',
        error.reason === 'EXPIRED'
          ? 'Your agent mandate has expired.'
          : 'Your agent mandate is paused.',
        { bidId: error.bidId, released: error.released },
      );
    case 'HOLD_FAILED':
      return toolError(
        'HOLD_FAILED',
        `PayPal couldn't hold ${formatUsd(input.amountCents)} on your saved payment method. Nothing was held.`,
        { bidId: error.bidId },
      );
    case 'PAYPAL_ERROR':
      return toolError(
        'PAYPAL_ERROR',
        "We couldn't confirm the hold with PayPal yet. Retry with the same idempotencyKey in a moment.",
        { bidId: error.bidId },
      );
    case 'IN_PROGRESS':
      return toolError(
        'IN_PROGRESS',
        'This bid is still being placed. Retry with the same idempotencyKey in a moment.',
        { bidId: error.bidId },
      );
    default: {
      // NOT_FOUND, VALIDATION_ERROR, STATE_CONFLICT: the REST message is already plain.
      const http = placeBidResponse({
        ok: false,
        error,
        bid: null,
        replayed: false,
        publicOffer: null,
      });
      const body = http.body as { error: { code: string; message: string } };
      return toolError(body.error.code, body.error.message);
    }
  }
}

/** `DUPLICATE`: "this key was used for a $215 bid". */
async function duplicateKey(q: Queryable, shopperId: string, key: string): Promise<McpToolOutcome> {
  const bid = await findByKey(q, shopperId, key);
  let amountCents = bid?.amount_cents ?? null;
  if (amountCents == null) {
    const stored = await q.query(
      `SELECT response FROM idempotency_keys
        WHERE principal_type = 'SHOPPER' AND principal_id = $1 AND key = $2`,
      [shopperId, key],
    );
    const response = (stored.rows[0] as { response: unknown } | undefined)?.response;
    const fromBody = (response as { result?: { amountCents?: unknown } } | null)?.result
      ?.amountCents;
    if (typeof fromBody === 'number') amountCents = fromBody;
  }
  return toolError(
    'DUPLICATE',
    amountCents == null
      ? 'This idempotencyKey was already used for a different request. Use a new key for a new bid.'
      : `This idempotencyKey was used for a ${formatUsd(amountCents)} bid. Use a new key for a new bid.`,
    amountCents == null ? {} : { amountCents, amountFormatted: formatUsd(amountCents) },
  );
}

// `runIdempotent` stores `{ status, body }`; a tool outcome travels as one.
function toResponse(outcome: McpToolOutcome): IdempotentResponse {
  if (outcome.ok) return { status: outcome.result.bidId ? 201 : 200, body: outcome };
  return {
    status: RETRYABLE_STATUS[outcome.code] ?? 409,
    body: { error: { code: outcome.code, message: outcome.message }, outcome },
  };
}

/** Codes that `shouldStoreResponse` must not store; 5xx keeps them out of the store too. */
const RETRYABLE_STATUS: Record<string, number> = { PAYPAL_ERROR: 502, HOLD_FAILED: 422 };

function fromResponse(response: IdempotentResponse): McpToolOutcome {
  const body = response.body as McpToolOutcome | { outcome: McpToolOutcome };
  return 'outcome' in body ? body.outcome : body;
}

function isOfferLink(response: IdempotentResponse): boolean {
  const o = fromResponse(response);
  return o.ok && o.result.status === 'NEEDS_APPROVAL';
}

// ---------------------------------------------------------------------------------------------
// cancel_bid
// ---------------------------------------------------------------------------------------------

/** Naturally idempotent: an already VOIDING / VOIDED bid answers with its status. */
export async function mcpCancelBid(
  deps: PlaceBidDeps,
  caller: McpCaller,
  input: { bidId: string },
): Promise<McpToolOutcome> {
  const notFound = () =>
    toolError('NOT_FOUND', 'No bid of yours has that bidId. Use my_bids to list your bids.');
  if (!isUuid(input.bidId)) return notFound();
  const result = await cancelBid(deps, {
    bidId: input.bidId,
    shopperId: caller.shopperId,
    actor: actorOf(caller),
  });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND') return notFound();
    const { reason } = result.error;
    return toolError(
      'STATE_CONFLICT',
      reason === 'WON' || reason === 'CAPTURED' || reason === 'SHIPPED'
        ? 'This bid has won and can no longer be cancelled.'
        : 'This bid is being settled and can no longer be cancelled.',
      { bidId: result.error.bidId, status: reason },
    );
  }
  const { bid } = result;
  return ok({
    bidId: bid.id,
    status: bid.status,
    amountCents: bid.amount_cents,
    amountFormatted: formatUsd(bid.amount_cents),
    message: cancelMessage(bid),
  });
}

// ---------------------------------------------------------------------------------------------
// my_bids
// ---------------------------------------------------------------------------------------------

/** The caller's bids. `belowCutoff` / `cutoffCents` only while the listing is in ROUNDS (D18). */
export async function mcpMyBids(q: Queryable, caller: McpCaller): Promise<McpToolOutcome> {
  const { bids } = await listMyBids(q, caller.shopperId);
  return ok({
    bids: bids.map((b) => {
      const rounds = b.listing.status === 'ROUNDS';
      return {
        bidId: b.bidId,
        listingSlug: b.listing.slug,
        productTitle: b.listing.title,
        listingStatus: b.listing.status,
        amountCents: b.amountCents,
        amountFormatted: formatUsd(b.amountCents),
        status: b.status,
        source: b.source,
        moneyText: b.moneyText,
        belowCutoff: rounds ? b.belowCutoff : null,
        cutoffCents: rounds ? b.cutoffCents : null,
        cutoffFormatted: rounds && b.cutoffCents != null ? formatUsd(b.cutoffCents) : null,
        onReserveList: b.onReserveList,
        ...(b.priceDrop
          ? {
              priceDrop: {
                newCents: b.priceDrop.newCents,
                newPriceFormatted:
                  b.priceDrop.newCents == null ? null : formatUsd(b.priceDrop.newCents),
                store: b.priceDrop.merchant,
                url: b.priceDrop.url,
                disclosure: b.priceDrop.disclosure,
              },
            }
          : {}),
      };
    }),
  });
}
