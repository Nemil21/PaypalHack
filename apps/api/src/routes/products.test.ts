/**
 * HF-009 `GET /api/products/search`: auth, api.md shape, Channel3 outage → 502 CHANNEL3_ERROR,
 * validation and the shared HF-006 rate limit. Uses the recorded fixtures (CHANNEL3_MODE=fixtures).
 * The 401 tests need no database; the rest need TEST_DATABASE_URL and are skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Channel3Error, Channel3FixtureClient, loadConfig } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer, type ServerDeps } from '../server.js';

const SECRET = 'q'.repeat(40);
const config = loadConfig({
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  CHANNEL3_MODE: 'fixtures',
});
const QUERY = 'wireless noise cancelling over-ear headphones';
const url = (q: string) => `/api/products/search?q=${encodeURIComponent(q)}`;
const session = (kind: 'brand-session' | 'shopper-session', sub: string) =>
  signToken(SECRET, kind, { sub, exp: Date.now() + 60_000 });

describe('HF-009 product search: unauthenticated', () => {
  const app = buildServer(config, { webDistDir: null, channel3: new Channel3FixtureClient() });
  afterAll(() => app.close());

  it('no session → 401 UNAUTHENTICATED', async () => {
    const res = await app.inject({ method: 'GET', url: url(QUERY) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('forged or expired cookies → 401', async () => {
    for (const cookie of [
      `${BRAND_COOKIE}=${signToken('z'.repeat(40), 'brand-session', { sub: crypto.randomUUID(), exp: Date.now() + 60_000 })}`,
      `${SHOPPER_COOKIE}=${signToken(SECRET, 'shopper-session', { sub: crypto.randomUUID(), exp: Date.now() - 1 })}`,
    ]) {
      const res = await app.inject({ method: 'GET', url: url(QUERY), headers: { cookie } });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)('HF-009 product search (Postgres)', () => {
  let tdb: TestDatabase;
  let brandCookie: string;
  let shopperCookie: string;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    const brand = await tdb.db.pool.query<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('JBL', 'p@jbl.example') RETURNING id`,
    );
    const user = await tdb.db.pool.query<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, 'viewer@jbl.example', 'VIEWER') RETURNING id`,
      [brand.rows[0]!.id],
    );
    const shopper = await tdb.db.pool.query<{ id: string }>(
      `INSERT INTO shoppers DEFAULT VALUES RETURNING id`,
    );
    brandCookie = `${BRAND_COOKIE}=${session('brand-session', user.rows[0]!.id)}`;
    shopperCookie = `${SHOPPER_COOKIE}=${session('shopper-session', shopper.rows[0]!.id)}`;
  }, 60_000);
  afterAll(async () => {
    await tdb?.close();
  });

  function server(deps: ServerDeps = {}) {
    return buildServer(config, {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      channel3: new Channel3FixtureClient(),
      ...deps,
    });
  }

  it('brand session (any role): api.md shape, brand flag, identities cached', async () => {
    const app = server();
    const res = await app.inject({
      method: 'GET',
      url: url(QUERY),
      headers: { cookie: brandCookie },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: Record<string, unknown>[] };
    expect(results.length).toBeGreaterThan(0);
    expect(Object.keys(results[0]!).sort()).toEqual(
      [
        'bestPublicPriceCents',
        'brandMatch',
        'brandName',
        'channel3Id',
        'condition',
        'gtin',
        'imageUrl',
        'mpn',
        'offerCount',
        'title',
        'variant',
        'variantLabel',
      ].sort(),
    );
    expect(results.some((r) => r.brandMatch === true)).toBe(true);
    expect(results.some((r) => r.brandMatch === false)).toBe(true);
    const cached = await tdb.db.pool.query('SELECT 1 FROM products WHERE channel3_id = $1', [
      results[0]!.channel3Id,
    ]);
    expect(cached.rowCount).toBe(1);
    await app.close();
  });

  it('shopper session: results without the brand flag', async () => {
    const app = server();
    const res = await app.inject({
      method: 'GET',
      url: `${url(QUERY)}&limit=3`,
      headers: { cookie: shopperCookie },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: { brandMatch: unknown }[] };
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.brandMatch === null)).toBe(true);
    await app.close();
  });

  it('Channel3 outage → 502 CHANNEL3_ERROR with the manual-entry fallback', async () => {
    for (const err of [
      new Channel3Error('OUTAGE', 'down', 503),
      new Channel3Error('AUTH', 'no credits', 402),
      new Channel3Error('UNCONFIGURED', 'no key'),
    ]) {
      const channel3 = new Channel3FixtureClient();
      channel3.failures.push(err);
      const app = server({ channel3 });
      const res = await app.inject({
        method: 'GET',
        url: url(QUERY),
        headers: { cookie: brandCookie },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: {
          code: 'CHANNEL3_ERROR',
          message: expect.stringMatching(/enter the GTIN or MPN by hand/),
          fallback: 'MANUAL_IDENTIFIER',
          reason: err.kind,
        },
      });
      await app.close();
    }
  });

  it('validates q and limit', async () => {
    const app = server();
    for (const u of [
      '/api/products/search',
      url('a'),
      `${url(QUERY)}&limit=0`,
      `${url(QUERY)}&limit=31`,
    ]) {
      const res = await app.inject({ method: 'GET', url: u, headers: { cookie: brandCookie } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    await app.close();
  });

  it('shares the HF-006 per-user REST limit', async () => {
    const app = server({ limiter: new RateLimiter({ mcp: 30, rest: 2, agent: 20 }) });
    const hit = () =>
      app.inject({ method: 'GET', url: url(QUERY), headers: { cookie: shopperCookie } });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    await app.close();
  });
});
