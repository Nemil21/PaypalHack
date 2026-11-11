import type { Db, Queryable } from '../db.js';

/**
 * The `settlement_runs` outbox (B6). Clear (HF-027) inserts the row in its transaction and kicks
 * the coordinator (HF-030a) after COMMIT. If the process dies between COMMIT and the kick, or
 * the coordinator dies mid-run, the kicker below finds the run again within a minute: HF-034
 * schedules `kickSettlementOutbox` (or `startSettlementOutboxKicker` in-process).
 */

export interface SettlementRunRef {
  runId: string;
  listingId: string;
}

/** Starts (or resumes) settlement for one run. Must be safe to call twice (it claims the run). */
export type KickSettlement = (run: SettlementRunRef) => void | Promise<void>;

/** A PENDING run kicked longer ago than this is kicked again. */
export const SETTLEMENT_KICK_STALE_SECONDS = 30;
/** Default tick: a lost kick is retried within stale + interval ≤ 45 s (ticket: < 1 min). */
export const SETTLEMENT_KICK_INTERVAL_MS = 15_000;

/** Record that a run was kicked (`settlement_runs.kicked_at`). */
export async function markKicked(q: Queryable, runId: string): Promise<void> {
  await q.query(`UPDATE settlement_runs SET kicked_at = now() WHERE id = $1`, [runId]);
}

/**
 * Runs that need a kick: PENDING and never kicked (the process died right after COMMIT) or kicked
 * more than `staleSeconds` ago without being claimed, and RUNNING with an expired lease.
 */
export async function settlementRunsToKick(
  q: Queryable,
  staleSeconds = SETTLEMENT_KICK_STALE_SECONDS,
): Promise<SettlementRunRef[]> {
  const res = await q.query(
    `SELECT id, listing_id FROM settlement_runs
      WHERE (status = 'PENDING'
             AND (kicked_at IS NULL OR kicked_at < now() - make_interval(secs => $1)))
         OR (status = 'RUNNING' AND lease_until < now())
      ORDER BY created_at, id`,
    [staleSeconds],
  );
  return (res.rows as Array<{ id: string; listing_id: string }>).map((r) => ({
    runId: r.id,
    listingId: r.listing_id,
  }));
}

/** One kicker tick: kick every run that needs it. Returns how many were kicked. */
export async function kickSettlementOutbox(
  db: Pick<Db, 'pool'>,
  kick: KickSettlement,
  opts: { staleSeconds?: number; onError?: (err: unknown, run: SettlementRunRef) => void } = {},
): Promise<number> {
  const runs = await settlementRunsToKick(db.pool, opts.staleSeconds);
  for (const run of runs) {
    try {
      await markKicked(db.pool, run.runId);
      await kick(run);
    } catch (err) {
      opts.onError?.(err, run);
    }
  }
  return runs.length;
}

/** Run `kickSettlementOutbox` on an interval (one web instance). Returns a stop function. */
export function startSettlementOutboxKicker(opts: {
  db: Pick<Db, 'pool'>;
  kick: KickSettlement;
  intervalMs?: number;
  staleSeconds?: number;
  onError?: (err: unknown) => void;
}): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await kickSettlementOutbox(opts.db, opts.kick, {
        staleSeconds: opts.staleSeconds,
        onError: (err) => opts.onError?.(err),
      });
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? SETTLEMENT_KICK_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer) };
}
