import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
import { buildServer } from './server.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://holdfast:pw@localhost:5432/holdfast',
  SESSION_SECRET: 'x'.repeat(32),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
};

describe('GET /api/healthz', () => {
  const app = buildServer(loadConfig({ ...REQUIRED, NODE_ENV: 'test' }));
  afterAll(() => app.close());

  it('returns 200 without a database', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', paypalMode: 'sandbox', paypalSandbox: true });
  });
});

// Boots the real entry point in a child process with a minimal environment: no .env file
// (cwd is an empty temp dir) and no inherited secrets.
describe('main.ts boot', () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), 'holdfast-boot-'));

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
      });
    });
  }

  function boot(env: Record<string, string>) {
    const child = spawn(tsx, ['--conditions=source', main], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOST: '127.0.0.1', LOG_LEVEL: 'silent', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    );
    return { child, exited, output: () => output };
  }

  it('serves /api/healthz with only the five required env vars', async () => {
    const port = await freePort();
    const { child, exited } = boot({ ...REQUIRED, PORT: String(port) });
    try {
      let status = 0;
      for (let i = 0; i < 100 && status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = await fetch(`http://127.0.0.1:${port}/api/healthz`)
          .then((r) => r.status)
          .catch(() => 0);
      }
      expect(status).toBe(200);
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  }, 20_000);

  it('exits non-zero with a clear message when a required var is missing', async () => {
    const env: Record<string, string> = { ...REQUIRED };
    delete env.SESSION_SECRET;
    const { exited, output } = boot(env);
    expect(await exited).toBe(1);
    expect(output()).toContain('SESSION_SECRET is required');
    expect(output()).not.toContain('test-client-secret');
  }, 20_000);

  it('refuses a live PayPal base without PAYPAL_ENV=live', async () => {
    const { exited, output } = boot({ ...REQUIRED, PAYPAL_API_BASE: 'https://api-m.paypal.com' });
    expect(await exited).toBe(1);
    expect(output()).toMatch(/not a PayPal sandbox host/);
  }, 20_000);
});
