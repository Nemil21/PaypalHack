/**
 * HF-054b regression: `startCrons` with more jobs than pool connections. Every run holds one
 * connection for its advisory lock and its work needs another; firing every job at boot used to
 * take the whole pool and wait on it forever (the API's healthz then reported the DB unreachable).
 * Needs TEST_DATABASE_URL; skipped when unset.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../money/test-harness.js';
import { startCrons, type CronJob, type JobRun } from './scheduler.js';

describe.skipIf(!TEST_DATABASE_URL)('cron scheduler vs. a small pool', { timeout: 30_000 }, () => {
  let t: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    t = await createTestDatabase();
    pool = new pg.Pool({ connectionString: t.url, max: 4 });
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    await t?.close();
  });

  it('twelve jobs on a pool of four all run at boot without starving the pool', async () => {
    const db = createDb(pool);
    const ran: string[] = [];
    const jobs: CronJob[] = Array.from({ length: 12 }, (_, i) => ({
      id: `pool-test-${i}`,
      intervalMs: 60_000,
      run: async () => {
        await pool.query('SELECT pg_sleep(0.02)');
        ran.push(`pool-test-${i}`);
        return { done: 0 };
      },
    }));
    const crons = startCrons({ db, jobs, maxConcurrent: 2 });
    const deadline = Date.now() + 10_000;
    while (ran.length < 12 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await crons.stop();
    expect(ran.sort()).toEqual(jobs.map((j) => j.id).sort());
    // And the pool still answers.
    expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
  });
});

/** A pool whose every connection gets the advisory lock at once: no Postgres needed. */
function fakeLockDb() {
  const client = { query: async () => ({ rows: [{ ok: true }] }), release() {} };
  return { pool: { connect: async () => client } } as unknown as Parameters<
    typeof startCrons
  >[0]['db'];
}

describe('cron scheduler shutdown', () => {
  it('stop() never starts runs still queued for a slot; it waits only for the running one', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const started: string[] = [];
    const outcomes = new Map<string, JobRun<unknown>>();
    const jobs: CronJob[] = Array.from({ length: 5 }, (_, i) => ({
      id: `stop-test-${i}`,
      intervalMs: 60_000,
      run: async () => {
        started.push(`stop-test-${i}`);
        if (i === 0) await firstGate;
        return { done: 0 };
      },
    }));
    const crons = startCrons({
      db: fakeLockDb(),
      jobs,
      maxConcurrent: 1,
      onRun: (id, run) => outcomes.set(id, run),
    });
    // Boot: job 0 holds the only slot, jobs 1-4 wait behind it.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(['stop-test-0']);

    const stopping = crons.stop();
    releaseFirst();
    await stopping;

    expect(started).toEqual(['stop-test-0']);
    expect(outcomes.get('stop-test-0')).toMatchObject({ ran: true });
    for (let i = 1; i < 5; i++) {
      expect(outcomes.get(`stop-test-${i}`)).toEqual({ ran: false, reason: 'STOPPED' });
    }
  });
});
