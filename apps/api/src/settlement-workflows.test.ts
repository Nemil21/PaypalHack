import { describe, expect, it } from 'vitest';
import { MissingFeatureConfigError, loadConfig } from '@holdfast/core';
import { TASKS } from '../../workflows/src/tasks.js';
import {
  SETTLE_LISTING_TASK,
  createWorkflowsSettlement,
  type RenderWorkflowsSdk,
} from './settlement-workflows.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://holdfast:pw@localhost:5432/holdfast',
  SESSION_SECRET: 'x'.repeat(32),
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
};

/** A settlement_runs row as the pool returns it, tracking the UPDATEs the runner makes. */
function fakeDb() {
  const row = {
    status: 'PENDING',
    lease_expired: false,
    workflow_run_id: null as string | null,
    workflow_starts: 0,
    recently_updated: false,
  };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT status')) return { rows: [{ ...row }], rowCount: 1 };
      if (sql.includes('SET workflow_starts')) {
        row.workflow_starts = params[1] as number;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SET workflow_run_id')) {
        row.workflow_run_id = params[1] as string;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 }; // audit insert
    },
  };
  return { db: { pool } as never, row };
}

describe('Workflows settlement runner (SDK side)', () => {
  it('starts <slug>/settleListing keyed by the listing id and stores the run id', async () => {
    const starts: Array<{ slug: string; input: unknown[]; key: string }> = [];
    const sdk: RenderWorkflowsSdk = {
      startTask: async (slug, input, o) => {
        starts.push({ slug, input, key: o.idempotencyKey });
        return { taskRunId: 'trn-42' };
      },
      getTaskRun: async () => ({ status: 'running' }),
      cancelTaskRun: async () => {},
    };
    const { db, row } = fakeDb();
    const runner = createWorkflowsSettlement(
      loadConfig({ ...REQUIRED, RENDER_WORKFLOW_SLUG: 'holdfast-wf-abc' }),
      db,
      { sdk },
    );
    const res = await runner.start({ runId: 'run-1', listingId: 'listing-1' });
    expect(res).toEqual({
      outcome: 'STARTED',
      workflowRunId: 'trn-42',
      idempotencyKey: 'listing-1',
      start: 1,
    });
    expect(starts).toEqual([
      { slug: 'holdfast-wf-abc/settleListing', input: ['listing-1'], key: 'listing-1' },
    ]);
    expect(row.workflow_run_id).toBe('trn-42');
    // Live on Render: the next kick starts nothing.
    expect(await runner.start({ runId: 'run-1', listingId: 'listing-1' })).toEqual({
      outcome: 'LIVE',
      workflowRunId: 'trn-42',
    });
    expect(starts).toHaveLength(1);
  });

  it('the task name matches the workflow service', () => {
    expect(SETTLE_LISTING_TASK).toBe(TASKS.settleListing);
  });

  it('refuses without RENDER_API_KEY, naming the key only', () => {
    expect(() => createWorkflowsSettlement(loadConfig(REQUIRED), fakeDb().db)).toThrow(
      MissingFeatureConfigError,
    );
    expect(() => createWorkflowsSettlement(loadConfig(REQUIRED), fakeDb().db)).toThrow(
      /RENDER_API_KEY/,
    );
  });
});
