import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '@holdfast/core';
import { amountCentsSchema } from '@holdfast/shared';
import { buildServer, type ServerDeps } from '../server.js';
import { signToken, verifyToken } from '../auth/tokens.js';
import { ApiError, parse } from './errors.js';
import { RateLimiter } from './rate-limit.js';
import { loggerOptions, redactString, redactValue } from './redact.js';

/** HF-006 request plumbing that needs no database. Auth against Postgres: auth/auth.test.ts. */

const REQUIRED = {
  DATABASE_URL: 'postgres://holdfast:pw@localhost:5432/holdfast',
  SESSION_SECRET: 's'.repeat(40),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

const KEY = { 'idempotency-key': 'k-1' };

function server(env: Record<string, string> = {}, deps: ServerDeps = {}) {
  const app = buildServer(loadConfig({ ...REQUIRED, ...env }), {
    webDistDir: null,
    // The real `/mcp` guard + scope gate (HF-043) with an echo handler instead of the MCP server.
    mcp: {
      handler: async (req) => ({ clientId: req.auth.mcp?.clientId, key: req.idempotencyKey }),
    },
    ...deps,
  });
  app.post('/api/test/echo', async (req) => ({ ok: true, key: req.idempotencyKey }));
  app.get('/api/test/ping', async () => ({ ok: true }));
  app.post('/api/webhooks/paypal', async () => ({ ok: true }));
  app.post('/api/auth/paypal/callback', async () => ({ ok: true }));
  app.post('/api/test/amount', async (req) =>
    parse(z.object({ amountCents: amountCentsSchema }), req.body, 'body'),
  );
  app.get('/api/test/conflict', async () => {
    throw new ApiError('STATE_CONFLICT', 'Listing is clearing.', { reason: 'CLEARING' });
  });
  app.get('/api/test/boom', async () => {
    throw new Error('db password is hunter2');
  });
  return app;
}

let app: ReturnType<typeof server> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('signed tokens', () => {
  const secret = 'x'.repeat(32);

  it('round-trips, and rejects tampering, another purpose, another secret and expiry', () => {
    const t = signToken(secret, 'shopper-session', { sub: 'abc', exp: Date.now() + 1000 });
    expect(verifyToken(secret, 'shopper-session', t)?.sub).toBe('abc');
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'evil', exp: Date.now() + 1e6, jti: 'j' }));
    expect(verifyToken(secret, 'shopper-session', `${forged.toString('base64url')}.${sig}`)).toBe(
      null,
    );
    expect(verifyToken(secret, 'brand-session', t)).toBe(null);
    expect(verifyToken(secret, 'magic-link', t)).toBe(null);
    expect(verifyToken('y'.repeat(32), 'shopper-session', t)).toBe(null);
    expect(verifyToken(secret, 'shopper-session', `${body}`)).toBe(null);
    expect(verifyToken(secret, 'shopper-session', t, Date.now() + 2000)).toBe(null);
  });
});

describe('log redaction', () => {
  it('scrubs emails, bearer and PayPal tokens and token query params', () => {
    const s = redactString(
      'pp call by jane.doe+x@example.com with Bearer A21AAabc.def-ghi and ' +
        'GET /bids/return?token=EC-5Y6538123T928473B&x=1 code=abc123',
    );
    expect(s).not.toMatch(/jane|A21AA|EC-5Y|abc123/);
    expect(s).toContain('[email]');
    expect(s).toContain('x=1');
  });

  it('redacts secret keys and nested values, including errors', () => {
    const out = redactValue({
      email: 'a@b.co',
      nested: { access_token: 'A21AAzzzzzzzzzz', note: 'from c@d.io' },
      err: new Error('payer e@f.io failed'),
    }) as Record<string, Record<string, unknown>>;
    expect(out.email).toBe('[redacted]');
    expect(out.nested!.access_token).toBe('[redacted]');
    expect(out.nested!.note).toBe('from [email]');
    expect(out.err!.message).toBe('payer [email] failed');
  });

  it('applies to real log lines through the Fastify logger options', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const f = Fastify({ logger: { ...loggerOptions('info'), stream } as never });
    f.get('/x', async (req) => {
      req.log.info({ payer: { email: 'p@q.com' } }, 'held for shopper s@t.com');
      return {};
    });
    await f.inject({ method: 'GET', url: '/x?token=EC-ABCDEFGH123', headers: { cookie: 'a=b' } });
    await f.close();
    const all = lines.join('\n');
    expect(all).toContain('held for shopper [email]');
    expect(all).not.toMatch(/p@q\.com|s@t\.com|EC-ABCDEFGH123/);
  });
});

describe('RateLimiter', () => {
  it('sliding window: the (limit+1)th call within 60 s is refused, then frees up', () => {
    let now = 1_000_000;
    const rl = new RateLimiter({ mcp: 2, rest: 3, agent: 1, magicLink: 1 }, () => now);
    expect(rl.hit('rest', 'u').allowed).toBe(true);
    now += 30_000;
    expect(rl.hit('rest', 'u').allowed).toBe(true);
    expect(rl.hit('rest', 'u').allowed).toBe(true);
    const refused = rl.hit('rest', 'u');
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSec: 30 });
    expect(rl.hit('rest', 'other').allowed).toBe(true);
    expect(rl.hit('agent', 'u').allowed).toBe(true);
    now += 30_001; // the first call leaves the window
    expect(rl.hit('rest', 'u').allowed).toBe(true);
    expect(rl.hit('rest', 'u').allowed).toBe(false);
  });
});

describe('error envelope and validation', () => {
  it('ApiError → its status and code with details', async () => {
    app = server();
    const res = await app.inject({ method: 'GET', url: '/api/test/conflict' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'STATE_CONFLICT', message: 'Listing is clearing.', reason: 'CLEARING' },
    });
  });

  it('unknown errors → 500 INTERNAL_ERROR without internal detail', async () => {
    app = server();
    const res = await app.inject({ method: 'GET', url: '/api/test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toContain('hunter2');
  });

  it('amounts must be integer cents within 100–1,000,000', async () => {
    app = server();
    const post = (amountCents: unknown) =>
      app!.inject({
        method: 'POST',
        url: '/api/test/amount',
        headers: KEY,
        payload: { amountCents },
      });
    expect((await post(100)).statusCode).toBe(200);
    expect((await post(1_000_000)).statusCode).toBe(200);
    for (const bad of [99, 1_000_001, 229.5, '22900', null]) {
      const res = await post(bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.json().error.issues[0].path).toBe('amountCents');
    }
  });

  it('malformed JSON → 400 VALIDATION_ERROR', async () => {
    app = server();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { ...KEY, 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Idempotency-Key requirement', () => {
  it('a mutating call without the key → 400 VALIDATION_ERROR; with it, the handler sees it', async () => {
    app = server();
    const missing = await app.inject({ method: 'POST', url: '/api/test/echo', payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: 'VALIDATION_ERROR' });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { 'idempotency-key': 'has space' },
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: KEY,
      payload: {},
    });
    expect(ok.json()).toEqual({ ok: true, key: 'k-1' });
    expect((await app.inject({ method: 'GET', url: '/api/test/ping' })).statusCode).toBe(200);
  });

  it('webhooks, /mcp and the OAuth callback are exempt', async () => {
    app = server(
      {},
      {
        mcpTokens: {
          verify: async () => ({ clientId: 'c1', shopperId: 's1', scopes: ['read', 'bid'] }),
        },
      },
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/webhooks/paypal', payload: {} })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/paypal/callback', payload: {} }))
        .statusCode,
    ).toBe(200);
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer tok', origin: 'https://claude.ai' },
      payload: {},
    });
    expect(mcp.statusCode).toBe(200);
    expect(mcp.json()).toEqual({ clientId: 'c1', key: null });
  });
});

describe('CSRF Origin check', () => {
  const post = (headers: Record<string, string>) =>
    app!.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { ...KEY, host: 'holdfast.example', ...headers },
      payload: {},
    });

  it('rejects a cross-origin POST', async () => {
    app = server();
    for (const h of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { referer: 'https://evil.example/page' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://holdfast.example' },
    ]) {
      const res = await post(h);
      expect(res.statusCode, JSON.stringify(h)).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('allows same-origin, APP_BASE_URL, the dev proxy origin and header-less clients', async () => {
    app = server({ APP_BASE_URL: 'https://holdfast.onrender.com', PORT: '3000' });
    expect((await post({ origin: 'https://holdfast.example' })).statusCode).toBe(200);
    expect((await post({ origin: 'https://holdfast.onrender.com' })).statusCode).toBe(200);
    expect((await post({ origin: 'http://localhost:3000' })).statusCode).toBe(200);
    expect((await post({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await post({})).statusCode).toBe(200);
  });

  it('in production the localhost dev origin is not allowed', async () => {
    app = server({ NODE_ENV: 'production', PORT: '3000' });
    expect((await post({ origin: 'http://localhost:3000' })).statusCode).toBe(403);
  });

  it('webhooks are exempt from the Origin check', async () => {
    app = server();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/paypal',
      headers: { origin: 'https://paypal.com' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('rate limits', () => {
  it('61st REST call in a minute → 429 RATE_LIMITED; health checks are not counted', async () => {
    app = server();
    for (let i = 0; i < 60; i++) {
      expect((await app.inject({ method: 'GET', url: '/api/test/ping' })).statusCode).toBe(200);
    }
    const res = await app.inject({ method: 'GET', url: '/api/test/ping' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/healthz' })).statusCode).toBe(200);
  });

  it('31st MCP call in a minute for one token → 429; another token is unaffected', async () => {
    app = server(
      {},
      {
        mcpTokens: {
          verify: async (t) => ({ clientId: t, shopperId: 's', scopes: ['read', 'bid'] }),
        },
      },
    );
    const call = (token: string) =>
      app!.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
    for (let i = 0; i < 30; i++) expect((await call('a')).statusCode).toBe(200);
    const res = await call('a');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect((await call('b')).statusCode).toBe(200);
  });

  it('MCP guessing: once an IP is throttled, bad tokens are refused before any lookup', async () => {
    let lookups = 0;
    app = server(
      {},
      {
        limiter: new RateLimiter({ mcp: 3, rest: 60, agent: 1, magicLink: 1 }),
        mcpTokens: {
          verify: async () => {
            lookups++;
            return null;
          },
        },
      },
    );
    const call = (token: string) =>
      app!.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
    for (let i = 0; i < 3; i++) expect((await call(`hf_mcp_guess${i}`)).statusCode).toBe(401);
    expect(lookups).toBe(3);
    for (let i = 0; i < 5; i++) {
      const res = await call(`hf_mcp_more${i}`);
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('RATE_LIMITED');
    }
    // Throttled requests never reached the token lookup (no database query).
    expect(lookups).toBe(3);
  });

  it('peek reports the next decision without counting a call', () => {
    const rl = new RateLimiter({ mcp: 1, rest: 1, agent: 1, magicLink: 1 }, () => 1_000);
    expect(rl.peek('mcp', 'k').allowed).toBe(true);
    expect(rl.peek('mcp', 'k').allowed).toBe(true);
    expect(rl.hit('mcp', 'k').allowed).toBe(true);
    expect(rl.peek('mcp', 'k')).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('MCP: no token → 401, unknown token → 401, money tool without the bid scope → FORBIDDEN', async () => {
    app = server(
      {},
      {
        mcpTokens: {
          verify: async (t) =>
            t === 'good' ? { clientId: 'c', shopperId: 's', scopes: ['read'] } : null,
        },
      },
    );
    const call = (headers: Record<string, string>, payload: object = {}) =>
      app!.inject({ method: 'POST', url: '/mcp', headers, payload });
    expect((await call({})).json().error.code).toBe('UNAUTHENTICATED');
    expect((await call({ authorization: 'Bearer bad' })).statusCode).toBe(401);
    const tool = (name: string) => ({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name, arguments: {} },
    });
    const scoped = await call({ authorization: 'Bearer good' }, tool('place_bid'));
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({ id: 7, result: { isError: true } });
    expect(scoped.json().result.content[0].text).toMatch(/^FORBIDDEN: /);
    // A read tool passes the gate to the handler.
    expect((await call({ authorization: 'Bearer good' }, tool('get_book'))).json()).toEqual({
      clientId: 'c',
      key: null,
    });
  });
});

describe('DEMO_MODE logins off', () => {
  it('DEMO_MODE=false → the demo login endpoints return 404', async () => {
    app = server({ DEMO_MODE: 'false' });
    for (const url of ['/api/auth/demo/brand', '/api/auth/demo/shopper']) {
      const res = await app.inject({ method: 'POST', url, headers: KEY, payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
  });
});
