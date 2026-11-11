import { task, type TaskContext } from '@renderinc/sdk/workflows';
import { createPool } from '@holdfast/core';
import { hello, type HelloResult } from './hello.js';

/** Task names; the web service triggers `<RENDER_WORKFLOW_SLUG>/<name>`. */
export const TASKS = { hello: 'hello' } as const;

export const helloTask = task(
  // Render-level retries off (D11): our tasks own their retries.
  { name: TASKS.hello, retry: { maxRetries: 0, waitDurationMs: 0 }, timeoutSeconds: 60 },
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
