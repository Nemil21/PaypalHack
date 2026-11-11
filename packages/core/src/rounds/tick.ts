import type { Nudge, RoundEndReason } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Queryable, Tx } from '../db.js';
import { emit } from '../money/emit.js';
import { roundTemplate } from './phrasing.js';
import {
  advanceRound,
  brandAudit,
  endRounds,
  phrasingFacts,
  snapshotRound,
  type RoundsActor,
  type RoundsDeps,
  type RoundsListing,
} from './rounds.js';
import {
  decideTick,
  inSoftClose,
  ROUNDS_TICK_MS,
  UNSCALED_TIMING,
  type TickDecision,
} from './timing.js';

/**
 * Live rounds timer (HF-036b; features/19 §Logic 2, 6, 7). An in-process tick every 5 s (not
 * Render cron) walks the listings in live rounds. Each listing step is one transaction under
 * `pg_try_advisory_xact_lock('rounds:<listing>')`, so with several instances ticking only one
 * works a listing at a time and the others skip it. Inside the step:
 *
 * 1. Soft close: every `bid.raised` that landed in the last 5 min of the round extends it by
 *    10 min, never past `rounds_end_at` (conditional UPDATE on the round end it read; SSE
 *    `round.extended`). Each raise extends at most once (audit `ROUND_EXTENDED` keyed by bid).
 * 2. End rules (SSE `round.ended`): the rounds cap passed (`CAP_REACHED`); the round sent ≥ 1
 *    nudge and saw no raise (`NO_RAISES`, `rounds_end_at = now()`,
 *    `clear_deadline_at = least(clear_deadline_at, now() + 6h)`). Nobody below the cutoff ends in
 *    the new round's snapshot; brand stop is `stopRounds`.
 * 3. Otherwise, once `now() ≥ round_ends_at`, advance through HF-036a's conditional
 *    `advanceRound` (`WHERE current_round = n`) and write the new round's nudge snapshot once
 *    (M10), phrased by one Claude call (template text on error or after 5 s).
 *
 * A listing that leaves ROUNDS (Clear, cancel, expiry) or whose rounds ended drops out of the
 * scan, so the tick stops for it.
 *
 * Raise time: `greatest(placed_at, authorized_at)` of the new bid whose replaced bid was voided
 * `REPLACED` in the `landHold` swap, i.e. exactly the raises that emitted `bid.raised`.
 */

export const TICK_ACTOR: RoundsActor = { type: 'SYSTEM', id: 'rounds-tick' };

/** Audit actions that mark live rounds as ended (no further ticks). */
const ENDED_ACTIONS = ['ROUNDS_ENDED', 'ROUNDS_STOPPED'];

export type StepResult =
  /** Another instance holds this listing's tick lock. */
  | { kind: 'LOCKED' }
  /** Not in live rounds, or they already ended. */
  | { kind: 'IDLE' }
  | { kind: 'WAIT'; round: number; extended: number }
  | {
      kind: 'ADVANCED';
      round: number;
      extended: number;
      nudges: Nudge[];
      endedReason: RoundEndReason | null;
    }
  | { kind: 'ENDED'; round: number; extended: number; reason: RoundEndReason };

interface Raise {
  bidId: string;
  at: Date;
}

interface Evaluation {
  listing: RoundsListing;
  round: number;
  roundEndsAt: Date;
  /** Raises in this round, oldest first. */
  raises: Raise[];
  /** Raises in the soft-close window not yet applied, oldest first. */
  toExtend: Raise[];
  decision: TickDecision;
}

async function readListing(
  q: Queryable,
  listingId: string,
  forUpdate: boolean,
): Promise<RoundsListing | null> {
  const res = await q.query(
    `SELECT *, clock_timestamp() AS db_now FROM listings WHERE id = $1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [listingId],
  );
  return (res.rows[0] as RoundsListing | undefined) ?? null;
}

async function endAnnounced(q: Queryable, l: RoundsListing): Promise<boolean> {
  const res = await q.query(
    `SELECT 1 FROM audit_events
      WHERE listing_id = $1 AND action = ANY($2::text[]) AND at >= $3 LIMIT 1`,
    [l.id, ENDED_ACTIONS, l.rounds_started_at],
  );
  return res.rows.length > 0;
}

/** When the current round started: the latest start / advance audit. */
async function roundStartedAt(q: Queryable, l: RoundsListing): Promise<Date> {
  const res = await q.query(
    `SELECT coalesce((data->>'roundStartedAt')::timestamptz, at) AS started
       FROM audit_events
      WHERE listing_id = $1 AND action IN ('ROUNDS_STARTED', 'ROUND_ADVANCED') AND at >= $2
      ORDER BY id DESC LIMIT 1`,
    [l.id, l.rounds_started_at],
  );
  return (res.rows[0] as { started: Date } | undefined)?.started ?? l.rounds_started_at!;
}

async function raisesSince(q: Queryable, listingId: string, since: Date): Promise<Raise[]> {
  const res = await q.query(
    `SELECT bid_id AS "bidId", at FROM (
       SELECT n.id AS bid_id, n.seq,
              greatest(n.placed_at, coalesce(n.authorized_at, n.placed_at)) AS at
         FROM bids n JOIN bids o ON o.id = n.replaces_bid_id
        WHERE n.listing_id = $1 AND o.listing_id = $1 AND o.void_reason = 'REPLACED'
     ) r
     WHERE at >= $2 ORDER BY at, seq`,
    [listingId, since],
  );
  return res.rows as Raise[];
}

async function extendedBids(q: Queryable, listingId: string): Promise<Set<string>> {
  const res = await q.query(
    `SELECT entity_id::text AS id FROM audit_events
      WHERE listing_id = $1 AND action = 'ROUND_EXTENDED'`,
    [listingId],
  );
  return new Set((res.rows as { id: string }[]).map((r) => r.id));
}

async function nudgeCount(q: Queryable, listingId: string, round: number): Promise<number> {
  const res = await q.query(
    `SELECT count(*)::int AS n FROM nudges WHERE listing_id = $1 AND round = $2`,
    [listingId, round],
  );
  return (res.rows[0] as { n: number }).n;
}

/** Read-only: what this tick would do to a listing in live rounds (null: nothing to do). */
async function evaluate(
  deps: RoundsDeps,
  q: Queryable,
  l: RoundsListing,
): Promise<Evaluation | null> {
  if (l.status !== 'ROUNDS' || l.current_round === null || !l.rounds_end_at) return null;
  if (await endAnnounced(q, l)) return null;
  const timing = deps.timing ?? UNSCALED_TIMING;
  const round = l.current_round;
  const now = l.db_now.getTime();
  // Rounds started before the timer existed: the round ends a round-length after it started.
  const started = await roundStartedAt(q, l);
  const roundEndsAt =
    l.round_ends_at ??
    new Date(Math.min(started.getTime() + timing.roundMs, l.rounds_end_at.getTime()));
  const raises = await raisesSince(q, l.id, started);
  const done = await extendedBids(q, l.id);
  const toExtend = raises.filter(
    (r) => !done.has(r.bidId) && inSoftClose(r.at.getTime(), roundEndsAt.getTime(), timing),
  );
  // Each soft-close raise judged against the end before this tick extends it once.
  const extendedEnd = Math.min(
    roundEndsAt.getTime() + toExtend.length * timing.extensionMs,
    Math.max(roundEndsAt.getTime(), l.rounds_end_at.getTime()),
  );
  const decision = decideTick({
    now,
    roundEndsAt: extendedEnd,
    roundsEndAt: l.rounds_end_at.getTime(),
    nudgesThisRound: await nudgeCount(q, l.id, round),
    raisesThisRound: raises.length,
  });
  return { listing: l, round, roundEndsAt, raises, toExtend, decision };
}

/**
 * One tick for one listing. Safe to call from any number of instances at once: the advisory lock
 * makes the others skip, and every write is a conditional UPDATE.
 */
export async function stepListing(deps: RoundsDeps, listingId: string): Promise<StepResult> {
  const timing = deps.timing ?? UNSCALED_TIMING;
  const emitFn = deps.emit ?? emit;
  let result: StepResult = { kind: 'IDLE' };
  let nudges: Nudge[] = [];

  await deps.db.tx(async (tx: Tx) => {
    const lock = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok`, [
      `rounds:${listingId}`,
    ]);
    if (!(lock.rows[0] as { ok: boolean }).ok) {
      result = { kind: 'LOCKED' };
      return;
    }

    // Phase 1, no row lock: if the round will advance, ask Claude for its template now (≤ 5 s),
    // holding only the advisory lock, so raises keep landing and other instances skip.
    const peek = await readListing(tx, listingId, false);
    const first = peek ? await evaluate(deps, tx, peek) : null;
    if (!first) return;
    let template: string | null = null;
    if (first.decision.kind === 'ADVANCE' && deps.phraser) {
      const facts = await phrasingFacts(tx, listingId);
      if (facts) {
        template = await roundTemplate(
          deps.phraser,
          { listingId, round: first.round + 1, ...facts },
          { timeoutMs: deps.phrasingTimeoutMs, onError: deps.onPhrasingError },
        );
      }
    }

    // Phase 2: lock the listing (lock order listing → bids) and act on fresh state.
    const locked = await readListing(tx, listingId, true);
    const ev = locked ? await evaluate(deps, tx, locked) : null;
    if (!ev) return;
    const { round } = ev;
    let listing = ev.listing;
    if (!listing.round_ends_at) {
      await tx.query(`UPDATE listings SET round_ends_at = $2, updated_at = now() WHERE id = $1`, [
        listingId,
        ev.roundEndsAt,
      ]);
    }

    // 1. Soft close.
    // Conditional on the round and the extension count read under the row lock (timestamps are
    // µs in Postgres, ms in JS, so they make a poor compare-and-set key).
    let extensions = listing.round_extensions as number;
    let extended = 0;
    for (const raise of ev.toExtend) {
      const previousEnd = listing.round_ends_at ?? ev.roundEndsAt;
      const res = await tx.query(
        `UPDATE listings
            SET round_ends_at = least(round_ends_at + $4::float8 * interval '1 millisecond',
                                      rounds_end_at),
                round_extensions = round_extensions + 1, updated_at = now()
          WHERE id = $1 AND status = 'ROUNDS' AND current_round = $2 AND round_extensions = $3
            AND round_ends_at < rounds_end_at
         RETURNING *, clock_timestamp() AS db_now`,
        [listingId, round, extensions, timing.extensionMs],
      );
      const row = res.rows[0] as RoundsListing | undefined;
      if (!row) break; // at the cap
      listing = row;
      extensions = row.round_extensions as number;
      extended++;
      // Keyed by the raise's bid: each raise extends at most once.
      await audit(tx, {
        actorType: TICK_ACTOR.type,
        actorId: TICK_ACTOR.id,
        brandId: row.brand_id,
        listingId,
        entity: 'bid',
        entityId: raise.bidId,
        action: 'ROUND_EXTENDED',
        data: {
          round,
          raisedAt: raise.at.toISOString(),
          previousRoundEndsAt: previousEnd.toISOString(),
          roundEndsAt: row.round_ends_at!.toISOString(),
          roundsEndAt: row.rounds_end_at!.toISOString(),
          extensions: row.round_extensions,
        },
      });
      await emitFn(tx, listingId, {
        type: 'round.extended',
        listingId,
        at: row.db_now.toISOString(),
        round,
        roundEndsAt: row.round_ends_at!.toISOString(),
        roundsEndAt: row.rounds_end_at!.toISOString(),
      });
    }

    // 2–3. End rules, or advance.
    const decision = ev.decision;
    if (decision.kind === 'WAIT') {
      result = { kind: 'WAIT', round, extended };
      return;
    }
    if (decision.kind === 'END') {
      await endBy(deps, tx, listing, decision.reason);
      result = { kind: 'ENDED', round, extended, reason: decision.reason };
      return;
    }
    const advanced = await advanceRound(tx, listingId, listing.brand_id, round, timing.roundMs);
    if (!advanced) return; // "Next round" or stop won the race
    await brandAudit(tx, advanced, TICK_ACTOR, 'ROUND_ADVANCED', {
      fromRound: round,
      round: advanced.current_round,
      roundStartedAt: advanced.db_now.toISOString(),
      roundEndsAt: advanced.round_ends_at?.toISOString() ?? null,
    });
    const snap = await snapshotRound(deps, tx, advanced, TICK_ACTOR, template);
    nudges = snap.nudges;
    result = {
      kind: 'ADVANCED',
      round: advanced.current_round!,
      extended,
      nudges: snap.nudges,
      endedReason: snap.endedReason,
    };
  });

  deliver(deps, nudges);
  return result;
}

async function endBy(
  deps: RoundsDeps,
  tx: Tx,
  listing: RoundsListing,
  reason: 'CAP_REACHED' | 'NO_RAISES',
): Promise<void> {
  let ended: RoundsListing | null = listing;
  if (reason === 'NO_RAISES') {
    ended = await endRounds(deps, tx, listing.id, listing.brand_id, reason);
  } else {
    // The cap already passed: rounds_end_at stays the cap; just announce it.
    await (deps.emit ?? emit)(tx, listing.id, {
      type: 'round.ended',
      listingId: listing.id,
      at: listing.db_now.toISOString(),
      round: listing.current_round ?? 0,
      reason,
      roundsEndAt: listing.rounds_end_at!.toISOString(),
      clearDeadlineAt: listing.clear_deadline_at?.toISOString() ?? null,
    });
  }
  if (!ended) return;
  await brandAudit(tx, ended, TICK_ACTOR, 'ROUNDS_ENDED', {
    round: ended.current_round,
    reason,
    roundsEndAt: ended.rounds_end_at?.toISOString() ?? null,
    clearDeadlineAt: ended.clear_deadline_at?.toISOString() ?? null,
  });
}

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

/** Listings the tick still has work for: in ROUNDS and not yet ended. */
export async function roundsListingIds(q: Queryable): Promise<string[]> {
  const res = await q.query(
    `SELECT l.id FROM listings l
      WHERE l.status = 'ROUNDS'
        AND NOT EXISTS (SELECT 1 FROM audit_events a
                         WHERE a.listing_id = l.id AND a.action = ANY($1::text[])
                           AND a.at >= l.rounds_started_at)
      ORDER BY l.id`,
    [ENDED_ACTIONS],
  );
  return (res.rows as { id: string }[]).map((r) => r.id);
}

/** One pass over every listing in live rounds. */
export async function tickRounds(
  deps: RoundsDeps,
  opts: { onError?: (err: unknown, listingId: string) => void } = {},
): Promise<Map<string, StepResult>> {
  const out = new Map<string, StepResult>();
  for (const id of await roundsListingIds(deps.db.pool)) {
    try {
      out.set(id, await stepListing(deps, id));
    } catch (err) {
      opts.onError?.(err, id);
    }
  }
  return out;
}

/** `bid.raised` for a listing → run its step now instead of waiting for the next tick. */
export type RaiseSubscribe = (listingId: string, onRaised: () => void) => () => void;

export interface RoundsTicker {
  stop(): void;
  /** Run one pass now (tests, and the first pass on boot). */
  runOnce(): Promise<void>;
}

/**
 * The in-process rounds runner: `tickRounds` every 5 s, plus an immediate step when a listing in
 * rounds emits `bid.raised` (so `round.extended` goes out at once). It subscribes only to listings
 * in live rounds and unsubscribes when a listing leaves them.
 */
export function startRoundsTicker(
  deps: RoundsDeps,
  opts: {
    intervalMs?: number;
    subscribe?: RaiseSubscribe;
    onError?: (err: unknown, listingId?: string) => void;
  } = {},
): RoundsTicker {
  const subs = new Map<string, () => void>();
  const busy = new Set<string>();
  let running = false;
  let stopped = false;

  const step = async (id: string) => {
    if (busy.has(id) || stopped) return;
    busy.add(id);
    try {
      await stepListing(deps, id);
    } catch (err) {
      opts.onError?.(err, id);
    } finally {
      busy.delete(id);
    }
  };

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const ids = await roundsListingIds(deps.db.pool);
      const live = new Set(ids);
      for (const [id, unsubscribe] of subs) {
        if (!live.has(id)) {
          unsubscribe();
          subs.delete(id);
        }
      }
      if (opts.subscribe) {
        for (const id of ids) {
          if (!subs.has(id))
            subs.set(
              id,
              opts.subscribe(id, () => void step(id)),
            );
        }
      }
      for (const id of ids) await step(id);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), opts.intervalMs ?? ROUNDS_TICK_MS);
  timer.unref?.();
  return {
    runOnce,
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const unsubscribe of subs.values()) unsubscribe();
      subs.clear();
    },
  };
}
