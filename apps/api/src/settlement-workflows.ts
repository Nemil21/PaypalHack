import { createWorkflowsClient } from '@renderinc/sdk/workflows';
import {
  requireKeys,
  workflowsSettlementRunner,
  type Config,
  type Db,
  type StartSettlementWorkflowResult,
  type WorkflowRunClient,
} from '@holdfast/core';

/** Must match `TASKS.settleListing` in apps/workflows/src/tasks.ts. */
export const SETTLE_LISTING_TASK = 'settleListing';

/** The slice of the SDK's `WorkflowsClient` used here. */
export interface RenderWorkflowsSdk {
  startTask(
    slug: string,
    input: unknown[],
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<{ taskRunId: string }>;
  getTaskRun(taskRunId: string): Promise<{ status: string }>;
  cancelTaskRun(taskRunId: string): Promise<void>;
}

export function renderRunClient(sdk: RenderWorkflowsSdk): WorkflowRunClient {
  return {
    startTask: async (slug, input, options) => ({
      taskRunId: (await sdk.startTask(slug, input, options)).taskRunId,
    }),
    getTaskRun: async (id) => ({ status: (await sdk.getTaskRun(id)).status }),
    cancelTaskRun: (id) => sdk.cancelTaskRun(id),
  };
}

/**
 * `SETTLEMENT_RUNNER=workflows` (HF-030b): kicks start the `settleListing` task on the workflow
 * service with `RENDER_API_KEY` instead of settling in this process.
 */
export function createWorkflowsSettlement(
  config: Config,
  db: Pick<Db, 'pool'>,
  opts: {
    sdk?: RenderWorkflowsSdk;
    onResult?: (listingId: string, result: StartSettlementWorkflowResult) => void;
  } = {},
) {
  const sdk =
    opts.sdk ??
    createWorkflowsClient({
      token: requireKeys(config, 'Render Workflows', 'RENDER_API_KEY').RENDER_API_KEY,
    });
  return workflowsSettlementRunner(
    {
      db,
      client: renderRunClient(sdk),
      taskSlug: `${config.RENDER_WORKFLOW_SLUG}/${SETTLE_LISTING_TASK}`,
    },
    { onResult: opts.onResult },
  );
}
