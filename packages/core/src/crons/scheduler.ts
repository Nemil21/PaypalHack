import { audit } from '../audit.js';
import type { Db } from '../db.js';

/**
 * The in-process cron scheduler (HF-034). One scheduler per web instance; every job runs under
 * `pg_try_advisory_lock(<job id>)` on a dedicated connection, so overlapping ticks and several
 * instances never run the same job twice at once (and never double-call PayPal). A tick that
 * finds the lock taken skips. Runs that did something, and runs that failed, are audited as
 * `SYSTEM` (`CRON_RUN` / `CRON_FAILED`); idle runs are not, so the audit feed is not 1,440
 * empty rows a day per job.
 *
 * Render cron is used only for `demo:refresh` (HF-048b); everything here runs in-process.
 */

export interface CronJob<R = unknown> {
  /** Stable id: the advisory lock key and the audit `data.job`. */
  id: string;
  intervalMs: number;
  run: () => Promise<R>;
}

export type JobRun<R> =
  | { ran: false; reason: 'LOCKED' }
  /** Only from `startCrons`: the run threw (already audited `CRON_FAILED` and passed to onError). */
  | { ran: false; reason: 'FAILED'; error: unknown }
  | { ran: true; result: R; ms: number };

/** Advisory lock key text for a job (hashed with `hashtextextended`). */
export function cronLockName(jobId: string): string {
  return `holdfast:cron:${jobId}`;
}

/** True when a run result reports any non-zero count (worth an audit row). */
export function didWork(result: unknown): boolean {
  if (typeof result === 'number') return result > 0;
  if (!result || typeof result !== 'object') return false;
  return Object.values(result as Record<string, unknown>).some((v) =>
    Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? v > 0 : false,
  );
}

/**
 * Run `job` once if no other run (in this process or another instance) holds its lock.
 * The lock is session-level on a connection held for the whole run; if unlocking fails the
 * connection is destroyed, which releases the lock with it.
 */
export async function runJob<R>(db: Pick<Db, 'pool'>, job: CronJob<R>): Promise<JobRun<R>> {
  const client = await db.pool.connect();
  let locked = false;
  let broken: Error | undefined;
  try {
    const res = await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [
      cronLockName(job.id),
    ]);
    locked = Boolean((res.rows[0] as { ok: boolean }).ok);
    if (!locked) return { ran: false, reason: 'LOCKED' };
    const t0 = Date.now();
    let result: R;
    try {
      result = await job.run();
    } catch (err) {
      await auditRun(db, job.id, 'CRON_FAILED', {
        ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
      throw err;
    }
    const ms = Date.now() - t0;
    if (didWork(result)) {
      await auditRun(db, job.id, 'CRON_RUN', { ms, result }).catch(() => {});
    }
    return { ran: true, result, ms };
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
          cronLockName(job.id),
        ]);
      } catch (err) {
        broken = err instanceof Error ? err : new Error(String(err));
      }
    }
    client.release(broken);
  }
}

async function auditRun(
  db: Pick<Db, 'pool'>,
  jobId: string,
  action: 'CRON_RUN' | 'CRON_FAILED',
  data: Record<string, unknown>,
): Promise<void> {
  await audit(db.pool, {
    actorType: 'SYSTEM',
    actorId: `cron:${jobId}`,
    entity: 'cron',
    action,
    data: { job: jobId, ...data },
  });
}

export interface StartCronsOptions {
  db: Pick<Db, 'pool'>;
  jobs: readonly CronJob[];
  onError?: (err: unknown, jobId: string) => void;
  onRun?: (jobId: string, run: JobRun<unknown>) => void;
  /** Run every job once right away (default true). */
  runAtStart?: boolean;
}

export interface Crons {
  /** Stop scheduling and wait for runs in flight. */
  stop(): Promise<void>;
  /** Run one job now (still under its lock); for tests and ops. */
  runNow(jobId: string): Promise<JobRun<unknown>>;
}

/** Start every job on its own interval. A job never overlaps itself in this process. */
export function startCrons(opts: StartCronsOptions): Crons {
  const inFlight = new Map<string, Promise<JobRun<unknown>>>();
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  const byId = new Map(opts.jobs.map((j) => [j.id, j]));

  const fire = (job: CronJob): Promise<JobRun<unknown>> => {
    const running = inFlight.get(job.id);
    if (running) return running;
    const p = runJob(opts.db, job)
      .then((run) => {
        opts.onRun?.(job.id, run);
        return run;
      })
      .catch((err: unknown) => {
        opts.onError?.(err, job.id);
        return { ran: false, reason: 'FAILED', error: err } as JobRun<unknown>;
      })
      .finally(() => inFlight.delete(job.id));
    inFlight.set(job.id, p);
    return p;
  };

  for (const job of opts.jobs) {
    const timer = setInterval(() => {
      if (!stopped) void fire(job);
    }, job.intervalMs);
    timer.unref?.();
    timers.push(timer);
    if (opts.runAtStart ?? true) void fire(job);
  }

  return {
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      await Promise.allSettled([...inFlight.values()]);
    },
    runNow(jobId) {
      const job = byId.get(jobId);
      if (!job) throw new Error(`unknown cron job ${jobId}`);
      return fire(job);
    },
  };
}
