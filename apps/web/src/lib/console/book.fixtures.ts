import {
  bookOrder,
  buildDemandCurve,
  type BookBid,
  type BookResponse,
  type ClearBid,
  type ClearInput,
} from '@holdfast/shared';

/**
 * Test-only: the `GET /book` body the server would send for a Clear input, built the way
 * `loadBook` (packages/core/src/listings/book.ts) builds it, with the same shared `bookOrder` and
 * `buildDemandCurve`. Lets the slider tests check client numbers against `simulateClear` without
 * Postgres; `apps/api/src/routes/slider-parity.test.ts` does the same over HTTP.
 */
export function bookFromInput(
  input: ClearInput,
  listing: { liquidationQuoteCents?: number | null; targetQuantity?: number | null } = {},
): BookResponse {
  const { ordered, rank, belowFloor } = bookOrder(input.bids, input.floorCents);
  const bids: BookBid[] = ordered.map((b, i) => ({
    id: b.id,
    amountCents: b.amountCents,
    rank: rank[b.id] ?? null,
    placedAtUs: String(1_000_000 + i),
    source: b.isSimulated ? 'SIM' : 'OFFER_PAGE',
    isSimulated: b.isSimulated,
    shopperLabel: `Shopper #${1001 + i}`,
    status: 'HELD',
    belowFloor: belowFloor.has(b.id),
  }));
  const heldCents = input.bids.reduce((s, b) => s + b.amountCents, 0);
  return {
    listing: {
      id: input.listingId,
      slug: 'aurel-a7',
      status: 'OPEN',
      phase: 'BIDDING',
      product: { title: 'Aurel A7', imageUrl: null },
      quantity: input.quantity,
      floorCents: input.floorCents,
      liquidationQuoteCents:
        listing.liquidationQuoteCents === undefined ? 3_800 : listing.liquidationQuoteCents,
      feeBps: 500,
      windowOpensAt: null,
      windowClosesAt: null,
      roundsStartedAt: null,
      roundsEndAt: null,
      roundEndsAt: null,
      currentRound: null,
      targetQuantity: listing.targetQuantity ?? null,
      clearDeadlineAt: null,
      oldestHoldAuthorizedAt: null,
      clearByAt: null,
      priceWatch: {
        on: true,
        bestPublicPriceCents: 27_900,
        merchant: 'retailer.example',
        offerUrl: null,
        priceUpdatedAt: null,
      },
    },
    stats: {
      liveBids: input.bids.length,
      heldCents,
      simulatedHeldCents: input.bids
        .filter((b) => b.isSimulated)
        .reduce((s, b) => s + b.amountCents, 0),
      bestPublicPriceCents: 27_900,
      releasedByPriceWatch: 0,
    },
    curve: buildDemandCurve(ordered.filter((b) => rank[b.id] || belowFloor.has(b.id))),
    bids,
    pending: [],
    bookVersion: `v${input.bids.length}`,
    asOf: '2026-11-11T12:00:00.000Z',
  };
}

/** A held bid as `loadClearInput` returns it (one per shopper, D8-eligible). */
export function heldBid(i: number, amountCents: number, patch: Partial<ClearBid> = {}): ClearBid {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    shopperId: `shopper-${i}`,
    amountCents,
    seq: i + 1,
    placedAt: '2026-11-11T10:00:00.000000Z',
    status: 'HELD',
    paypalAuthorizationId: `AUTH-${i}`,
    authorizedAt: '2026-11-11T10:00:00.000Z',
    isSimulated: i % 3 === 0,
    ...patch,
  };
}

export function clearInput(bids: ClearBid[], quantity: number, floorCents = 19_900): ClearInput {
  return {
    listingId: 'listing-1',
    floorCents,
    quantity,
    bids,
    bookVersion: `v${bids.length}`,
    oldestHoldAuthorizedAt: null,
  };
}
