import {
  HOLD_MAX_AGE_HOURS,
  clear,
  toMs,
  type ClearBid,
  type ClearConflictReason,
  type ClearListingResponse,
  type ClearNumbers,
  type ClearResult,
} from '@holdfast/shared';
import { audit } from '../audit.js';
import { loadClearInput } from '../clearInput.js';
import type { Queryable, Tx } from '../db.js';
import type { Actor, MoneyDeps } from '../money/deps.js';
import { emit } from '../money/emit.js';
import { lockBids, lockListing, type LockedListing } from '../money/locks.js';
import type { BidRow } from '../money/rows.js';
import { callVoid, emitVoided, markVoided, voidKey } from '../money/void.js';
import { markKicked, type KickSettlement } from '../settlement/outbox.js';

/**
 * Clear (HF-027, features/10 §Clear transaction): lock the book, run `clear()` once, and persist
 * winners, losers, settlement rows and the `settlement_runs` outbox row in one transaction. The
 * brand-only money decision; no PayPal call happens inside the transaction (INV-1).
 */

export interface ClearListingDeps extends MoneyDeps {
  /** Start the settlement coordinator (HF-030a) after COMMIT. HF-034 re-kicks if this never runs. */
  kickSettlement?: KickSettlement;
  /** `DEMO_MODE`: only then is `listings.demo_decline_rank` copied onto a winner's CAPTURE. */
  demoMode?: boolean;
  /** Test seam: runs inside the transaction after the listing and bids are locked. */
  afterLocks?: (tx: Tx) => Promise<void>;
}

export interface ClearListingInput {
  listingId: string;
  /** Tenant from the session, never the body: another brand's listing is NOT_FOUND. */
  brandId: string;
  quantity: number;
  expectedGrossCents: number;
  /** The brand user pressing Clear (audit actor). */
  actor: Actor;
  /**
   * Client `Idempotency-Key`, recorded in the LISTING_CLEARED audit. Replays are handled by
   * HF-003b's `idempotent()` around the route.
   */
  idempotencyKey?: string | null;
}

export type ClearListingError =
  | { code: 'NOT_FOUND' }
  /** 422: `quantity` above `listing.quantity`. */
  | { code: 'VALIDATION_ERROR'; message: string; maxQuantity: number }
  | {
      code: 'STATE_CONFLICT';
      reason: ClearConflictReason;
      /** NOT_CLEARABLE: the listing's current status. */
      status?: string;
      /** BOOK_CHANGED: the recomputed numbers (M12). */
      numbers?: ClearNumbers;
      /** HOLDS_TOO_OLD / AMOUNT_MISMATCH: the winners at fault. */
      bidIds?: string[];
    };

export type ClearListingOutcome =
  | {
      ok: true;
      response: ClearListingResponse;
      /** Resolves when the post-COMMIT `HOLD_AGED` voids have finished (or been left for the sweeper). */
      released: Promise<void>;
    }
  | { ok: false; error: ClearListingError };

/** Deadlock / serialization failure: nothing was persisted, safe to run again. */
const RETRYABLE_PG_CODES = new Set(['40P01', '40001']);
const MAX_TX_ATTEMPTS = 3;
const HOLD_MAX_AGE_MS = HOLD_MAX_AGE_HOURS * 3_600_000;
/** `PayPal-Mock-Response` for the demo decline; HF-004 sends it only with ALLOW_MOCK_DECLINE. */
const DEMO_DECLINE_MOCK = 'INSTRUMENT_DECLINED';

class Refused extends Error {
  constructor(readonly error: ClearListingError) {
    super(error.code);
  }
}

type Outcome = 'WON' | 'RESERVE' | 'BELOW_FLOOR' | 'SUPERSEDED' | 'HOLD_AGED';

interface Committed {
  response: ClearListingResponse;
  aged: BidRow[];
}

/**
 * `POST /listings/:id/clear`. One transaction, same lock order as Cancel and Expire (D2):
 * listing (conditional UPDATE to CLEARING) → HELD bids by id `FOR UPDATE`. Anything that commits
 * first (cancel, watcher void, pause, raise) either waits for this and then sees WON/LOST, or
 * changes the numbers and gets this Clear a 409. Every refusal rolls back; nothing is persisted.
 */
export async function clearListing(
  deps: ClearListingDeps,
  input: ClearListingInput,
): Promise<ClearListingOutcome> {
  // Tenant and existence first, without locks (brand_id never changes).
  const head = (
    await deps.db.pool.query<{ brand_id: string; quantity: number }>(
      'SELECT brand_id, quantity FROM listings WHERE id = $1',
      [input.listingId],
    )
  ).rows[0];
  if (!head || head.brand_id !== input.brandId) return fail({ code: 'NOT_FOUND' });

  let committed: Committed | undefined;
  for (let attempt = 1; !committed; attempt++) {
    try {
      committed = await deps.db.tx((tx) => clearTx(deps, tx, input));
    } catch (err) {
      if (err instanceof Refused) return fail(err.error);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE_PG_CODES.has(code) && attempt < MAX_TX_ATTEMPTS) continue;
      throw err;
    }
  }

  const { response, aged } = committed;
  kick(deps, response.runId, input.listingId);
  const released = releaseAged(deps, aged, input.actor);
  return { ok: true, response, released };
}

function fail(error: ClearListingError): ClearListingOutcome {
  return { ok: false, error };
}

async function clearTx(
  deps: ClearListingDeps,
  tx: Tx,
  input: ClearListingInput,
): Promise<Committed> {
  // 1. Listing: OPEN/ROUNDS → CLEARING. Blocks (and waits for) landHold's FOR SHARE.
  const listing = await lockListing(tx, input.listingId, 'close', 'CLEARING');
  if (!listing) {
    const res = await tx.query('SELECT status FROM listings WHERE id = $1', [input.listingId]);
    const status = (res.rows[0] as { status?: string } | undefined)?.status;
    throw new Refused({ code: 'STATE_CONFLICT', reason: 'NOT_CLEARABLE', status });
  }
  if (input.quantity > listing.quantity) {
    throw new Refused({
      code: 'VALIDATION_ERROR',
      message: `quantity must be between 1 and ${listing.quantity}`,
      maxQuantity: listing.quantity,
    });
  }

  // 2. Every HELD bid, in id order. Cancel, the watcher, pause and raise now wait for us.
  const held = await lockBids(tx, input.listingId);
  const rowById = new Map(held.map((b) => [b.id, b]));
  await deps.afterLocks?.(tx);

  // 3. The shared Clear input (D8: no-hold bids never enter). Rows are already locked.
  const book = await loadClearInput(tx, input.listingId, { forUpdate: true });
  if (!book) throw new Refused({ code: 'NOT_FOUND' });

  // 4 + 5. Run clear() on the whole book: a stale would-be winner refuses the Clear (D6).
  const full = clear(book.bids, input.quantity, book.floorCents);
  const nowMs = listing.db_now.getTime();
  const isAged = (b: ClearBid) =>
    b.authorizedAt !== null && nowMs - toMs(b.authorizedAt) >= HOLD_MAX_AGE_MS;
  const staleWinners = full.winners.filter(isAged);
  if (staleWinners.length) {
    throw new Refused({
      code: 'STATE_CONFLICT',
      reason: 'HOLDS_TOO_OLD',
      bidIds: staleWinners.map((b) => b.id),
    });
  }
  // Stale holds are all losers, so dropping them leaves the winners (and gross) unchanged.
  const agedBids = book.bids.filter(isAged);
  const result: ClearResult = agedBids.length
    ? clear(
        book.bids.filter((b) => !isAged(b)),
        input.quantity,
        book.floorCents,
      )
    : full;

  if (result.grossCents !== input.expectedGrossCents) {
    throw new Refused({
      code: 'STATE_CONFLICT',
      reason: 'BOOK_CHANGED',
      numbers: {
        cutoffCents: result.cutoffCents,
        grossCents: result.grossCents,
        winners: result.winners.length,
        bookVersion: book.bookVersion,
      },
    });
  }

  // 6. INV-5 before any money moves: each winner's hold equals their bid.
  const badHolds = result.winners.filter((w) => {
    const row = rowById.get(w.id);
    return !row || row.authorized_amount_cents !== row.amount_cents;
  });
  if (badHolds.length) {
    throw new Refused({
      code: 'STATE_CONFLICT',
      reason: 'AMOUNT_MISMATCH',
      bidIds: badHolds.map((b) => b.id),
    });
  }

  const losers = [...result.reserve, ...result.belowFloor, ...result.superseded];
  const declineRank = deps.demoMode ? ((listing.demo_decline_rank as number | null) ?? null) : null;

  // 7. Batched conditional updates; a short rowcount means someone else moved a bid → 409.
  if (agedBids.length) {
    const res = await tx.query(
      `UPDATE bids SET status = 'VOIDING', void_reason = 'HOLD_AGED',
              void_request_id = 'void-' || id::text
        WHERE id = ANY($1::uuid[]) AND status = 'HELD'
        RETURNING *`,
      [agedBids.map((b) => b.id)],
    );
    assertCount(res.rowCount, agedBids.length);
    for (const bid of res.rows as BidRow[]) await emitVoided(tx, bid);
  }
  if (result.winners.length) {
    const res = await tx.query(
      `UPDATE bids b
          SET status = 'WON', unit_root_bid_id = b.id, won_rank = v.rank, test_decline = v.decline
         FROM unnest($1::uuid[], $2::int[], $3::bool[]) AS v(id, rank, decline)
        WHERE b.id = v.id AND b.status = 'HELD'`,
      [
        result.winners.map((w) => w.id),
        result.winners.map((_, i) => i + 1),
        result.winners.map((_, i) => declineRank === i + 1),
      ],
    );
    assertCount(res.rowCount, result.winners.length);
  }
  if (losers.length) {
    const res = await tx.query(
      `UPDATE bids SET status = 'LOST' WHERE id = ANY($1::uuid[]) AND status = 'HELD'`,
      [losers.map((b) => b.id)],
    );
    assertCount(res.rowCount, losers.length);
  }

  // 8. One multi-row settlement INSERT. Reserve = every loser at or above the floor (D10).
  const reserveIds = new Set(result.reserve.map((b) => b.id));
  const rows = [
    ...result.winners.map((w, i) => ({
      bidId: w.id,
      action: 'CAPTURE',
      amount: w.amountCents,
      reserve: false,
      mock: declineRank === i + 1 ? DEMO_DECLINE_MOCK : null,
    })),
    ...losers.map((l) => ({
      bidId: l.id,
      action: 'VOID',
      amount: null,
      reserve: reserveIds.has(l.id),
      mock: null,
    })),
  ];
  if (rows.length) {
    await tx.query(
      `INSERT INTO settlements (listing_id, bid_id, action, amount_cents, is_reserve, mock_response)
       SELECT $1, v.bid_id, v.action, v.amount, v.reserve, v.mock
         FROM unnest($2::uuid[], $3::text[], $4::int[], $5::bool[], $6::text[])
              AS v(bid_id, action, amount, reserve, mock)`,
      [
        input.listingId,
        rows.map((r) => r.bidId),
        rows.map((r) => r.action),
        rows.map((r) => r.amount),
        rows.map((r) => r.reserve),
        rows.map((r) => r.mock),
      ],
    );
  }

  // 9. Clear results on the listing.
  await tx.query(
    `UPDATE listings
        SET cutoff_cents = $2, gross_cents = $3, cleared_quantity = $4, cleared_at = now(),
            payout_email_snapshot = (SELECT payout_email FROM brands WHERE brands.id = listings.brand_id)
      WHERE id = $1 AND status = 'CLEARING'`,
    [input.listingId, result.cutoffCents, result.grossCents, result.winners.length],
  );

  // 10. Outbox row (B6): HF-030a picks it up; HF-034 re-kicks it if this process dies.
  const run = (
    await tx.query<{ id: string }>(
      `INSERT INTO settlement_runs (listing_id) VALUES ($1) RETURNING id`,
      [input.listingId],
    )
  ).rows[0]!;

  const response: ClearListingResponse = {
    status: 'CLEARING',
    cutoffCents: result.cutoffCents,
    grossCents: result.grossCents,
    winners: result.winners.length,
    losers: losers.length,
    runId: run.id,
    settlementRunId: run.id,
    holdsReleased: agedBids.length,
  };

  await writeAudits(tx, listing, input, {
    agedBids,
    result,
    book: { floorCents: book.floorCents, bookVersion: book.bookVersion },
    response,
  });

  // pg_notify inside the transaction: delivered on COMMIT only.
  await emit(tx, input.listingId, {
    type: 'listing.status',
    listingId: input.listingId,
    at: listing.db_now.toISOString(),
    from: listing.rounds_started_at ? 'ROUNDS' : 'OPEN',
    to: 'CLEARING',
  });

  return {
    response,
    aged: agedBids.map((b) => rowById.get(b.id)).filter((b): b is BidRow => !!b),
  };
}

function assertCount(actual: number | null, expected: number): void {
  if (actual !== expected)
    throw new Refused({ code: 'STATE_CONFLICT', reason: 'CONCURRENT_UPDATE' });
}

async function writeAudits(
  tx: Queryable,
  listing: LockedListing,
  input: ClearListingInput,
  ctx: {
    agedBids: ClearBid[];
    result: ClearResult;
    book: { floorCents: number; bookVersion: string };
    response: ClearListingResponse;
  },
): Promise<void> {
  const { agedBids, result } = ctx;
  const actorType = input.actor.type;
  const actorId = input.actor.id ?? null;

  // The full ranked list (features/10 §Clear transaction 8), every input bid exactly once.
  const outcome = new Map<string, Outcome>();
  result.winners.forEach((b) => outcome.set(b.id, 'WON'));
  result.reserve.forEach((b) => outcome.set(b.id, 'RESERVE'));
  result.belowFloor.forEach((b) => outcome.set(b.id, 'BELOW_FLOOR'));
  result.superseded.forEach((b) => outcome.set(b.id, 'SUPERSEDED'));
  agedBids.forEach((b) => outcome.set(b.id, 'HOLD_AGED'));
  const listed = [
    ...result.winners,
    ...result.reserve,
    ...result.belowFloor,
    ...result.superseded,
    ...agedBids,
  ].map((b) => ({
    bidId: b.id,
    rank: result.rank[b.id] ?? null,
    outcome: outcome.get(b.id),
    amountCents: b.amountCents,
    seq: b.seq,
    placedAt: b.placedAt,
    authorizedAt: b.authorizedAt,
    isSimulated: b.isSimulated,
  }));

  const entries: Array<{
    entity: string;
    entityId: string;
    action: string;
    paypalId: string | null;
    requestId: string | null;
    data: Record<string, unknown>;
  }> = agedBids.map((b) => ({
    entity: 'bid',
    entityId: b.id,
    action: 'BID_VOID_REQUESTED',
    paypalId: b.paypalAuthorizationId,
    requestId: voidKey(b.id),
    data: { reason: 'HOLD_AGED', authorizedAt: b.authorizedAt, at: 'CLEAR' },
  }));
  entries.push({
    entity: 'listing',
    entityId: listing.id,
    action: 'LISTING_CLEARED',
    paypalId: null,
    requestId: null,
    data: {
      quantity: input.quantity,
      expectedGrossCents: input.expectedGrossCents,
      floorCents: ctx.book.floorCents,
      bookVersion: ctx.book.bookVersion,
      cutoffCents: result.cutoffCents,
      grossCents: result.grossCents,
      from: listing.rounds_started_at ? 'ROUNDS' : 'OPEN',
      idempotencyKey: input.idempotencyKey ?? null,
      response: ctx.response,
      ranked: listed,
    },
  });

  for (const e of entries) {
    await audit(tx, {
      actorType,
      actorId,
      brandId: listing.brand_id,
      listingId: listing.id,
      entity: e.entity,
      entityId: e.entityId,
      action: e.action,
      paypalId: e.paypalId,
      requestId: e.requestId,
      data: e.data,
    });
  }
}

/** Best-effort kick after COMMIT; the outbox row guarantees a later kick if this one is lost. */
function kick(deps: ClearListingDeps, runId: string, listingId: string): void {
  const k = deps.kickSettlement;
  if (!k) return;
  void (async () => {
    await markKicked(deps.db.pool, runId);
    await k({ runId, listingId });
  })().catch(() => {
    // The kicker (HF-034) retries any run that is not DONE.
  });
}

/**
 * Release the `HOLD_AGED` holds flipped to VOIDING in the Clear transaction: `void-<bidId>`
 * outside any transaction, then VOIDED. On persistent failure the bid stays VOIDING for the
 * sweeper (HF-034), like any other void.
 */
function releaseAged(deps: ClearListingDeps, aged: BidRow[], actor: Actor): Promise<void> {
  if (!aged.length) return Promise.resolve();
  return (async () => {
    for (const bid of aged) {
      try {
        if (!bid.paypal_authorization_id) continue;
        const call = await callVoid(deps, bid.id, bid.paypal_authorization_id);
        if (call.done) {
          await markVoided(deps, bid.id, actor);
        } else {
          await deps.db.pool.query(
            `UPDATE bids SET error_code = $2 WHERE id = $1 AND status = 'VOIDING'`,
            [bid.id, call.code],
          );
        }
      } catch {
        // Left VOIDING; the sweeper finishes it.
      }
    }
  })();
}
