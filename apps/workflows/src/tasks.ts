import { task, type TaskContext } from '@renderinc/sdk/workflows';
import { createPool } from '@holdfast/core';
import { hello, type HelloResult } from './hello.js';
import { runSettleBid, runSettleListing, settlementFromEnv } from './settlement.js';

/** Task names; the web service triggers `<RENDER_WORKFLOW_SLUG>/<name>`. */
export const TASKS = {
  hello: 'hello',
  settleListing: 'settleListing',
  settleBid: 'settleBid',
} as const;

/** Render-level retries off (D11): our tasks own their retries. */
const NO_RETRIES = { maxRetries: 0, waitDurationMs: 0 };

export const helloTask = task(
  { name: TASKS.hello, retry: NO_RETRIES, timeoutSeconds: 60 },
  async function helloWorld(ctx: TaskContext): Promise<HelloResult & { taskRunId: string | null }> {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) throw new Error('hello: DATABASE_URL is not set on the workflow service');
    const pool = createPool({ DATABASE_URL }, 1);
    try {
      return { ...(await hello(pool, process.env)), taskRunId: ctx.metadata.taskRunId ?? null };
    } finally {
      await pool.end();
    }
  },
);

/**
 * One settlement row (capture or void). 4 PayPal calls at most with 1 s / 4 s / 16 s backoff, each
 * call under the client timeout: 180 s covers it. A run that times out leaves the row RUNNING
 * until its lease expires; the coordinator takes it over.
 */
export const settleBidTask = task(
  { name: TASKS.settleBid, retry: NO_RETRIES, timeoutSeconds: 180, plan: 'starter' },
  (_ctx: TaskContext, settlementId: string) => runSettleBid(settlementFromEnv, settlementId),
);

/**
 * The coordinator for one listing. It hands the run back after 5 minutes (`maxRunMs`) when rows
 * are still waiting; the outbox kicker then starts the next run.
 */
export const settleListingTask = task(
  { name: TASKS.settleListing, retry: NO_RETRIES, timeoutSeconds: 600, plan: 'starter' },
  (ctx: TaskContext, listingId: string) =>
    runSettleListing(settlementFromEnv, (id) => ctx.run(settleBidTask, id), listingId),
);
