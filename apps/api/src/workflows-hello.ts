import { createWorkflowsClient } from '@renderinc/sdk/workflows';
import { requireKeys, type Config } from '@holdfast/core';

/** Must match `TASKS.hello` in apps/workflows/src/tasks.ts. */
export const HELLO_TASK = 'hello';

/** The slice of the Render workflows client this needs, so tests can pass a fake. */
export interface TaskRunner {
  runTask(
    slug: string,
    input: unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<{ id: string; status: string; results: unknown; error?: string }>;
}

export interface HelloRun {
  slug: string;
  taskRunId: string;
  status: string;
  succeeded: boolean;
  results: unknown;
  error: string | null;
}

/**
 * Trigger the Workflows hello-world task from the web service with `RENDER_API_KEY`
 * (HF-048a) and wait for it to finish.
 */
export async function triggerHello(
  config: Config,
  options: { runner?: TaskRunner; timeoutMs?: number } = {},
): Promise<HelloRun> {
  const { RENDER_API_KEY } = requireKeys(config, 'Render Workflows', 'RENDER_API_KEY');
  const runner = options.runner ?? createWorkflowsClient({ token: RENDER_API_KEY });
  const slug = `${config.RENDER_WORKFLOW_SLUG}/${HELLO_TASK}`;
  const run = await runner.runTask(slug, [], {
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
  return {
    slug,
    taskRunId: run.id,
    status: run.status,
    succeeded: run.status === 'succeeded' || run.status === 'completed',
    results: run.results,
    error: run.error ?? null,
  };
}
