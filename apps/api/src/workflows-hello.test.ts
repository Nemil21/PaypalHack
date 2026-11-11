import { describe, expect, it } from 'vitest';
import { MissingFeatureConfigError, loadConfig } from '@holdfast/core';
import { HELLO_TASK, triggerHello, type TaskRunner } from './workflows-hello.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://holdfast:pw@localhost:5432/holdfast',
  SESSION_SECRET: 'x'.repeat(32),
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
};

function fakeRunner(status: string, error?: string) {
  const calls: { slug: string; input: unknown[] }[] = [];
  const runner: TaskRunner = {
    runTask: async (slug, input) => {
      calls.push({ slug, input });
      return { id: 'trn-1', status, results: [{ ok: true }], ...(error ? { error } : {}) };
    },
  };
  return { runner, calls };
}

describe('triggerHello', () => {
  it('runs <default slug>/hello and reports success', async () => {
    const { runner, calls } = fakeRunner('succeeded');
    const run = await triggerHello(loadConfig({ ...REQUIRED, RENDER_API_KEY: 'rnd_x' }), {
      runner,
    });
    expect(calls).toEqual([{ slug: `holdfast-workflows/${HELLO_TASK}`, input: [] }]);
    expect(run).toEqual({
      slug: 'holdfast-workflows/hello',
      taskRunId: 'trn-1',
      status: 'succeeded',
      succeeded: true,
      results: [{ ok: true }],
      error: null,
    });
  });

  it('uses RENDER_WORKFLOW_SLUG when set', async () => {
    const { runner, calls } = fakeRunner('succeeded');
    const config = loadConfig({
      ...REQUIRED,
      RENDER_API_KEY: 'rnd_x',
      RENDER_WORKFLOW_SLUG: 'holdfast-wf-abc',
    });
    await triggerHello(config, { runner });
    expect(calls[0]?.slug).toBe('holdfast-wf-abc/hello');
  });

  it('reports a failed run as not succeeded', async () => {
    const { runner } = fakeRunner('failed', 'DATABASE_URL is not set');
    const run = await triggerHello(loadConfig({ ...REQUIRED, RENDER_API_KEY: 'rnd_x' }), {
      runner,
    });
    expect(run.succeeded).toBe(false);
    expect(run.error).toBe('DATABASE_URL is not set');
  });

  it('refuses without RENDER_API_KEY, naming the key only', async () => {
    const { runner, calls } = fakeRunner('succeeded');
    await expect(triggerHello(loadConfig(REQUIRED), { runner })).rejects.toThrow(
      MissingFeatureConfigError,
    );
    expect(calls).toEqual([]);
  });
});
