import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@holdfast/core';
import { buildServer } from './server.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://holdfast:pw@localhost:5432/holdfast',
  SESSION_SECRET: 'x'.repeat(32),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

const INDEX = '<!doctype html><div id="root"></div><script src="/assets/app-abc.js"></script>';

function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'holdfast-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
  return dir;
}

const html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

describe('same-origin SPA (M31)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildServer(
      loadConfig({ ...REQUIRED, AG_GRID_LICENSE_KEY: 'lic-123', DEMO_MODE: 'true' }),
      {
        webDistDir: fakeDist(),
      },
    );
    await app.ready();
  });
  afterAll(() => app.close());

  it.each(['/', '/brand/listings/lst_1', '/o/aurel-a7', '/bids/b1', '/dev/components', '/admin'])(
    'serves index.html for client route %s',
    async (url) => {
      const res = await app.inject({ method: 'GET', url, headers: html });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toBe(INDEX);
    },
  );

  it('serves hashed assets with long caching and other files without', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/app-abc.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['cache-control']).toContain('immutable');
    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it.each(['/api/nope', '/api', '/mcp', '/webhooks/paypal', '/assets/missing.js'])(
    'answers %s with the JSON 404 envelope, never the SPA',
    async (url) => {
      const res = await app.inject({ method: 'GET', url, headers: html });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    },
  );

  it('does not serve the SPA to non-GET or non-HTML requests', async () => {
    const post = await app.inject({ method: 'POST', url: '/brand', headers: html });
    expect(post.statusCode).toBe(404);
    const json = await app.inject({
      method: 'GET',
      url: '/brand',
      headers: { accept: 'application/json' },
    });
    expect(json.statusCode).toBe(404);
  });

  it('keeps API routes and the public /healthz working', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.json()).toMatchObject({ status: 'ok' });
    // HF-048a's Render health check must never be answered by the SPA, even for a browser.
    const health = await app.inject({ method: 'GET', url: '/healthz', headers: html });
    expect(health.headers['content-type']).toMatch(/application\/json/);
    expect(health.body).not.toBe(INDEX);
  });

  it('exposes the AG licence and demo flag at runtime, uncached', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/client-config' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ agGridLicenseKey: 'lic-123', demoMode: true });
  });
});

describe('without a web build', () => {
  const app = buildServer(loadConfig(REQUIRED), { webDistDir: null });
  afterAll(() => app.close());

  it('says how to build for pages and still returns JSON 404 for the API', async () => {
    const page = await app.inject({ method: 'GET', url: '/brand', headers: html });
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain('npm run build -w @holdfast/web');
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('returns a null licence when none is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/client-config' });
    expect(res.json()).toEqual({ agGridLicenseKey: null, demoMode: false });
  });
});

// Over a real socket: the page, a cookie-authenticated API call and an SSE stream all come from
// one origin, so the SameSite=Lax session cookie rides along on each (HF-006 / HF-008 plug in here).
describe('cookie and SSE on the SPA origin', () => {
  let app: FastifyInstance;
  let origin: string;
  beforeAll(async () => {
    app = buildServer(loadConfig(REQUIRED), { webDistDir: fakeDist() });
    app.post('/api/test/session', async (_req, reply) => {
      reply.header('Set-Cookie', 'hf_session=s1; Path=/; HttpOnly; SameSite=Lax');
      return { ok: true };
    });
    app.get('/api/test/listings/:id/events', (req, reply) => {
      if (!req.headers.cookie?.includes('hf_session=s1')) return reply.code(401).send();
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      reply.raw.end(
        `data: ${JSON.stringify({ type: 'listing.status', listingId: 'l1', at: 'now', from: null, to: 'OPEN' })}\n\n`,
      );
    });
    origin = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(() => app.close());

  it('sets the cookie on the SPA origin and streams events with it', async () => {
    const page = await fetch(`${origin}/brand/listings/l1`, { headers: html });
    expect(await page.text()).toBe(INDEX);

    // Mutating calls need an Idempotency-Key (HF-006).
    const login = await fetch(`${origin}/api/test/session`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'login-1' },
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toBe('hf_session=s1');

    const denied = await fetch(`${origin}/api/test/listings/l1/events`);
    expect(denied.status).toBe(401);

    const stream = await fetch(`${origin}/api/test/listings/l1/events`, { headers: { cookie } });
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(await stream.text()).toContain('"type":"listing.status"');
  });
});
