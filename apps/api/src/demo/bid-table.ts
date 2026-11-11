import {
  clear,
  selectNudges,
  simulateClear,
  type ClearBid,
  type ClearInput,
  type SimulateResponse,
} from '@holdfast/shared';
import { AUREL_A5, AUREL_A7, PRICE_DROP_FIXTURE } from './aurel-fixture.js';

/**
 * The deterministic SIM bid table for `npm run seed:demo` (HF-045, features/17 §Seed script).
 * Pure: the same seed always gives the same table, so two seeds print the same numbers.
 *
 * Shape of the Aurel A7 book (280 SIM shoppers, `is_simulated = true`):
 * - 240 card bids at $219–$249 with at least ten at exactly $219 and none at $218, so
 *   `simulate(240)` reads "240 at $219" and the brand agent's "cutoff ≥ (1 − 22%) × $279"
 *   recommendation lands on 240 (HF-051a);
 * - 20 card bids at $189–$217 (a few under the $199 floor);
 * - 20 round agents at $205–$217: vaulted, each with an ACTIVE mandate. Even-numbered agents
 *   have a maximum above the round-one suggested raise (cutoff + 1%), odd ones just above their
 *   own bid, so about half raise when nudged (HF-038b).
 *
 * Bids above the planned price-drop level are `release_if_cheaper = false` (B12), so the
 * replayed drop voids only the foreground bids it is aimed at (≤ 3).
 */

export const DEFAULT_SEED = 45;
/** The quantity the video script quotes (`simulate(240)`). */
export const DEMO_QUANTITY = 240;
export const A7_CARD_BIDS = 260;
export const ROUND_AGENTS = 20;
export const A5_BIDS = 8;
/** Sandbox test cards the holds rotate over (S7 step 6). */
export const TEST_CARD_COUNT = 5;
/**
 * Round agents vault their card; the sandbox refuses to vault the Discover test card
 * (`CREDIT_CARD_NUMBER_MUST_BE_TEST_NUMBER`, HF-045 dry run), so agents rotate over the first four.
 */
export const VAULTABLE_TEST_CARD_COUNT = 4;

/**
 * The shape of one seeded book. `FULL_BOOK` is the recording book above; `JUDGE_BOOK` is the
 * smaller book the daily `demo:refresh` cron reseeds for judges (HF-048b): 60 real sandbox holds,
 * the same price shape (cutoff $219), a few round agents, and an A7 listing small enough that a
 * judge's Clear has winners and losers.
 */
export interface BookSpec {
  name: 'full' | 'judge';
  /** Units on the A7 listing. */
  a7ListingQuantity: number;
  /** The quantity the printed numbers simulate. */
  quantity: number;
  /** A7 card bids at $219–$249 (the first ten at exactly $219). */
  highCards: number;
  /** A7 card bids at $189–$217. */
  lowCards: number;
  /** Vaulted round agents with ACTIVE mandates. */
  agents: number;
  a5Bids: number;
}

export const FULL_BOOK: BookSpec = {
  name: 'full',
  a7ListingQuantity: AUREL_A7.quantity,
  quantity: DEMO_QUANTITY,
  highCards: DEMO_QUANTITY,
  lowCards: A7_CARD_BIDS - DEMO_QUANTITY,
  agents: ROUND_AGENTS,
  a5Bids: A5_BIDS,
};

export const JUDGE_BOOK: BookSpec = {
  name: 'judge',
  a7ListingQuantity: 50,
  quantity: 44,
  highCards: 44,
  lowCards: 8,
  agents: 4,
  a5Bids: 4,
};

export function bookSize(book: BookSpec): number {
  return book.highCards + book.lowCards + book.agents + book.a5Bids;
}

export interface TableBid {
  /** 1-based, stable across runs: also the shopper's display number and idempotency key. */
  n: number;
  listing: 'A7' | 'A5';
  kind: 'CARD' | 'AGENT';
  amountCents: number;
  releaseIfCheaper: boolean;
  /** Index into the test-card rotation. */
  card: number;
  /** Where in the backdated window `placed_at` falls, in [0, 1). */
  placedAt: number;
  /** Round agents only: the mandate's per-item maximum. */
  mandateMaxCents: number | null;
}

/** mulberry32: small, fast, and identical on every runtime. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const dollars = (d: number) => d * 100;

function intBetween(random: () => number, lo: number, hi: number): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

/** A whole-dollar amount in [lo, hi] that is never $218 (the gap under the $219 cutoff). */
function lowAmount(random: () => number, lo: number, hi: number): number {
  const d = intBetween(random, lo, hi);
  return dollars(d === 218 ? 217 : d);
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export function buildBidTable(seed: number = DEFAULT_SEED, book: BookSpec = FULL_BOOK): TableBid[] {
  const random = seededRandom(seed);
  const dropTo = PRICE_DROP_FIXTURE.toCents;
  type Draft = Omit<TableBid, 'n' | 'card' | 'placedAt' | 'releaseIfCheaper'>;
  const a7: Draft[] = [];

  for (let i = 0; i < book.highCards; i++) {
    let d: number;
    if (i < 10) d = 219;
    else {
      const r = random();
      d =
        r < 0.65
          ? intBetween(random, 219, 225)
          : r < 0.92
            ? intBetween(random, 226, 238)
            : intBetween(random, 239, 249);
    }
    a7.push({ listing: 'A7', kind: 'CARD', amountCents: dollars(d), mandateMaxCents: null });
  }
  for (let i = 0; i < book.lowCards; i++) {
    a7.push({
      listing: 'A7',
      kind: 'CARD',
      amountCents: lowAmount(random, 189, 217),
      mandateMaxCents: null,
    });
  }
  for (let i = 0; i < book.agents; i++) {
    const amountCents = lowAmount(random, 205, 217);
    const mandateMaxCents =
      i % 2 === 0
        ? dollars(intBetween(random, 224, 235))
        : amountCents + dollars(intBetween(random, 1, 2));
    a7.push({ listing: 'A7', kind: 'AGENT', amountCents, mandateMaxCents });
  }

  const a5: Draft[] = [];
  for (let i = 0; i < book.a5Bids; i++) {
    a5.push({
      listing: 'A5',
      kind: 'CARD',
      amountCents: dollars(intBetween(random, 85, 115)),
      mandateMaxCents: null,
    });
  }

  // Interleave high and low bids over the window; agents are vaulted first, so keep them in
  // their own block (still shuffled among themselves).
  const ordered = [...shuffle(a7, random), ...a5];
  return ordered.map((b, i) => ({
    ...b,
    n: i + 1,
    card: b.kind === 'AGENT' ? i % VAULTABLE_TEST_CARD_COUNT : i % TEST_CARD_COUNT,
    placedAt: random(),
    releaseIfCheaper: !(b.listing === 'A7' && b.amountCents > dropTo),
  }));
}

/** The table as a Clear input (synthetic ids `t-<n>`), for the expected numbers. */
export function tableClearInput(
  table: readonly TableBid[],
  listing: 'A7' | 'A5',
  book: BookSpec = FULL_BOOK,
): ClearInput {
  const fixture = listing === 'A7' ? AUREL_A7 : AUREL_A5;
  const bids: ClearBid[] = table
    .filter((b) => b.listing === listing)
    .map((b) => ({
      id: `t-${b.n}`,
      shopperId: `s-${b.n}`,
      amountCents: b.amountCents,
      seq: b.n,
      placedAt: new Date(1_700_000_000_000 + Math.floor(b.placedAt * 1e9)).toISOString(),
      status: 'HELD',
      paypalAuthorizationId: `table-${b.n}`,
      authorizedAt: null,
      isSimulated: true,
    }));
  return {
    listingId: `table-${listing}`,
    floorCents: fixture.floorCents,
    quantity: listing === 'A7' ? book.a7ListingQuantity : fixture.quantity,
    bids,
    bookVersion: 'table',
    oldestHoldAuthorizedAt: null,
  };
}

export interface BidMeta {
  releaseIfCheaper: boolean;
  /** Set for round agents: the mandate maximum their auto-raise may not exceed. */
  mandateMaxCents: number | null;
}

export interface ProjectionOptions {
  quantity: number;
  dropToCents: number;
  feeBps: number;
  liquidationQuoteCents: number | null;
}

export interface DemoNumbers {
  current: SimulateResponse;
  postDrop: SimulateResponse;
  postRounds: SimulateResponse;
  /** Bids the replayed price drop voids (amount above the new price, release on). */
  voidedByDrop: number;
  /** Scripted auto-raises across all rounds, and the rounds that had any. */
  raises: number;
  raisers: number;
  rounds: number;
}

const MAX_ROUNDS = 10;

/**
 * The three numbers the video script quotes, from one Clear input:
 * 1. `current`: `simulate(q)` now;
 * 2. `postDrop`: after the replayed price drop voids every bid above `dropToCents` that has
 *    "release if cheaper" on (features/06);
 * 3. `postRounds`: after live rounds, assuming each nudged round agent raises once per nudge to
 *    the suggested amount when its mandate allows (HF-038b), until a round has no raise.
 */
export function projectDemoNumbers(
  input: ClearInput,
  meta: ReadonlyMap<string, BidMeta>,
  opts: ProjectionOptions,
): DemoNumbers {
  const sim = (bids: ClearBid[]) =>
    simulateClear({ ...input, bids }, opts.quantity, {
      feeBps: opts.feeBps,
      liquidationQuoteCents: opts.liquidationQuoteCents,
    });
  const current = sim(input.bids);

  const survivors = input.bids.filter(
    (b) => !(b.amountCents > opts.dropToCents && (meta.get(b.id)?.releaseIfCheaper ?? true)),
  );
  const postDrop = sim(survivors);

  let bids = survivors.map((b) => ({ ...b }));
  let raises = 0;
  let rounds = 0;
  const raisers = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = clear(bids, opts.quantity, input.floorCents);
    const nudges = selectNudges(result, { targetQuantity: opts.quantity, roundEndsAt: null });
    const raised = new Map<string, number>();
    for (const n of nudges) {
      const max = meta.get(n.bidId)?.mandateMaxCents;
      if (max != null && n.suggestedCents <= max) raised.set(n.bidId, n.suggestedCents);
    }
    if (raised.size === 0) break;
    rounds++;
    raises += raised.size;
    for (const id of raised.keys()) raisers.add(id);
    bids = bids.map((b) => (raised.has(b.id) ? { ...b, amountCents: raised.get(b.id)! } : b));
  }

  return {
    current,
    postDrop,
    postRounds: sim(bids),
    voidedByDrop: input.bids.length - survivors.length,
    raises,
    raisers: raisers.size,
    rounds,
  };
}

/** Expected numbers straight from the table (no database, no PayPal). */
export function expectedTableNumbers(
  seed: number = DEFAULT_SEED,
  book: BookSpec = FULL_BOOK,
): DemoNumbers {
  const table = buildBidTable(seed, book);
  const meta = new Map(
    table
      .filter((b) => b.listing === 'A7')
      .map((b) => [
        `t-${b.n}`,
        { releaseIfCheaper: b.releaseIfCheaper, mandateMaxCents: b.mandateMaxCents },
      ]),
  );
  return projectDemoNumbers(tableClearInput(table, 'A7', book), meta, {
    quantity: book.quantity,
    dropToCents: PRICE_DROP_FIXTURE.toCents,
    feeBps: AUREL_BRAND_FEE_BPS,
    liquidationQuoteCents: AUREL_A7.liquidationQuoteCents,
  });
}

/** `brands.fee_bps` default (9%, HOLDFAST-SPEC §Pay). */
export const AUREL_BRAND_FEE_BPS = 900;
