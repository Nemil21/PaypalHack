import { auditHook, placeBid, type Db, type PayPalClient } from '@holdfast/core';
import { simBidAmount, type SimListing } from '../dev/sim-bids.js';
import { seededRandom } from './bid-table.js';
import { SEED_TEST_CARDS } from './seed.js';

/**
 * `npm run sim:stream` (HF-046, features/17 §Seed script 6): during the recording, a **bounded**
 * number of labelled SIM bids, one every 2–4 s, so the console looks alive. Each bid is a real hold
 * (sandbox, or FakePayPal in stub mode) placed through `placeBid` like the seed's, by a new SIM
 * shopper, with `release_if_cheaper = false` so the price-drop beat stays deterministic (B12).
 *
 * Stops at `count` attempts, as soon as the listing leaves OPEN (rounds start, Clear, cancel,
 * expiry), on a bid refused because the window closed, or on `signal`. `isPaused` holds it before
 * the next bid (the operator pauses it for the Clear beat, HF-028's 409 loop).
 */

export const SIM_STREAM_ACTOR = { type: 'SYSTEM', id: 'sim:stream' } as const;
export const SIM_STREAM_DEFAULT_COUNT = 20;
export const SIM_STREAM_MIN_INTERVAL_MS = 2_000;
export const SIM_STREAM_MAX_INTERVAL_MS = 4_000;
const PAUSE_POLL_MS = 250;

export interface SimStreamDeps {
  db: Db;
  paypal: PayPalClient;
  random?: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}

export interface SimStreamOptions {
  listing: SimListing;
  /** Bids to attempt (held or refused). Default 20. */
  count?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** Keys the idempotency keys; one per run. */
  runId: string;
  seed?: number;
  isPaused?: () => boolean;
  signal?: AbortSignal;
}

export type SimStreamStop = 'COUNT' | 'LISTING_NOT_OPEN' | 'ABORTED';

export interface SimStreamBid {
  n: number;
  bidId: string | null;
  amountCents: number;
  held: boolean;
  code?: string;
}

export interface SimStreamResult {
  stoppedBy: SimStreamStop;
  /** The listing status that stopped the stream (LISTING_NOT_OPEN). */
  listingStatus?: string;
  held: number;
  refused: number;
  bids: SimStreamBid[];
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** `OPEN` and inside its window: the only state sim:stream bids into. */
async function openState(db: Db, listingId: string): Promise<string | null> {
  const row = (
    await db.pool.query<{ status: string; in_window: boolean }>(
      `SELECT status, (now() < window_closes_at) IS TRUE AS in_window FROM listings WHERE id = $1`,
      [listingId],
    )
  ).rows[0];
  if (!row) return 'MISSING';
  if (row.status !== 'OPEN') return row.status;
  return row.in_window ? null : 'WINDOW_CLOSED';
}

export async function streamSimBids(
  deps: SimStreamDeps,
  opts: SimStreamOptions,
): Promise<SimStreamResult> {
  const random = deps.random ?? seededRandom(opts.seed ?? Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => {});
  const count = Math.max(0, opts.count ?? SIM_STREAM_DEFAULT_COUNT);
  const min = Math.max(0, opts.minIntervalMs ?? SIM_STREAM_MIN_INTERVAL_MS);
  const max = Math.max(min, opts.maxIntervalMs ?? SIM_STREAM_MAX_INTERVAL_MS);
  const out: SimStreamResult = { stoppedBy: 'COUNT', held: 0, refused: 0, bids: [] };
  const stop = (why: SimStreamStop, status?: string) => {
    out.stoppedBy = why;
    if (status) out.listingStatus = status;
    return out;
  };

  for (let n = 1; n <= count; n++) {
    // The gap comes first, so the first bid lands a beat after start, like every other one.
    await sleep(min + Math.floor(random() * (max - min + 1)), opts.signal);
    while (opts.isPaused?.() && !opts.signal?.aborted) await sleep(PAUSE_POLL_MS, opts.signal);
    if (opts.signal?.aborted) return stop('ABORTED');
    const closed = await openState(deps.db, opts.listing.id);
    if (closed) return stop('LISTING_NOT_OPEN', closed);

    const amountCents = simBidAmount(opts.listing, random);
    const shopperId = (
      await deps.db.pool.query<{ id: string }>(
        `INSERT INTO shoppers (display_name, is_simulated) VALUES ($1, true) RETURNING id`,
        [`SIM stream bidder ${String(n).padStart(3, '0')}`],
      )
    ).rows[0]!.id;
    const res = await placeBid(
      {
        db: deps.db,
        paypal: deps.paypal,
        audit: auditHook,
        allowTestCard: true,
        testCard: SEED_TEST_CARDS[(n - 1) % SEED_TEST_CARDS.length],
      },
      {
        shopperId,
        listingId: opts.listing.id,
        amountCents,
        paymentMethod: 'TEST_CARD',
        releaseIfCheaper: false,
        source: 'SIM',
        idempotencyKey: `sim-stream:${opts.runId}:${n}`,
        initiator: 'CUSTOMER',
        actor: SIM_STREAM_ACTOR,
      },
    );
    if (res.ok) {
      out.held++;
      out.bids.push({ n, bidId: res.bid.id, amountCents, held: true });
      log(`#${n} SIM ${fmt(amountCents)} held (bid ${res.bid.id})`);
      continue;
    }
    const err = res.error;
    const code = 'paypalCode' in err ? err.paypalCode : err.code;
    const bidId = 'bidId' in err ? err.bidId : null;
    out.refused++;
    out.bids.push({ n, bidId, amountCents, held: false, code });
    log(`#${n} SIM ${fmt(amountCents)} not held: ${code}`);
    if (err.code === 'WINDOW_CLOSED') {
      return stop('LISTING_NOT_OPEN', (await openState(deps.db, opts.listing.id)) ?? 'OPEN');
    }
  }
  return out;
}

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
