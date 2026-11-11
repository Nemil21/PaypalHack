import type { ClearBid, ClearOptions, ClearResult } from './clear.js';
import { isEligibleBid } from './eligibility.js';

/**
 * Pay-your-bid call auction (features/10 §Rules). Pure and deterministic: the server Clear,
 * `/book`, `/simulate`, the console slider, the recommender and the rounds runner all call this
 * one function, so their numbers never drift. Never re-implement it in the UI.
 *
 * Steps:
 * 1. Bids the eligibility predicate rejects (default D8: HELD with a PayPal authorization id)
 *    go to `ineligible`.
 * 2. Per-shopper dedupe (D3/B1): each shopper keeps their best-ranked bid; the rest go to
 *    `superseded` (HF-027 marks them LOST and voids them).
 * 3. Bids below the floor go to `belowFloor`; the rest are ranked `amount DESC, seq ASC, id ASC`
 *    (ordinal id compare, never `localeCompare`, so every runtime agrees).
 * 4. Winners = the first `min(q, ranked.length)`; each pays their own bid. Reserve = the rest.
 *
 * Every input bid lands in exactly one of winners / reserve / belowFloor / superseded /
 * ineligible. The output does not depend on input order.
 */
export function clear(
  bids: readonly ClearBid[],
  q: number,
  floorCents: number,
  opts: ClearOptions = {},
): ClearResult {
  if (!Number.isSafeInteger(q) || q <= 0) {
    throw new RangeError(`q must be a positive integer, got ${String(q)}`);
  }
  if (!Number.isSafeInteger(floorCents) || floorCents < 0) {
    throw new RangeError(`floorCents must be a non-negative integer, got ${String(floorCents)}`);
  }
  const seen = new Set<string>();
  for (const b of bids) {
    if (!Number.isSafeInteger(b.amountCents) || b.amountCents <= 0) {
      throw new RangeError(
        `bid ${b.id}: amountCents must be a positive integer, got ${String(b.amountCents)}`,
      );
    }
    if (!Number.isSafeInteger(b.seq)) {
      throw new RangeError(`bid ${b.id}: seq must be a safe integer, got ${String(b.seq)}`);
    }
    if (seen.has(b.id)) throw new RangeError(`duplicate bid id ${b.id}`);
    seen.add(b.id);
  }

  const eligible = opts.eligible ?? isEligibleBid;
  const sorted = [...bids].sort(compareBids);

  const ineligible: ClearBid[] = [];
  const superseded: ClearBid[] = [];
  const belowFloor: ClearBid[] = [];
  const ranked: ClearBid[] = [];
  const shoppers = new Set<string>();

  // `sorted` is in rank order, so the first eligible bid per shopper is their best one.
  for (const b of sorted) {
    if (!eligible(b)) {
      ineligible.push(b);
    } else if (shoppers.has(b.shopperId)) {
      superseded.push(b);
    } else {
      shoppers.add(b.shopperId);
      (b.amountCents >= floorCents ? ranked : belowFloor).push(b);
    }
  }

  const winners = ranked.slice(0, q);
  const reserve = ranked.slice(q);
  const last = winners[winners.length - 1];
  let grossCents = 0;
  for (const w of winners) grossCents += w.amountCents;
  if (!Number.isSafeInteger(grossCents)) throw new RangeError('gross exceeds safe integer range');

  const rank: Record<string, number> = {};
  ranked.forEach((b, i) => {
    rank[b.id] = i + 1;
  });

  return {
    winners,
    cutoffCents: last ? last.amountCents : null,
    grossCents,
    reserve,
    belowFloor,
    superseded,
    ineligible,
    rank,
  };
}

/** Rank order: higher amount first, then earlier `seq`, then ordinal `id`. */
export function compareBids(a: ClearBid, b: ClearBid): number {
  if (a.amountCents !== b.amountCents) return b.amountCents - a.amountCents;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
