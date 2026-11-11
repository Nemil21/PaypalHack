import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
import { registerHealthz, type Pingable } from './healthz.js';
import { buildServer } from './server.js';

function appWith(db: Pingable | undefined, timeoutMs?: number) {
  const app = Fastify();
  registerHealthz(app, db, timeoutMs);
  return app;
}

describe('GET /healthz', () => {
  it('pings the database with SELECT 1 and returns 200', async () => {
    const queries: string[] = [];
    const app = appWith({ query: async (sql) => void queries.push(sql) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(queries).toEqual(['SELECT 1']);
  });

  it('returns 503 without the error text when the ping fails', async () => {
    const app = appWith({
      query: async () => {
        throw new Error('password authentication failed for user "holdfast_secret_user"');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', db: 'unreachable' });
    expect(res.body).not.toContain('holdfast_secret_user');
  });

  it('returns 503 when the ping hangs past the timeout', async () => {
    const app = appWith({ query: () => new Promise(() => {}) }, 50);
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns 503 when no database is wired in', async () => {
    const res = await appWith(undefined).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', db: 'unconfigured' });
  });

  it('is mounted at the root by buildServer, outside /api', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://holdfast:pw@localhost:5432/holdfast',
      SESSION_SECRET: 'x'.repeat(32),
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
      PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
      NODE_ENV: 'test',
    });
    const app = buildServer(config, { db: { query: async () => undefined } });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
