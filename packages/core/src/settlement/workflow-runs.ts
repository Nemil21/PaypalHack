import { audit } from '../audit.js';
import type { Db } from '../db.js';
import type { KickSettlement, SettlementRunRef } from './outbox.js';

/**
 * Starting settlement on Render Workflows (HF-030b; `SETTLEMENT_RUNNER=workflows`). The web
 * service never settles itself: a kick (Clear's post-COMMIT kick, the HF-034 outbox kicker, admin
 * retry) starts the `settleListing` task run on the workflow service, which runs the same
 * `settleListing` coordinator with each settlement row as a child `settleBid` task run.
 *
 * - The first run is started with `idempotencyKey = listingId`, so a repeated kick (two web
 *   instances, a retried HTTP call) returns the same run instead of starting another.
 * - Its id is stored on `settlement_runs.workflow_run_id` and shown as `workflowRunId`.
 * - A kick while that run is pending or running is a no-op. Render keeps idempotency keys for
 *   24 h, so once the run has ended without finishing the listing (it yielded, failed, or was
 *   killed), the next kick starts run n with the key `<listingId>:<n>`. A run Render still calls
 *   running but whose coordinator lease expired is hung: it is cancelled first.
 * - Money safety never depends on this bookkeeping: two coordinators for one listing are kept
 *   apart by the `settlement_runs` lease (the second is BUSY), and every PayPal call is replayable.
 */

/** The slice of `@renderinc/sdk/workflows`' client the runner needs, so tests pass a fake. */
export interface WorkflowRunClient {
  startTask(
    taskSlug: string,
    input: unknown[],
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<{ taskRunId: string }>;
  getTaskRun(taskRunId: string): Promise<{ status: string }>;
  cancelTaskRun(taskRunId: string): Promise<void>;
}

export interface WorkflowSettlementDeps {
  db: Pick<Db, 'pool'>;
  client: WorkflowRunClient;
  /** `<RENDER_WORKFLOW_SLUG>/settleListing`. */
  taskSlug: string;
  /** Per Render API call. Default 30 s. */
  timeoutMs?: number;
}

export type StartSettlementWorkflowResult =
  | { outcome: 'STARTED'; workflowRunId: string; idempotencyKey: string; start: number }
  /** A run is pending or running (or another kicker just started one). */
  | { outcome: 'LIVE'; workflowRunId: string | null }
  | { outcome: 'DONE'; workflowRunId: string | null }
  | { outcome: 'NO_RUN' };

/** A claimed start slot with no run id yet counts as a start in flight for this long. */
export const START_IN_FLIGHT_SECONDS = 60;

/** Render task run statuses that may still do work. */
const LIVE_STATUSES = new Set(['pending', 'running']);

export function workflowIdempotencyKey(listingId: string, start: number): string {
  return start <= 1 ? listingId : `${listingId}:${start}`;
}

export async function startSettlementWorkflow(
  deps: WorkflowSettlementDeps,
  run: SettlementRunRef,
): Promise<StartSettlementWorkflowResult> {
  const pool = deps.db.pool;
  const timeout = () => AbortSignal.timeout(deps.timeoutMs ?? 30_000);
  const row = (
    await pool.query(
      `SELECT status, coalesce(lease_until < now(), false) AS lease_expired,
              workflow_run_id, workflow_starts,
              updated_at > now() - make_interval(secs => $2) AS recently_updated
         FROM settlement_runs WHERE id = $1`,
      [run.runId, START_IN_FLIGHT_SECONDS],
    )
  ).rows[0] as
    | {
        status: string;
        lease_expired: boolean;
        workflow_run_id: string | null;
        workflow_starts: number;
        recently_updated: boolean;
      }
    | undefined;
  if (!row) return { outcome: 'NO_RUN' };
  if (row.status === 'DONE') return { outcome: 'DONE', workflowRunId: row.workflow_run_id };

  if (row.workflow_starts > 0 && !row.workflow_run_id && row.recently_updated) {
    // Another kicker claimed a start slot and is calling Render right now.
    return { outcome: 'LIVE', workflowRunId: null };
  }
  if (row.workflow_run_id) {
    // Render unreachable: throw, so the kicker logs it and tries again on its next tick.
    const { status } = await deps.client.getTaskRun(row.workflow_run_id);
    if (LIVE_STATUSES.has(status)) {
      const hung = row.status === 'RUNNING' && row.lease_expired;
      if (!hung) return { outcome: 'LIVE', workflowRunId: row.workflow_run_id };
      // Its coordinator stopped renewing the lease; a fresh run takes over the rows.
      await deps.client.cancelTaskRun(row.workflow_run_id).catch(() => {});
    }
  }

  // One start per slot: two kickers racing here start one run between them.
  const start = row.workflow_starts + 1;
  const slot = await pool.query(
    `UPDATE settlement_runs SET workflow_starts = $2, workflow_run_id = NULL, updated_at = now()
      WHERE id = $1 AND workflow_starts = $3 AND status <> 'DONE'`,
    [run.runId, start, row.workflow_starts],
  );
  if (!slot.rowCount) {
    const now = (
      await pool.query(`SELECT workflow_run_id FROM settlement_runs WHERE id = $1`, [run.runId])
    ).rows[0] as { workflow_run_id: string | null } | undefined;
    return { outcome: 'LIVE', workflowRunId: now?.workflow_run_id ?? null };
  }

  const idempotencyKey = workflowIdempotencyKey(run.listingId, start);
  const { taskRunId } = await deps.client.startTask(deps.taskSlug, [run.listingId], {
    idempotencyKey,
    signal: timeout(),
  });
  await pool.query(
    `UPDATE settlement_runs SET workflow_run_id = $2, updated_at = now()
      WHERE id = $1 AND workflow_starts = $3`,
    [run.runId, taskRunId, start],
  );
  await audit(pool, {
    actorType: 'WORKFLOW',
    listingId: run.listingId,
    entity: 'listing',
    entityId: run.listingId,
    action: 'SETTLEMENT_WORKFLOW_STARTED',
    data: { runId: run.runId, workflowRunId: taskRunId, idempotencyKey, start },
  });
  return { outcome: 'STARTED', workflowRunId: taskRunId, idempotencyKey, start };
}

/**
 * The Workflows runner (`SETTLEMENT_RUNNER=workflows`): a `KickSettlement` for Clear, the outbox
 * kicker and admin retry. Errors propagate to the caller (the kicker logs them and retries).
 */
export function workflowsSettlementRunner(
  deps: WorkflowSettlementDeps,
  opts: { onResult?: (listingId: string, result: StartSettlementWorkflowResult) => void } = {},
): { kick: KickSettlement; start(run: SettlementRunRef): Promise<StartSettlementWorkflowResult> } {
  const start = async (run: SettlementRunRef) => {
    const result = await startSettlementWorkflow(deps, run);
    opts.onResult?.(run.listingId, result);
    return result;
  };
  return {
    start,
    kick: async (run) => {
      await start(run);
    },
  };
}
