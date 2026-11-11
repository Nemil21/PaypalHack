import { audit } from '../audit.js';
import { CRON_JOB_IDS } from '../crons/jobs.js';
import { runJob } from '../crons/scheduler.js';
import {
  sweepHolds,
  SWEEP_INTERVAL_MS,
  type SweepDeps,
  type SweepOptions,
  type SweepResult,
} from '../crons/sweeper.js';
import type { Actor } from '../money/deps.js';

/**
 * W20 "Void dangling holds" (HF-058; features/15 §Logic 4). Not a second void path: it runs the
 * HF-034 hold sweeper (`sweepHolds`) once, now, under the sweeper job's own advisory lock
 * (`runJob` with the `hold-sweeper` id). So it never runs beside a scheduled sweep on any
 * instance, every void still goes through `voidBid` / `callVoid` with `void-<bidId>` (D4), and
 * the sweep's own rows (`BID_VOIDED`, `CRON_RUN`…) are the sweeper's as usual.
 *
 * The admin action itself is audited around it: `ADMIN_VOID_DANGLING_REQUESTED` before, then
 * `_COMPLETED` (with the sweep counts), `_SKIPPED` (a sweep was already running) or `_FAILED`.
 */

export type VoidDanglingOutcome =
  { ran: true; result: SweepResult; ms: number } | { ran: false; reason: 'LOCKED' };

export async function voidDangling(
  deps: SweepDeps,
  actor: Actor,
  opts: SweepOptions = {},
): Promise<VoidDanglingOutcome> {
  const record = (action: string, data: Record<string, unknown> = {}) =>
    audit(deps.db.pool, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      entity: 'ops',
      action,
      data: { job: CRON_JOB_IDS.holdSweeper, ...data },
    });

  await record('ADMIN_VOID_DANGLING_REQUESTED');
  let run;
  try {
    run = await runJob(deps.db, {
      id: CRON_JOB_IDS.holdSweeper,
      intervalMs: SWEEP_INTERVAL_MS,
      run: () => sweepHolds(deps, opts),
    });
  } catch (err) {
    await record('ADMIN_VOID_DANGLING_FAILED', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  if (!run.ran) {
    await record('ADMIN_VOID_DANGLING_SKIPPED', { reason: 'LOCKED' });
    return { ran: false, reason: 'LOCKED' };
  }
  await record('ADMIN_VOID_DANGLING_COMPLETED', { result: run.result, ms: run.ms });
  return { ran: true, result: run.result, ms: run.ms };
}
