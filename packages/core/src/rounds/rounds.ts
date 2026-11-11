import {
  clear,
  selectNudges,
  type Nudge,
  type OnNudge,
  type RoundEndReason,
  type RoundsConflictReason,
  type RoundsState,
} from '@holdfast/shared';
import { audit } from '../audit.js';
import { loadClearInput } from '../clearInput.js';
import type { Db, Queryable, Tx } from '../db.js';
import { emit } from '../money/emit.js';
import type { ListingRow } from '../money/rows.js';
import { sendNudge, type EmitFn } from './nudges.js';
import { nudgeTextFor, roundTemplate, type NudgePhraser } from './phrasing.js';
import { UNSCALED_TIMING, type RoundsTiming } from './timing.js';

/**
 * Live rounds, basic part (HF-036a; features/19 §Logic 1–3, 6–7). The brand starts rounds once,
 * advances them with "Next round" and stops them. Each round writes one truthful nudge snapshot
 * (M10) from `loadClearInput` + `clear()`. HF-036b adds the timer: every round gets
 * `round_ends_at = least(now() + roundLen, rounds_end_at)` and the in-process tick (`tick.ts`)
 * advances it through the same `advanceRound`; "Next round" stays as the manual control.
 *
 * Every write is one transaction that starts with a conditional `UPDATE listings`, so the
 * listing row lock is taken first (lock order: listing → bids). `landHold` takes the listing
 * `FOR SHARE`, so a hold landing concurrently either commits before (and is in this round's book)
 * or after (and sees the new deadlines: no new bids in ROUNDS, D7).
 */

export interface RoundsDeps {
  db: Db;
  /** HF-038b's nudge consumer; called after COMMIT, once per new nudge. Errors are swallowed. */
  onNudge?: OnNudge;
  /** Test seam: replaces HF-003a `emit` (still called inside the transaction). */
  emit?: EmitFn;
  /** Test seam: runs inside the transaction right after the listing UPDATE. */
  afterListingUpdate?: (tx: Tx) => Promise<void>;
  /** HF-036b: round length, soft close, extension and cap (`ROUNDS_TIME_SCALE`). Default 1×. */
  timing?: RoundsTiming;
  /** HF-036b: Claude nudge phrasing, one call per round; template text when absent or failing. */
  phraser?: NudgePhraser;
  /** Default 5 s. */
  phrasingTimeoutMs?: number;
  onPhrasingError?: (err: unknown) => void;
}

/**
 * Who is asking. Only a brand OWNER or MANAGER may run rounds; VIEWER, shoppers, buyer agents,
 * MCP clients and the brand agent are refused (features/19 §Logic 1, features/09).
 */
export interface RoundsActor {
  type: string;
  id: string;
  role?: string | null;
}

interface Base {
  listingId: string;
  /** Tenant from the session; another brand's listing is NOT_FOUND. */
  brandId: string;
  actor: RoundsActor;
}

export type RoundsError =
  | { code: 'NOT_FOUND' }
  | { code: 'FORBIDDEN' }
  | { code: 'VALIDATION_ERROR'; message: string; maxQuantity: number }
  | {
      code: 'STATE_CONFLICT';
      reason: RoundsConflictReason;
      status?: string;
      round?: number | null;
    };

export type RoundsOutcome =
  { ok: true; state: RoundsState; nudges: Nudge[] } | { ok: false; error: RoundsError };

const ROUNDS_ROLES = new Set(['OWNER', 'MANAGER']);
const RETRYABLE_PG_CODES = new Set(['40P01', '40001']);
const MAX_TX_ATTEMPTS = 3;

class Refused extends Error {
  constructor(readonly error: RoundsError) {
    super(error.code);
  }
}

export function canRunRounds(actor: RoundsActor): boolean {
  return actor.type === 'BRAND_USER' && !!actor.role && ROUNDS_ROLES.has(actor.role);
}

export type RoundsListing = ListingRow & {
  window_opens_at: Date | null;
  rounds_started_at: Date | null;
  current_round: number | null;
  round_ends_at: Date | null;
  target_quantity: number | null;
  db_now: Date;
};

export interface TxResult {
  listing: RoundsListing;
  nudges: Nudge[];
  endedReason: RoundEndReason | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function stateOf(r: TxResult): RoundsState {
  const l = r.listing;
  return {
    listingId: l.id,
    status: l.status,
    round: l.current_round,
    targetQuantity: l.target_quantity,
    roundsStartedAt: iso(l.rounds_started_at),
    roundEndsAt: iso(l.round_ends_at),
    roundsEndAt: iso(l.rounds_end_at),
    windowClosesAt: iso(l.window_closes_at),
    clearDeadlineAt: iso(l.clear_deadline_at),
    nudged: r.nudges.length,
    endedReason: r.endedReason,
  };
}

async function run(
  deps: RoundsDeps,
  input: Base,
  body: (tx: Tx) => Promise<TxResult>,
): Promise<RoundsOutcome> {
  if (!canRunRounds(input.actor)) return { ok: false, error: { code: 'FORBIDDEN' } };
  let result: TxResult | undefined;
  for (let attempt = 1; !result; attempt++) {
    try {
      result = await deps.db.tx(body);
    } catch (err) {
      if (err instanceof Refused) return { ok: false, error: err.error };
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE_PG_CODES.has(code) && attempt < MAX_TX_ATTEMPTS) continue;
      throw err;
    }
  }
  deliver(deps, result.nudges);
  return { ok: true, state: stateOf(result), nudges: result.nudges };
}

/** After COMMIT: hand each new nudge to the consumer without blocking the caller. */
function deliver(deps: RoundsDeps, nudges: Nudge[]): void {
  const onNudge = deps.onNudge;
  if (!onNudge) return;
  for (const n of nudges) {
    void Promise.resolve()
      .then(() => onNudge(n))
      .catch(() => {
        // The consumer retries from the nudges table / my_bids; never fail the round.
      });
  }
}

/** Why a conditional UPDATE touched 0 rows. */
async function refusal(tx: Queryable, input: Base, kind: 'start' | 'inRounds'): Promise<Refused> {
  const row = (
    await tx.query(
      `SELECT brand_id, status, quantity, rounds_started_at, current_round,
              rounds_end_at <= clock_timestamp() AS ended
         FROM listings WHERE id = $1`,
      [input.listingId],
    )
  ).rows[0] as
    | {
        brand_id: string;
        status: string;
        quantity: number;
        rounds_started_at: Date | null;
        current_round: number | null;
        ended: boolean | null;
      }
    | undefined;
  if (!row || row.brand_id !== input.brandId) return new Refused({ code: 'NOT_FOUND' });
  const conflict = (reason: RoundsConflictReason) =>
    new Refused({
      code: 'STATE_CONFLICT',
      reason,
      status: row.status,
      round: row.current_round,
    });
  if (kind === 'start') {
    if (row.rounds_started_at || row.status === 'ROUNDS') return conflict('ROUNDS_ALREADY_STARTED');
    if (row.status !== 'OPEN') return conflict('NOT_OPEN');
    return conflict('ROUNDS_WINDOW_PASSED');
  }
  if (row.status !== 'ROUNDS') return conflict('NOT_IN_ROUNDS');
  if (row.ended) return conflict('ROUNDS_ENDED');
  // In ROUNDS, not ended: the round moved past the one the caller advanced from.
  return conflict('ROUND_ADVANCED');
}

async function quantityOf(tx: Queryable, input: Base): Promise<number> {
  const row = (
    await tx.query(`SELECT brand_id, quantity FROM listings WHERE id = $1`, [input.listingId])
  ).rows[0] as { brand_id: string; quantity: number } | undefined;
  if (!row || row.brand_id !== input.brandId) throw new Refused({ code: 'NOT_FOUND' });
  return row.quantity;
}

function checkTarget(targetQuantity: number, quantity: number): void {
  if (!Number.isSafeInteger(targetQuantity) || targetQuantity < 1 || targetQuantity > quantity) {
    throw new Refused({
      code: 'VALIDATION_ERROR',
      message: `targetQuantity must be between 1 and ${quantity}`,
      maxQuantity: quantity,
    });
  }
}

const RETURNING = `RETURNING *, clock_timestamp() AS db_now`;

export async function brandAudit(
  tx: Queryable,
  listing: RoundsListing,
  actor: RoundsActor,
  action: string,
  data: Record<string, unknown>,
): Promise<void> {
  await audit(tx, {
    actorType: actor.type,
    actorId: actor.id,
    brandId: listing.brand_id,
    listingId: listing.id,
    entity: 'listing',
    entityId: listing.id,
    action,
    data,
  });
}

// --- Start -----------------------------------------------------------------------------------

export interface StartRoundsInput extends Base {
  targetQuantity: number;
}

/**
 * `POST /listings/:id/rounds/start` (D6, D7). OPEN → ROUNDS once, before or after
 * `window_closes_at`, and in the same transaction:
 * - `rounds_started_at = now()`, `current_round = 1`, `target_quantity = Q`;
 * - `window_closes_at = least(window_closes_at, now())` (no new bids from here on);
 * - `rounds_end_at = least(now() + 6h, original window_closes_at + 6h)`;
 * - `clear_deadline_at = least(rounds_end_at + 6h, window_opens_at + 60h)`;
 * - round 1's nudge snapshot (ends rounds at once if nobody is below the cutoff).
 * Refused (409 `ROUNDS_WINDOW_PASSED`) when the 6 h after the window closed are already over.
 */
export async function startRounds(
  deps: RoundsDeps,
  input: StartRoundsInput,
): Promise<RoundsOutcome> {
  const timing = deps.timing ?? UNSCALED_TIMING;
  const template = await templateBefore(deps, input, 'OPEN', 1);
  return run(deps, input, async (tx) => {
    checkTarget(input.targetQuantity, await quantityOf(tx, input));
    // SET expressions read the row's old values, so `window_closes_at` here is the original.
    // $4 / $5 are the (scaled) rounds cap and round length; `clear_deadline_at` is never scaled:
    // it is computed from the unscaled 6 h cap, exactly as in an unscaled run.
    const res = await tx.query(
      `UPDATE listings
          SET status = 'ROUNDS',
              rounds_started_at = now(),
              current_round = 1,
              round_extensions = 0,
              target_quantity = $3,
              window_closes_at = least(window_closes_at, now()),
              rounds_end_at = least(now() + $4::float8 * interval '1 millisecond',
                                    window_closes_at + interval '6 hours'),
              round_ends_at = least(now() + $5::float8 * interval '1 millisecond',
                                    now() + $4::float8 * interval '1 millisecond',
                                    window_closes_at + interval '6 hours'),
              clear_deadline_at = least(
                least(now() + interval '6 hours', window_closes_at + interval '6 hours')
                  + interval '6 hours',
                window_opens_at + interval '60 hours'),
              updated_at = now()
        WHERE id = $1 AND brand_id = $2 AND status = 'OPEN' AND rounds_started_at IS NULL
          AND window_closes_at IS NOT NULL AND window_opens_at IS NOT NULL
          AND now() < window_closes_at + interval '6 hours'
       ${RETURNING}`,
      [input.listingId, input.brandId, input.targetQuantity, timing.capMs, timing.roundMs],
    );
    const listing = res.rows[0] as RoundsListing | undefined;
    if (!listing) throw await refusal(tx, input, 'start');
    await deps.afterListingUpdate?.(tx);

    const at = listing.db_now.toISOString();
    await brandAudit(tx, listing, input.actor, 'ROUNDS_STARTED', {
      targetQuantity: listing.target_quantity,
      windowClosesAt: iso(listing.window_closes_at),
      roundsEndAt: iso(listing.rounds_end_at),
      clearDeadlineAt: iso(listing.clear_deadline_at),
    });
    await (deps.emit ?? emit)(tx, listing.id, {
      type: 'listing.status',
      listingId: listing.id,
      at,
      from: 'OPEN',
      to: 'ROUNDS',
    });
    return snapshotRound(deps, tx, listing, input.actor, template);
  });
}

// --- Next round ------------------------------------------------------------------------------

export interface NextRoundInput extends Base {
  /** The round the caller saw; defaults to the listing's current round. */
  fromRound?: number;
}

/**
 * `POST /listings/:id/rounds/next` ("Next round", basic mode). Advances with
 * `UPDATE … SET current_round = n + 1 WHERE status = 'ROUNDS' AND current_round = n AND
 * now() < rounds_end_at`: of two concurrent calls for round n, exactly one advances; the other
 * touches 0 rows (409 `ROUND_ADVANCED`). Then writes round n + 1's nudge snapshot.
 */
export async function nextRound(deps: RoundsDeps, input: NextRoundInput): Promise<RoundsOutcome> {
  const timing = deps.timing ?? UNSCALED_TIMING;
  const template = await templateBefore(
    deps,
    input,
    'ROUNDS',
    input.fromRound === undefined ? null : input.fromRound + 1,
  );
  return run(deps, input, async (tx) => {
    let from = input.fromRound;
    if (from === undefined) {
      const row = (
        await tx.query(`SELECT brand_id, current_round FROM listings WHERE id = $1`, [
          input.listingId,
        ])
      ).rows[0] as { brand_id: string; current_round: number | null } | undefined;
      if (!row || row.brand_id !== input.brandId) throw new Refused({ code: 'NOT_FOUND' });
      if (row.current_round === null) throw await refusal(tx, input, 'inRounds');
      from = row.current_round;
    }
    const listing = await advanceRound(tx, input.listingId, input.brandId, from, timing.roundMs);
    if (!listing) throw await refusal(tx, input, 'inRounds');
    await deps.afterListingUpdate?.(tx);
    await brandAudit(tx, listing, input.actor, 'ROUND_ADVANCED', {
      fromRound: from,
      round: listing.current_round,
      roundEndsAt: iso(listing.round_ends_at),
    });
    return snapshotRound(deps, tx, listing, input.actor, template);
  });
}

/**
 * The one way a round advances (HF-036a button, HF-036b timer): the conditional UPDATE from
 * round `n` to `n + 1`, which also starts the new round's timer
 * (`round_ends_at = least(now() + roundMs, rounds_end_at)`). Returns null when the listing is not
 * in live rounds at round `n`.
 */
export async function advanceRound(
  tx: Queryable,
  listingId: string,
  brandId: string,
  n: number,
  roundMs: number = UNSCALED_TIMING.roundMs,
): Promise<RoundsListing | null> {
  const res = await tx.query(
    `UPDATE listings
        SET current_round = $3 + 1, round_extensions = 0, updated_at = now(),
            round_ends_at = least(clock_timestamp() + $4::float8 * interval '1 millisecond',
                                  rounds_end_at)
      WHERE id = $1 AND brand_id = $2 AND status = 'ROUNDS' AND current_round = $3
        AND clock_timestamp() < rounds_end_at
     ${RETURNING}`,
    [listingId, brandId, n, roundMs],
  );
  return (res.rows[0] as RoundsListing | undefined) ?? null;
}

// --- Stop / end ------------------------------------------------------------------------------

/**
 * `POST /listings/:id/rounds/stop`: `rounds_end_at = now()`,
 * `clear_deadline_at = least(clear_deadline_at, now() + 6h)`. The book is frozen from here
 * (`isRaisable` false, D7); the brand has until `clear_deadline_at` to Clear.
 */
export function stopRounds(deps: RoundsDeps, input: Base): Promise<RoundsOutcome> {
  return run(deps, input, async (tx) => {
    const listing = await endRounds(deps, tx, input.listingId, input.brandId, 'BRAND_STOPPED');
    if (!listing) throw await refusal(tx, input, 'inRounds');
    await deps.afterListingUpdate?.(tx);
    await brandAudit(tx, listing, input.actor, 'ROUNDS_STOPPED', {
      round: listing.current_round,
      roundsEndAt: iso(listing.rounds_end_at),
      clearDeadlineAt: iso(listing.clear_deadline_at),
    });
    return { listing, nudges: [], endedReason: 'BRAND_STOPPED' };
  });
}

/** End live rounds now (stop, an end rule, nobody below the cutoff) and emit `round.ended`. */
export async function endRounds(
  deps: RoundsDeps,
  tx: Queryable,
  listingId: string,
  brandId: string,
  reason: RoundEndReason,
): Promise<RoundsListing | null> {
  const res = await tx.query(
    `UPDATE listings
        SET rounds_end_at = clock_timestamp(),
            clear_deadline_at = least(clear_deadline_at, clock_timestamp() + interval '6 hours'),
            updated_at = now()
      WHERE id = $1 AND brand_id = $2 AND status = 'ROUNDS'
        AND clock_timestamp() < rounds_end_at
     ${RETURNING}`,
    [listingId, brandId],
  );
  const listing = res.rows[0] as RoundsListing | undefined;
  if (!listing) return null;
  await (deps.emit ?? emit)(tx, listingId, {
    type: 'round.ended',
    listingId,
    at: listing.db_now.toISOString(),
    round: listing.current_round ?? 0,
    reason,
    roundsEndAt: listing.rounds_end_at!.toISOString(),
    clearDeadlineAt: iso(listing.clear_deadline_at),
  });
  return listing;
}

// --- Target quantity -------------------------------------------------------------------------

export interface SetRoundsTargetInput extends Base {
  targetQuantity: number;
}

/** `PATCH /listings/:id/rounds {targetQuantity}`: `1 ≤ Q ≤ quantity`; the next round uses it. */
export function setRoundsTarget(
  deps: RoundsDeps,
  input: SetRoundsTargetInput,
): Promise<RoundsOutcome> {
  return run(deps, input, async (tx) => {
    checkTarget(input.targetQuantity, await quantityOf(tx, input));
    const res = await tx.query(
      `UPDATE listings SET target_quantity = $3, updated_at = now()
        WHERE id = $1 AND brand_id = $2 AND status = 'ROUNDS'
          AND clock_timestamp() < rounds_end_at
       ${RETURNING}`,
      [input.listingId, input.brandId, input.targetQuantity],
    );
    const listing = res.rows[0] as RoundsListing | undefined;
    if (!listing) throw await refusal(tx, input, 'inRounds');
    await brandAudit(tx, listing, input.actor, 'ROUNDS_TARGET_CHANGED', {
      round: listing.current_round,
      targetQuantity: listing.target_quantity,
    });
    return { listing, nudges: [], endedReason: null };
  });
}

// --- Phrasing (HF-036b) -----------------------------------------------------------------------

/** What the phraser may see: product title and brand name. Never a number, never the floor. */
export async function phrasingFacts(
  q: Queryable,
  listingId: string,
): Promise<{ productTitle: string | null; brandName: string | null } | null> {
  const row = (
    await q.query(
      `SELECT p.title, b.name FROM listings l
         JOIN products p ON p.id = l.product_id JOIN brands b ON b.id = l.brand_id
        WHERE l.id = $1`,
      [listingId],
    )
  ).rows[0] as { title: string | null; name: string | null } | undefined;
  return row ? { productTitle: row.title, brandName: row.name } : null;
}

/**
 * The round's Claude template for the brand's start / "Next round" call, fetched **before** the
 * transaction (never hold row locks across a model call) and only when the call can succeed.
 */
async function templateBefore(
  deps: RoundsDeps,
  input: Base,
  status: 'OPEN' | 'ROUNDS',
  round: number | null,
): Promise<string | null> {
  if (!deps.phraser || !canRunRounds(input.actor)) return null;
  const row = (
    await deps.db.pool.query(
      `SELECT current_round FROM listings
        WHERE id = $1 AND brand_id = $2 AND status = $3
          AND (rounds_end_at IS NULL OR clock_timestamp() < rounds_end_at)`,
      [input.listingId, input.brandId, status],
    )
  ).rows[0] as { current_round: number | null } | undefined;
  if (!row) return null;
  const facts = await phrasingFacts(deps.db.pool, input.listingId);
  if (!facts) return null;
  return roundTemplate(
    deps.phraser,
    { listingId: input.listingId, round: round ?? (row.current_round ?? 0) + 1, ...facts },
    { timeoutMs: deps.phrasingTimeoutMs, onError: deps.onPhrasingError },
  );
}

// --- Snapshot (M10) --------------------------------------------------------------------------

/**
 * One round's nudge snapshot, computed once from the shared eligible book (D8) and
 * `clear(bids, Q, floor)`: every bid not in `winners` gets one nudge (once per listing, round and
 * shopper). If nobody is below the cutoff, rounds end at once (`NONE_BELOW_CUTOFF`).
 */
export async function snapshotRound(
  deps: RoundsDeps,
  tx: Tx,
  listing: RoundsListing,
  actor: RoundsActor,
  /** HF-036b: this round's Claude template; null → HF-036a template text. */
  template: string | null = null,
): Promise<TxResult> {
  const round = listing.current_round!;
  const q = listing.target_quantity!;
  const book = await loadClearInput(tx, listing.id);
  if (!book) throw new Refused({ code: 'NOT_FOUND' });
  const result = clear(book.bids, q, book.floorCents);
  const roundEndsAt = iso(listing.round_ends_at);
  const drafts = selectNudges(result, { targetQuantity: q, roundEndsAt });

  await (deps.emit ?? emit)(tx, listing.id, {
    type: 'round.started',
    listingId: listing.id,
    at: listing.db_now.toISOString(),
    round,
    targetQuantity: q,
    cutoffCents: result.cutoffCents,
    roundEndsAt,
    roundsEndAt: listing.rounds_end_at!.toISOString(),
  });

  const nudges: Nudge[] = [];
  for (const draft of drafts) {
    const nudge = await sendNudge(tx, {
      listingId: listing.id,
      round,
      draft,
      text: nudgeTextFor(template, draft),
      triggeredBy: actor.id,
      emit: deps.emit,
    });
    if (nudge) nudges.push(nudge);
  }

  if (drafts.length > 0) return { listing, nudges, endedReason: null };
  const ended = await endRounds(deps, tx, listing.id, listing.brand_id, 'NONE_BELOW_CUTOFF');
  if (ended) {
    await brandAudit(tx, ended, actor, 'ROUNDS_ENDED', {
      round,
      reason: 'NONE_BELOW_CUTOFF',
      cutoffCents: result.cutoffCents,
      winners: result.winners.length,
      roundsEndAt: iso(ended.rounds_end_at),
      clearDeadlineAt: iso(ended.clear_deadline_at),
    });
  }
  return { listing: ended ?? listing, nudges, endedReason: 'NONE_BELOW_CUTOFF' };
}
