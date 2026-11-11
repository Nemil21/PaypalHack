import {
  clear,
  listingEventSchema,
  nudgeSchema,
  nudgeText,
  selectNudges,
  type ClearBid,
  type ListingEvent,
  type Nudge,
} from '../src/index.js';

/**
 * Live-rounds fixtures (HF-036a) for builders who need rounds before a real book exists:
 * HF-037a/b (console), HF-038a/b (buyer side), HF-020 (bid timeline). Deterministic: the same
 * options always give the same events, and every number comes from `clear()` / `selectNudges`
 * exactly as the server computes it. The floor is used to run `clear()` and never appears in
 * the output.
 */

export const FIXTURE_ROUNDS_LISTING_ID = '00000000-0000-4000-8000-000000000036';
const T0 = Date.parse('2026-11-11T18:00:00.000Z');
const FLOOR_CENTS = 18_500;

export interface RoundsReplayOptions {
  listingId?: string;
  /** Bidders in the book (default 12). */
  bidders?: number;
  /** Brand's target quantity Q (default 6). */
  targetQuantity?: number;
  /** How many nudged bidders raise (default 3, capped at the number nudged). */
  raises?: number;
  /** Start time (ISO); events are 1 s apart. */
  startAt?: string;
}

const uuid = (kind: number, i: number) =>
  `00000000-0000-4000-8${kind.toString(16).padStart(3, '0')}-${i.toString(16).padStart(12, '0')}`;

/** The fixture book: amounts $260 down in $8 steps; the bottom bidders sit below the hidden floor. */
export function fixtureRoundsBook(opts: RoundsReplayOptions = {}): ClearBid[] {
  const bidders = opts.bidders ?? 12;
  return Array.from({ length: bidders }, (_, i) => ({
    id: uuid(1, i + 1),
    shopperId: uuid(2, i + 1),
    amountCents: 26_000 - i * 800,
    seq: i + 1,
    placedAt: new Date(T0 - (bidders - i) * 60_000).toISOString(),
    status: 'HELD' as const,
    paypalAuthorizationId: `AUTH-FIXTURE-${i + 1}`,
    authorizedAt: new Date(T0 - (bidders - i) * 60_000).toISOString(),
    isSimulated: i > 0,
  }));
}

/** Round 1's nudges for the fixture book, in the shared `Nudge` shape (as `my_bids` would show them). */
export function fixtureNudges(opts: RoundsReplayOptions = {}): Nudge[] {
  const listingId = opts.listingId ?? FIXTURE_ROUNDS_LISTING_ID;
  const q = opts.targetQuantity ?? 6;
  const start = opts.startAt ? Date.parse(opts.startAt) : T0;
  const result = clear(fixtureRoundsBook(opts), q, FLOOR_CENTS);
  return selectNudges(result, { targetQuantity: q, roundEndsAt: null }).map((d, i) =>
    nudgeSchema.parse({
      id: uuid(3, i + 1),
      listingId,
      bidId: d.bidId,
      shopperId: d.shopperId,
      round: 1,
      cutoffCents: d.cutoffCents,
      yourBidCents: d.yourBidCents,
      targetQuantity: d.targetQuantity,
      roundEndsAt: d.roundEndsAt,
      suggestedCents: d.suggestedCents,
      text: nudgeText(d),
      sentAt: new Date(start + 1_000).toISOString(),
    }),
  );
}

/**
 * The replay sequence: `listing.status` OPEN→ROUNDS, `round.started` → `round.nudged` × N →
 * `bid.raised` × M (the first M nudged bidders raise to their suggested amount). Each event is
 * validated against the shared `ListingEvent` schema.
 */
export function roundsReplayEvents(opts: RoundsReplayOptions = {}): ListingEvent[] {
  const listingId = opts.listingId ?? FIXTURE_ROUNDS_LISTING_ID;
  const q = opts.targetQuantity ?? 6;
  const start = opts.startAt ? Date.parse(opts.startAt) : T0;
  const at = (s: number) => new Date(start + s * 1_000).toISOString();
  const book = fixtureRoundsBook(opts);
  const result = clear(book, q, FLOOR_CENTS);
  const nudges = fixtureNudges({ ...opts, listingId });
  const seqOf = new Map(book.map((b) => [b.id, b.seq]));
  const simOf = new Map(book.map((b) => [b.id, b.isSimulated]));
  const label = (bidId: string) => `Shopper #${seqOf.get(bidId)}`;

  const events: ListingEvent[] = [
    { type: 'listing.status', listingId, at: at(0), from: 'OPEN', to: 'ROUNDS' },
    {
      type: 'round.started',
      listingId,
      at: at(0),
      round: 1,
      targetQuantity: q,
      cutoffCents: result.cutoffCents,
      roundEndsAt: null,
      roundsEndAt: at(6 * 3600),
    },
  ];
  nudges.forEach((n) =>
    events.push({
      type: 'round.nudged',
      listingId,
      at: n.sentAt,
      round: 1,
      bidId: n.bidId,
      shopperLabel: label(n.bidId),
      isSimulated: simOf.get(n.bidId) ?? false,
      cutoffCents: n.cutoffCents,
      targetCents: n.suggestedCents,
      text: n.text,
    }),
  );
  const raises = Math.min(opts.raises ?? 3, nudges.length);
  nudges.slice(0, raises).forEach((n, i) =>
    events.push({
      type: 'bid.raised',
      listingId,
      at: at(5 + i * 2),
      bidId: uuid(4, i + 1),
      replacesBidId: n.bidId,
      oldCents: n.yourBidCents,
      newCents: n.suggestedCents,
      shopperLabel: label(n.bidId),
      source: simOf.get(n.bidId) ? 'SIM' : 'BUYER_AGENT',
      isSimulated: simOf.get(n.bidId) ?? false,
    }),
  );
  return events.map((e) => listingEventSchema.parse(e));
}

/** One SSE frame (`event:` / `id:` / `data:`), as `GET /api/listings/:id/events` sends it. */
export function sseFrame(event: ListingEvent, id: number): string {
  return `event: ${event.type}\nid: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}
