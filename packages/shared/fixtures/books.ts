import type { BidStatus, ClearBid, ClearResult } from '../src/index.js';
import data from './books.json' with { type: 'json' };

/**
 * Typed access to books.json, shared by the shared, web and core (Postgres) test suites so the
 * server and the console are checked against the same expected results (features/10).
 */

export interface FixtureBid {
  id: string;
  shopperId: string;
  amountCents: number;
  seq: number;
  status?: BidStatus;
  /** Omitted: a PayPal authorization id is generated. `null`: no hold (D8). */
  auth?: string | null;
}

export interface BookFixture {
  name: string;
  /** False when Postgres cannot hold the book (two HELD bids per shopper, equal seq). */
  seedable?: boolean;
  q: number;
  floorCents: number;
  bids: FixtureBid[];
  expect: {
    winners: string[];
    cutoffCents: number | null;
    grossCents: number;
    reserve: string[];
    belowFloor: string[];
    superseded: string[];
    ineligible: string[];
  };
}

export const books = data.books as BookFixture[];

export function toClearBid(b: FixtureBid): ClearBid {
  const auth = b.auth === undefined ? `AUTH-${b.id}` : b.auth;
  return {
    id: b.id,
    shopperId: b.shopperId,
    amountCents: b.amountCents,
    seq: b.seq,
    placedAt: `2026-11-11T10:00:${String(b.seq % 60).padStart(2, '0')}.000000Z`,
    status: b.status ?? 'HELD',
    paypalAuthorizationId: auth,
    authorizedAt: auth === null ? null : '2026-11-11T10:00:00.000000Z',
    isSimulated: false,
  };
}

/** Project a result onto bid ids so it compares directly with `fixture.expect`. */
export function summarize(r: ClearResult) {
  const ids = (bs: ClearBid[]) => bs.map((b) => b.id);
  return {
    winners: ids(r.winners),
    cutoffCents: r.cutoffCents,
    grossCents: r.grossCents,
    reserve: ids(r.reserve),
    belowFloor: ids(r.belowFloor),
    superseded: ids(r.superseded),
    ineligible: ids(r.ineligible),
  };
}
