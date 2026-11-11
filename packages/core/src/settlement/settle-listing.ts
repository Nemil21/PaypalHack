import { audit } from '../audit.js';
import type { Queryable } from '../db.js';
import type { Actor } from '../money/deps.js';
import { emit } from '../money/emit.js';
import { claim, release, renew, type Lease } from '../money/lease.js';
import { SQL_NOW, transition } from '../money/transition.js';
import type { KickSettlement } from './outbox.js';
import { settleBid, voidFailedCapture, type SettleBidDeps } from './settle-bid.js';

/**
 * `settleListing(listingId)` (HF-030a; features/11 §Workflow design, D9): the coordinator that
 * runs every settlement of one cleared listing, in an order that keeps reserve holds alive for
 * promotion, then settles and pays out once.
 *
 * - One owner per listing: the coordinator claims the listing's `settlement_runs` row (the outbox
 *   row Clear wrote) under a renewed lease. A second kick while it runs is a no-op (`BUSY`); a
 *   crashed coordinator's lease expires and the outbox kicker (`kickSettlementOutbox`, HF-034)
 *   starts another, which takes over its RUNNING settlement rows (same PayPal request ids, so no
 *   double charge).
 * - Phase 1: CAPTURE rows for winners plus VOID rows for below-floor losers, at most 10 PayPal
 *   calls in flight (PayPal rate limits; one coordinator per listing caps the whole listing).
 *   Promotions happen inline in `settleBid`'s failure transaction (`promoteWithin`, HF-031) and
 *   insert new CAPTURE rows, so this phase loops until no CAPTURE row is QUEUED/RUNNING/RETRY.
 * - Phase 2: the reserve VOID rows (`is_reserve`), only once no CAPTURE is open.
 * - Phase 3: done = every row terminal (SUCCEEDED, CANCELLED, FAILED+TERMINAL), every WON bid has
 *   a SUCCEEDED capture, and every CAPTURE_FAILED bid has a promotion outcome. Then a conditional
 *   `CLEARING → SETTLED`; only the winner of that transition calls `payoutBrand` (HF-032).
 *   First, any failed winner whose void a crashed task never finished is voided here.
 *
 * Phases 1 and 2 are one loop that re-checks "is any CAPTURE open?" on every pass, so a CAPTURE
 * that reappears later (an HF-033 webhook) puts reserve VOIDs on hold again.
 *
 * The code is runner-agnostic: the Render Workflows adapter (HF-030b) reuses `dueSettlements`,
 * `settlementBlockers` and `settleIfDone` with its own fan-out.
 */

/** PayPal calls in flight per listing (features/11: concurrency ≤ 10). */
export const SETTLEMENT_CONCURRENCY = 10;
/** One coordinator keeps a run at most this long, then hands it back to the outbox kicker. */
export const DEFAULT_MAX_RUN_MS = 5 * 60_000;
/** Idle wait while open rows are not due yet (RETRY backoff, another worker's live lease). */
export const DEFAULT_SETTLEMENT_POLL_MS = 1_000;

/**
 * Audit actions that record what happened to a failed winner's unit (HF-031's `promoteWithin`;
 * `PROMOTION_SKIPPED` is the pre-HF-031 placeholder's, kept for rows it wrote). The outcome row must name the failed bid as `entity_id` or as
 * `data.fromBidId` / `data.failedBidId`; phase 3 waits for it.
 */
export const PROMOTION_OUTCOME_ACTIONS = [
  'PROMOTED',
  'UNFILLED_UNIT',
  'PROMOTION_SKIPPED',
] as const;

/**
 * HF-032 `payoutBrand(listingId)`. Called only after this coordinator moved the listing
 * CLEARING → SETTLED, and again only when a coordinator crashed between that commit and marking
 * the run DONE (HF-032: re-running it never creates a second batch).
 */
export type PayoutBrand = (listingId: string) => Promise<unknown>;

/** Placeholder until HF-032 lands: records that no payout was attempted. */
export const payoutBrandPlaceholder =
  (db: Pick<SettleBidDeps['db'], 'pool'>): PayoutBrand =>
  async (listingId) => {
    await audit(db.pool, {
      actorType: 'WORKFLOW',
      listingId,
      entity: 'listing',
      entityId: listingId,
      action: 'PAYOUT_SKIPPED',
      data: { reason: 'PLACEHOLDER' },
    });
  };

export interface SettleListingDeps extends SettleBidDeps {
  /** HF-032; defaults to the placeholder (audit only). */
  payoutBrand?: PayoutBrand;
  /** Default 10. */
  concurrency?: number;
  /**
   * Runs one settlement row. Default: `settleBid(deps, id)` in this process. The Render Workflows
   * adapter (HF-030b) passes `id => ctx.run(settleBidTask, id)` so each row is its own child task
   * run; the phases, leases and the conditional `CLEARING → SETTLED` stay here.
   */
  runSettlement?: (settlementId: string) => Promise<unknown>;
  /** Lease on the `settlement_runs` row; renewed every third of it. Default 60 s. */
  runLeaseSeconds?: number;
  maxRunMs?: number;
  pollMs?: number;
  /**
   * Stop as if the process died: no more tasks start and nothing is released, so the run and any
   * in-flight rows stay RUNNING until their leases expire (tests, graceful shutdown).
   */
  signal?: AbortSignal;
}

export type SettleListingResult =
  /** No `settlement_runs` row: the listing was never cleared. */
  | { outcome: 'NO_RUN' }
  /** Another coordinator holds a live lease on the run, or the run is DONE. */
  | { outcome: 'BUSY' | 'ALREADY_DONE' }
  | { outcome: 'SETTLED'; tasks: number; payout: 'CALLED' | 'FAILED' }
  /** Listing already past CLEARING (a crash after SETTLED): payout re-ensured, run closed. */
  | { outcome: 'FINISHED'; tasks: number; payout: 'CALLED' | 'FAILED' | 'NOT_NEEDED' }
  /**
   * Not done yet; the run went back to PENDING for the kicker. `TIMEOUT`: rows still open after
   * `maxRunMs`. `BLOCKED`: nothing open, but a row needs a human (e.g. FAILED RECONCILE).
   */
  | { outcome: 'YIELDED'; reason: 'TIMEOUT' | 'BLOCKED'; tasks: number; blockers: Blockers }
  | { outcome: 'LEASE_LOST' | 'ABORTED'; tasks: number };

export interface Blockers {
  /** Settlement rows QUEUED / RUNNING / RETRY. */
  open: number;
  /** CAPTURE rows open (reserve VOIDs wait for 0). */
  openCaptures: number;
  /** FAILED rows whose class is not TERMINAL (RECONCILE: a human must look). */
  failedNonTerminal: number;
  /** WON / CAPTURED bids without a SUCCEEDED capture. */
  winnersWithoutCapture: number;
  /** CAPTURE_FAILED bids with no promotion outcome recorded. */
  failuresWithoutOutcome: number;
}

interface RunRow {
  id: string;
  listing_id: string;
  status: string;
  attempts: number;
}
type RunLease = Lease<RunRow> & { table: 'settlement_runs' };

const WORKFLOW: Actor = { type: 'WORKFLOW' };
const OPEN = `('QUEUED', 'RUNNING', 'RETRY')`;

export function isDone(b: Blockers): boolean {
  return (
    b.open === 0 &&
    b.failedNonTerminal === 0 &&
    b.winnersWithoutCapture === 0 &&
    b.failuresWithoutOutcome === 0
  );
}

/** Phase 3's checks, as counts. */
export async function settlementBlockers(q: Queryable, listingId: string): Promise<Blockers> {
  const res = await q.query(
    `SELECT
       (SELECT count(*) FROM settlements
         WHERE listing_id = $1 AND status IN ${OPEN})::int AS open,
       (SELECT count(*) FROM settlements
         WHERE listing_id = $1 AND action = 'CAPTURE' AND status IN ${OPEN})::int AS open_captures,
       (SELECT count(*) FROM settlements
         WHERE listing_id = $1 AND status = 'FAILED'
           AND error_class IS DISTINCT FROM 'TERMINAL')::int AS failed_non_terminal,
       (SELECT count(*) FROM bids b
         WHERE b.listing_id = $1 AND b.status IN ('WON', 'CAPTURED')
           AND NOT EXISTS (SELECT 1 FROM settlements s
                            WHERE s.bid_id = b.id AND s.action = 'CAPTURE'
                              AND s.status = 'SUCCEEDED'))::int AS winners_without_capture,
       (SELECT count(*) FROM bids b
         WHERE b.listing_id = $1
           AND (b.status = 'CAPTURE_FAILED' OR b.void_reason = 'CAPTURE_FAILED')
           AND NOT EXISTS (SELECT 1 FROM audit_events a
                            WHERE a.listing_id = $1 AND a.action = ANY($2::text[])
                              AND (a.entity_id = b.id
                                   OR a.data->>'fromBidId' = b.id::text
                                   OR a.data->>'failedBidId' = b.id::text)))::int
         AS failures_without_outcome`,
    [listingId, PROMOTION_OUTCOME_ACTIONS],
  );
  const r = res.rows[0] as Record<string, number>;
  return {
    open: r.open ?? 0,
    openCaptures: r.open_captures ?? 0,
    failedNonTerminal: r.failed_non_terminal ?? 0,
    winnersWithoutCapture: r.winners_without_capture ?? 0,
    failuresWithoutOutcome: r.failures_without_outcome ?? 0,
  };
}

/**
 * Settlement rows ready to run now: QUEUED, RETRY whose backoff passed, and RUNNING whose lease
 * expired (a crashed worker's row). While any CAPTURE is open, reserve VOIDs are held back.
 * CAPTUREs first.
 */
export async function dueSettlements(
  q: Queryable,
  listingId: string,
): Promise<{ ids: string[]; openCaptures: number }> {
  const res = await q.query(
    `WITH c AS (SELECT count(*)::int AS n FROM settlements
                 WHERE listing_id = $1 AND action = 'CAPTURE' AND status IN ${OPEN})
     SELECT s.id, c.n AS open_captures
       FROM c LEFT JOIN settlements s
         ON s.listing_id = $1
        AND (s.status = 'QUEUED'
             OR (s.status = 'RETRY' AND coalesce(s.next_attempt_at, now()) <= now())
             OR (s.status = 'RUNNING' AND s.lease_until < now()))
        AND (c.n = 0 OR s.action = 'CAPTURE' OR NOT s.is_reserve)
      ORDER BY (s.action = 'CAPTURE') DESC, s.created_at, s.id`,
    [listingId],
  );
  const rows = res.rows as Array<{ id: string | null; open_captures: number }>;
  return {
    ids: rows.flatMap((r) => (r.id ? [r.id] : [])),
    openCaptures: rows[0]?.open_captures ?? 0,
  };
}

/**
 * Phase 3: with the listing locked, re-check done and move CLEARING → SETTLED conditionally.
 * True only for the caller whose UPDATE moved the row: that caller (and nobody else) pays out.
 */
export async function settleIfDone(
  db: SettleBidDeps['db'],
  listingId: string,
  actor: Actor = WORKFLOW,
): Promise<{ settled: boolean; blockers: Blockers }> {
  return db.tx(async (tx) => {
    // Lock order: listing first, as Clear and promoteWithin do; a promotion can't slip in.
    const locked = await tx.query(`SELECT status FROM listings WHERE id = $1 FOR UPDATE`, [
      listingId,
    ]);
    if (!locked.rows[0]) throw new Error(`listing ${listingId} not found`);
    const blockers = await settlementBlockers(tx, listingId);
    if (!isDone(blockers)) return { settled: false, blockers };
    const moved = await transition(tx, 'listings', listingId, 'CLEARING', 'SETTLED');
    if (!moved) return { settled: false, blockers };
    const totals = (
      await tx.query(
        `SELECT count(*) FILTER (WHERE action = 'CAPTURE' AND status = 'SUCCEEDED')::int AS captured,
                coalesce(sum(amount_cents) FILTER (WHERE action = 'CAPTURE'
                                                     AND status = 'SUCCEEDED'), 0)::int AS captured_cents,
                count(*) FILTER (WHERE action = 'VOID' AND status = 'SUCCEEDED')::int AS released
           FROM settlements WHERE listing_id = $1`,
        [listingId],
      )
    ).rows[0] as { captured: number; captured_cents: number; released: number };
    await audit(tx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      listingId,
      entity: 'listing',
      entityId: listingId,
      action: 'LISTING_SETTLED',
      data: {
        captured: totals.captured,
        capturedCents: totals.captured_cents,
        released: totals.released,
      },
    });
    await emit(tx, listingId, {
      type: 'listing.status',
      listingId,
      at: new Date().toISOString(),
      from: 'CLEARING',
      to: 'SETTLED',
    });
    return { settled: true, blockers };
  });
}

export async function settleListing(
  deps: SettleListingDeps,
  listingId: string,
): Promise<SettleListingResult> {
  const pool = deps.db.pool;
  const leaseSeconds = deps.runLeaseSeconds ?? 60;
  const run = (
    await pool.query(`SELECT id, status FROM settlement_runs WHERE listing_id = $1`, [listingId])
  ).rows[0] as { id: string; status: string } | undefined;
  if (!run) return { outcome: 'NO_RUN' };
  if (deps.signal?.aborted) return { outcome: 'ABORTED', tasks: 0 };
  const claimed = await claim<RunRow>(pool, 'settlement_runs', run.id, leaseSeconds);
  if (!claimed) {
    const now = (await pool.query(`SELECT status FROM settlement_runs WHERE id = $1`, [run.id]))
      .rows[0] as { status: string };
    return { outcome: now.status === 'DONE' ? 'ALREADY_DONE' : 'BUSY' };
  }
  const lease = claimed as RunLease;

  // Heartbeat: renew the run lease while we work. A lost lease means another coordinator took
  // over (we were too slow); stop starting tasks.
  let lost = false;
  const heartbeat = setInterval(
    () => {
      void renew(pool, lease, leaseSeconds)
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {});
    },
    Math.max(100, (leaseSeconds * 1000) / 3),
  );
  heartbeat.unref?.();
  const stopHeartbeat = () => clearInterval(heartbeat);
  deps.signal?.addEventListener('abort', stopHeartbeat, { once: true });

  try {
    return await coordinate(deps, listingId, lease, () => lost);
  } finally {
    stopHeartbeat();
    deps.signal?.removeEventListener('abort', stopHeartbeat);
  }
}

async function coordinate(
  deps: SettleListingDeps,
  listingId: string,
  lease: RunLease,
  isLost: () => boolean,
): Promise<SettleListingResult> {
  const pool = deps.db.pool;
  const actor = deps.actor ?? WORKFLOW;
  const startedAt = Date.now();
  const maxRunMs = deps.maxRunMs ?? DEFAULT_MAX_RUN_MS;
  const pollMs = deps.pollMs ?? DEFAULT_SETTLEMENT_POLL_MS;
  let tasks = 0;
  const stopped = (): SettleListingResult | null =>
    deps.signal?.aborted
      ? { outcome: 'ABORTED', tasks }
      : isLost()
        ? { outcome: 'LEASE_LOST', tasks }
        : null;

  const listing = (await pool.query(`SELECT status FROM listings WHERE id = $1`, [listingId]))
    .rows[0] as { status: string } | undefined;
  if (!listing) throw new Error(`listing ${listingId} not found`);
  if (listing.status !== 'CLEARING') {
    // A previous coordinator settled the listing and died before closing the run: make sure the
    // payout was asked for (idempotent in HF-032), then close the run.
    const payout = listing.status === 'SETTLED' ? await callPayout(deps, listingId) : 'NOT_NEEDED';
    if (payout === 'FAILED') return yieldRun(deps, lease, 'TIMEOUT', tasks, listingId);
    await closeRun(pool, lease);
    return { outcome: 'FINISHED', tasks, payout };
  }

  for (;;) {
    const halt = stopped();
    if (halt) return halt;

    const due = await dueSettlements(pool, listingId);
    if (due.ids.length > 0) {
      tasks += await runLimited(
        due.ids,
        deps.concurrency ?? SETTLEMENT_CONCURRENCY,
        (id) => runTask(deps, id, listingId),
        () => stopped() !== null,
      );
      continue;
    }

    const blockers = await settlementBlockers(pool, listingId);
    if (blockers.open === 0) {
      await releaseFailedCaptures(deps, listingId, actor, () => stopped() !== null);
      const halt2 = stopped();
      if (halt2) return halt2;
      const { settled } = await settleIfDone(deps.db, listingId, actor);
      if (settled) {
        const payout = await callPayout(deps, listingId);
        if (payout === 'FAILED') {
          // SETTLED is committed; hand the run back so the kicker asks for the payout again.
          await yieldRun(deps, lease, 'TIMEOUT', tasks, listingId);
          return { outcome: 'SETTLED', tasks, payout };
        }
        await closeRun(pool, lease);
        return { outcome: 'SETTLED', tasks, payout };
      }
      const now = (await pool.query(`SELECT status FROM listings WHERE id = $1`, [listingId]))
        .rows[0] as { status: string };
      if (now.status !== 'CLEARING') {
        // Someone else settled it (shouldn't happen while we hold the run): don't pay out twice.
        await closeRun(pool, lease);
        return { outcome: 'FINISHED', tasks, payout: 'NOT_NEEDED' };
      }
      // Nothing left to run but not done: a row needs a human (FAILED RECONCILE) or a failed
      // winner has no promotion outcome. Alert and hand back; admin retry or the kicker resumes.
      await alertBlocked(pool, listingId, blockers);
      return yieldRun(deps, lease, 'BLOCKED', tasks, listingId, blockers);
    }

    // Open rows exist but none is due: RETRY backoff, or a live lease held elsewhere.
    if (Date.now() - startedAt >= maxRunMs) {
      return yieldRun(deps, lease, 'TIMEOUT', tasks, listingId, blockers);
    }
    await sleepUnlessAborted(pollMs, deps.signal);
  }
}

async function runTask(
  deps: SettleListingDeps,
  settlementId: string,
  listingId: string,
): Promise<unknown> {
  try {
    return await (deps.runSettlement ?? ((id) => settleBid(deps, id)))(settlementId);
  } catch (err) {
    // A DB error mid-task (or a failed child task run) leaves the row RUNNING; its lease expires
    // and the next pass retries it.
    deps.onError?.(err, { settlementId, bidId: '', step: `settleListing:${listingId}` });
    return null;
  }
}

/**
 * Finish the void of every failed winner whose hold is not released yet. `settleBid` voids a
 * declined authorization after committing the CAPTURE row FAILED, so a coordinator that dies in
 * between leaves the bid CAPTURE_FAILED or VOIDING with no open settlement row to resume it.
 * Runs once nothing is open, so no task of this coordinator is still voiding the same bid.
 * A void that keeps failing stays VOIDING for the sweeper (HF-034) and does not hold up SETTLED.
 */
async function releaseFailedCaptures(
  deps: SettleListingDeps,
  listingId: string,
  actor: Actor,
  stop: () => boolean,
): Promise<void> {
  const res = await deps.db.pool.query(
    `SELECT id FROM bids
      WHERE listing_id = $1
        AND (status = 'CAPTURE_FAILED' OR (status = 'VOIDING' AND void_reason = 'CAPTURE_FAILED'))
      ORDER BY id`,
    [listingId],
  );
  const ids = (res.rows as Array<{ id: string }>).map((r) => r.id);
  await runLimited(
    ids,
    deps.concurrency ?? SETTLEMENT_CONCURRENCY,
    async (bidId) => {
      try {
        await voidFailedCapture(deps, bidId, actor, { resume: true });
      } catch (err) {
        deps.onError?.(err, {
          settlementId: '',
          bidId,
          step: `releaseFailedCaptures:${listingId}`,
        });
      }
    },
    stop,
  );
}

/**
 * Run `fn` over `items` with at most `limit` in flight (a p-limit-style pool, kept inline so
 * packages/core has no extra dependency). Stops starting new items once `stop()` is true.
 * Returns how many were started.
 */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
  stop: () => boolean = () => false,
): Promise<number> {
  let next = 0;
  let started = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const item = items[next++]!;
      started++;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return started;
}

async function callPayout(
  deps: SettleListingDeps,
  listingId: string,
): Promise<'CALLED' | 'FAILED'> {
  const payout = deps.payoutBrand ?? payoutBrandPlaceholder(deps.db);
  try {
    await payout(listingId);
    return 'CALLED';
  } catch (err) {
    deps.onError?.(err, { settlementId: '', bidId: '', step: 'payoutBrand' });
    await audit(deps.db.pool, {
      actorType: 'WORKFLOW',
      listingId,
      entity: 'listing',
      entityId: listingId,
      action: 'PAYOUT_KICK_FAILED',
      data: { error: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
    return 'FAILED';
  }
}

async function closeRun(q: Queryable, lease: RunLease): Promise<void> {
  await release(q, lease, 'DONE', { finished_at: SQL_NOW });
}

/** Hand the run back as PENDING; `kicked_at = now()` so the kicker retries it after its stale window. */
async function yieldRun(
  deps: SettleListingDeps,
  lease: RunLease,
  reason: 'TIMEOUT' | 'BLOCKED',
  tasks: number,
  listingId: string,
  blockers?: Blockers,
): Promise<SettleListingResult> {
  await release(deps.db.pool, lease, 'PENDING', { kicked_at: SQL_NOW });
  return {
    outcome: 'YIELDED',
    reason,
    tasks,
    blockers: blockers ?? (await settlementBlockers(deps.db.pool, listingId)),
  };
}

/** One `SETTLEMENT_BLOCKED` alert per distinct set of blockers, not one per kick. */
async function alertBlocked(q: Queryable, listingId: string, b: Blockers): Promise<void> {
  const data = { ...b, alert: true };
  const prior = await q.query(
    `SELECT 1 FROM audit_events
      WHERE listing_id = $1 AND action = 'SETTLEMENT_BLOCKED' AND data @> $2::jsonb LIMIT 1`,
    [listingId, JSON.stringify(data)],
  );
  if (prior.rowCount) return;
  await audit(q, {
    actorType: 'WORKFLOW',
    listingId,
    entity: 'listing',
    entityId: listingId,
    action: 'SETTLEMENT_BLOCKED',
    data,
  });
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * The in-process runner (`SETTLEMENT_RUNNER=inprocess`): a `KickSettlement` for Clear and the
 * outbox kicker. Kicks for a listing already running in this process share its promise; across
 * processes the run lease decides.
 */
export function inProcessSettlementRunner(
  deps: SettleListingDeps,
  opts: { onResult?: (listingId: string, result: SettleListingResult) => void } = {},
): { kick: KickSettlement; settle(listingId: string): Promise<SettleListingResult> } {
  const running = new Map<string, Promise<SettleListingResult>>();
  const settle = (listingId: string) => {
    const existing = running.get(listingId);
    if (existing) return existing;
    const p = settleListing(deps, listingId)
      .then((r) => {
        opts.onResult?.(listingId, r);
        return r;
      })
      .finally(() => running.delete(listingId));
    running.set(listingId, p);
    return p;
  };
  return {
    settle,
    kick: ({ listingId }) => {
      void settle(listingId).catch((err: unknown) =>
        deps.onError?.(err, { settlementId: '', bidId: '', step: 'settleListing' }),
      );
    },
  };
}
