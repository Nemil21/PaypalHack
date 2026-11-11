/**
 * HF-006 integration tests against a real, freshly migrated Postgres: route guard matrix,
 * provisional shoppers, magic-link round trip, demo logins and per-user rate limits.
 * Needs TEST_DATABASE_URL (a server where the user may CREATE DATABASE); skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/auth
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer, type ServerDeps } from '../server.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from './guards.js';
import { DEMO_ACCOUNTS } from './store.js';
import { sealToken, signToken } from './tokens.js';

const SECRET = 'q'.repeat(40);
const BASE_ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  ADMIN_EMAILS: 'Admin@Holdfast.Example',
};

let key = 0;
const k = () => ({ 'idempotency-key': `key-${++key}` });

/** `name=value` pairs from Set-Cookie headers. */
function cookiesFrom(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
  const out: Record<string, string> = {};
  for (const c of list as string[]) {
    const [pair] = c.split(';');
    const eq = pair!.indexOf('=');
    out[pair!.slice(0, eq)] = pair!.slice(eq + 1);
  }
  return out;
}

const cookieHeader = (name: string, value: string) => ({ cookie: `${name}=${value}` });

describe.skipIf(!TEST_DATABASE_URL)('HF-006 auth (Postgres)', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await tdb?.close();
  });

  const links: { email: string; url: string }[] = [];
  /** Handler runs of the idempotent test route, by shopper. */
  const runs: string[] = [];

  function server(env: Record<string, string> = {}, deps: ServerDeps = {}) {
    const app = buildServer(loadConfig({ ...BASE_ENV, ...env }), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      sendMagicLink: (email, url) => {
        links.push({ email, url });
      },
      ...deps,
    });
    const g = app.guards;
    app.get('/api/test/brand', { onRequest: g.requireBrandUser() }, async (req) => ({
      role: req.auth.brandUser!.role,
    }));
    app.post('/api/test/manage', { onRequest: g.requireBrandUser('MANAGER') }, async () => ({
      ok: true,
    }));
    app.post('/api/test/own', { onRequest: g.requireBrandUser('OWNER') }, async () => ({
      ok: true,
    }));
    app.get('/api/test/admin', { onRequest: g.requireAdmin }, async () => ({ ok: true }));
    app.post('/api/test/shopper', { onRequest: g.requireShopper }, async (req) => ({
      shopperId: req.auth.shopper!.id,
    }));
    app.get('/api/test/offer', { onRequest: g.ensureShopper }, async (req) => ({
      shopperId: req.auth.shopper!.id,
    }));
    app.post(
      '/api/test/hold',
      { onRequest: g.requireShopper },
      app.idempotent(async (req) => {
        runs.push(req.auth.shopper!.id);
        return { status: 201, body: { holdNo: runs.length, body: req.body } };
      }),
    );
    app.post(
      '/api/test/agent',
      { onRequest: [g.requireShopper, g.rateLimit('agent')] },
      async () => ({ ok: true }),
    );
    return app;
  }

  async function shopperCount(): Promise<number> {
    const { rows } = await tdb.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM shoppers',
    );
    return rows[0]!.n;
  }

  async function demoBrand(app: ReturnType<typeof server>, role: 'OWNER' | 'VIEWER') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/demo/brand',
      headers: k(),
      payload: { role },
    });
    expect(res.statusCode).toBe(200);
    return { res, cookie: cookiesFrom(res)[BRAND_COOKIE]! };
  }

  beforeEach(() => {
    links.length = 0;
    runs.length = 0;
  });

  describe('route guard matrix', () => {
    it('brand routes: none → 401, VIEWER on MANAGER route → 403, OWNER passes', async () => {
      const app = server();
      const anon = await app.inject({ method: 'GET', url: '/api/test/brand' });
      expect(anon.statusCode).toBe(401);
      expect(anon.json().error.code).toBe('UNAUTHENTICATED');

      const viewer = (await demoBrand(app, 'VIEWER')).cookie;
      const owner = (await demoBrand(app, 'OWNER')).cookie;
      const as = (c: string) => cookieHeader(BRAND_COOKIE, c);

      expect(
        (await app.inject({ method: 'GET', url: '/api/test/brand', headers: as(viewer) })).json(),
      ).toEqual({ role: 'VIEWER' });
      const denied = await app.inject({
        method: 'POST',
        url: '/api/test/manage',
        headers: { ...as(viewer), ...k() },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', requiredRole: 'MANAGER' });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/test/manage',
            headers: { ...as(owner), ...k() },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/test/own',
            headers: { ...as(owner), ...k() },
          })
        ).statusCode,
      ).toBe(200);

      // A MANAGER passes MANAGER routes but not OWNER routes.
      const { rows } = await tdb.db.pool.query<{ brand_id: string }>(
        'SELECT brand_id FROM brand_users WHERE email = $1',
        [DEMO_ACCOUNTS.ownerEmail],
      );
      const mgr = await tdb.db.pool.query<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, 'mgr@brand.example', 'MANAGER') RETURNING id`,
        [rows[0]!.brand_id],
      );
      const mgrCookie = signToken(SECRET, 'brand-session', {
        sub: mgr.rows[0]!.id,
        exp: Date.now() + 60_000,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/test/manage',
            headers: { ...as(mgrCookie), ...k() },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/test/own',
            headers: { ...as(mgrCookie), ...k() },
          })
        ).statusCode,
      ).toBe(403);

      // A role change applies on the next request (the row is loaded per request).
      await tdb.db.pool.query(`UPDATE brand_users SET role = 'VIEWER' WHERE id = $1`, [
        mgr.rows[0]!.id,
      ]);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/test/manage',
            headers: { ...as(mgrCookie), ...k() },
          })
        ).statusCode,
      ).toBe(403);
      await app.close();
    });

    it('forged, expired, wrong-purpose and deleted-user cookies → 401', async () => {
      const app = server();
      const owner = (await demoBrand(app, 'OWNER')).res.json().brandUser.id as string;
      const bad = [
        'garbage',
        signToken('z'.repeat(40), 'brand-session', { sub: owner, exp: Date.now() + 60_000 }),
        signToken(SECRET, 'brand-session', { sub: owner, exp: Date.now() - 1 }),
        signToken(SECRET, 'shopper-session', { sub: owner, exp: Date.now() + 60_000 }),
        signToken(SECRET, 'brand-session', {
          sub: '00000000-0000-0000-0000-000000000000',
          exp: Date.now() + 60_000,
        }),
      ];
      for (const c of bad) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test/brand',
          headers: cookieHeader(BRAND_COOKIE, c),
        });
        expect(res.statusCode).toBe(401);
      }
      await app.close();
    });

    it('admin: no session → 401; brand user not in ADMIN_EMAILS → 403; allowlisted → 200', async () => {
      const app = server();
      expect((await app.inject({ method: 'GET', url: '/api/test/admin' })).statusCode).toBe(401);
      const owner = (await demoBrand(app, 'OWNER')).cookie;
      const denied = await app.inject({
        method: 'GET',
        url: '/api/test/admin',
        headers: cookieHeader(BRAND_COOKIE, owner),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('FORBIDDEN');
      await app.close();

      // Allowlist matching is case-insensitive.
      const adminApp = server({ ADMIN_EMAILS: DEMO_ACCOUNTS.ownerEmail.toUpperCase() });
      const ok = await adminApp.inject({
        method: 'GET',
        url: '/api/test/admin',
        headers: cookieHeader(BRAND_COOKIE, owner),
      });
      expect(ok.statusCode).toBe(200);
      await adminApp.close();
    });

    it('shopper routes: no cookie → 401; a brand cookie is not a shopper session', async () => {
      const app = server();
      const owner = (await demoBrand(app, 'OWNER')).cookie;
      for (const headers of [
        {},
        cookieHeader(BRAND_COOKIE, owner),
        cookieHeader(SHOPPER_COOKIE, owner),
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/test/shopper',
          headers: { ...headers, ...k() },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('UNAUTHENTICATED');
      }
      await app.close();
    });
  });

  describe('provisional shopper (D13)', () => {
    it('first offer-page visit creates exactly one shopper per cookie', async () => {
      const app = server();
      const before = await shopperCount();
      const first = await app.inject({ method: 'GET', url: '/api/test/offer' });
      const cookie = cookiesFrom(first)[SHOPPER_COOKIE]!;
      expect(cookie).toBeTruthy();
      expect(String(first.headers['set-cookie'])).toMatch(
        /HttpOnly; SameSite=Lax; Max-Age=2592000/,
      );
      const id = first.json().shopperId as string;
      expect(await shopperCount()).toBe(before + 1);

      for (let i = 0; i < 5; i++) {
        const again = await app.inject({
          method: 'GET',
          url: '/api/test/offer',
          headers: cookieHeader(SHOPPER_COOKIE, cookie),
        });
        expect(again.json().shopperId).toBe(id);
        expect(again.headers['set-cookie']).toBeUndefined();
      }
      expect(await shopperCount()).toBe(before + 1);

      const { rows } = await tdb.db.pool.query('SELECT email FROM shoppers WHERE id = $1', [id]);
      expect(rows[0].email).toBeNull();

      // The provisional shopper now passes requireShopper (bids always have a shopper_id).
      const bid = await app.inject({
        method: 'POST',
        url: '/api/test/shopper',
        headers: { ...cookieHeader(SHOPPER_COOKIE, cookie), ...k() },
      });
      expect(bid.json()).toEqual({ shopperId: id });
      await app.close();
    });

    it('race: 25 concurrent visits with one cookie whose row is gone → still one row', async () => {
      const app = server();
      const first = await app.inject({ method: 'GET', url: '/api/test/offer' });
      const cookie = cookiesFrom(first)[SHOPPER_COOKIE]!;
      const id = first.json().shopperId as string;
      await tdb.db.pool.query('DELETE FROM shoppers WHERE id = $1', [id]); // e.g. demo:reset
      const before = await shopperCount();
      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          app.inject({
            method: 'GET',
            url: '/api/test/offer',
            headers: cookieHeader(SHOPPER_COOKIE, cookie),
          }),
        ),
      );
      expect(new Set(results.map((r) => r.json().shopperId))).toEqual(new Set([id]));
      expect(await shopperCount()).toBe(before + 1);
      await app.close();
    });

    it('race: concurrent cookie-less visits get one shopper and one cookie each', async () => {
      const app = server();
      const before = await shopperCount();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => app.inject({ method: 'GET', url: '/api/test/offer' })),
      );
      const ids = results.map((r) => r.json().shopperId);
      expect(new Set(ids).size).toBe(10);
      expect(results.every((r) => cookiesFrom(r)[SHOPPER_COOKIE])).toBe(true);
      expect(await shopperCount()).toBe(before + 10);
      await app.close();
    });
  });

  describe('magic link', () => {
    it('round trip: request → console link → verify attaches the email and signs in', async () => {
      const app = server();
      const visit = await app.inject({ method: 'GET', url: '/api/test/offer' });
      const cookie = cookiesFrom(visit)[SHOPPER_COOKIE]!;
      const provisionalId = visit.json().shopperId as string;

      const req = await app.inject({
        method: 'POST',
        url: '/api/auth/shopper/magic-link',
        headers: { ...cookieHeader(SHOPPER_COOKIE, cookie), ...k(), host: 'holdfast.test' },
        payload: { email: '  Maya@Example.COM ', next: '/bids/123' },
      });
      expect(req.statusCode).toBe(202);
      expect(links).toHaveLength(1);
      expect(links[0]!.email).toBe('maya@example.com');
      const url = new URL(links[0]!.url);
      expect(url.origin).toBe('http://holdfast.test');
      expect(url.pathname).toBe('/api/auth/shopper/magic-link/verify');
      // No personal data in URLs (HF-047): the token is sealed, so the email can't be decoded.
      const token = url.searchParams.get('token')!;
      expect(links[0]!.url.toLowerCase()).not.toContain('maya');
      expect(Buffer.from(token, 'base64url').toString('latin1').toLowerCase()).not.toContain(
        'maya',
      );

      // Opened in the browser that asked for it: the provisional shopper gets the email.
      const verify = await app.inject({
        method: 'GET',
        url: url.pathname + url.search,
        headers: cookieHeader(SHOPPER_COOKIE, cookie),
      });
      expect(verify.statusCode).toBe(302);
      expect(verify.headers.location).toBe('/bids/123');
      const signedIn = cookiesFrom(verify)[SHOPPER_COOKIE]!;
      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(SHOPPER_COOKIE, signedIn),
      });
      expect(me.json().shopper).toMatchObject({
        id: provisionalId,
        email: 'maya@example.com',
        provisional: false,
      });

      // Single use.
      const replay = await app.inject({ method: 'GET', url: url.pathname + url.search });
      expect(replay.statusCode).toBe(401);

      // Same email from another device's provisional shopper → signs into the existing shopper.
      const other = await app.inject({ method: 'GET', url: '/api/test/offer' });
      await app.inject({
        method: 'POST',
        url: '/api/auth/shopper/magic-link',
        headers: { ...cookieHeader(SHOPPER_COOKIE, cookiesFrom(other)[SHOPPER_COOKIE]!), ...k() },
        payload: { email: 'maya@example.com' },
      });
      const second = new URL(links[1]!.url);
      const v2 = await app.inject({ method: 'GET', url: second.pathname + second.search });
      expect(v2.headers.location).toBe('/bids');
      const me2 = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(SHOPPER_COOKIE, cookiesFrom(v2)[SHOPPER_COOKIE]!),
      });
      expect(me2.json().shopper.id).toBe(provisionalId);
      await app.close();
    });

    it('a link requested by someone else never binds the email to the requester (takeover)', async () => {
      const app = server();
      // Attacker: provisional shopper A, asks for a link to the victim's address.
      const attackerVisit = await app.inject({ method: 'GET', url: '/api/test/offer' });
      const attackerCookie = cookiesFrom(attackerVisit)[SHOPPER_COOKIE]!;
      const attackerId = attackerVisit.json().shopperId as string;
      await app.inject({
        method: 'POST',
        url: '/api/auth/shopper/magic-link',
        headers: { ...cookieHeader(SHOPPER_COOKIE, attackerCookie), ...k() },
        payload: { email: 'victim@example.com' },
      });
      const link = new URL(links[0]!.url);

      // Victim clicks the genuine email in their own browser (their own provisional cookie).
      const victimVisit = await app.inject({ method: 'GET', url: '/api/test/offer' });
      const victimCookie = cookiesFrom(victimVisit)[SHOPPER_COOKIE]!;
      const verify = await app.inject({
        method: 'GET',
        url: link.pathname + link.search,
        headers: cookieHeader(SHOPPER_COOKIE, victimCookie),
      });
      expect(verify.statusCode).toBe(302);
      const victimMe = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(SHOPPER_COOKIE, cookiesFrom(verify)[SHOPPER_COOKIE]!),
      });
      expect(victimMe.json().shopper.email).toBe('victim@example.com');
      expect(victimMe.json().shopper.id).not.toBe(attackerId);
      expect(victimMe.json().shopper.id).not.toBe(victimVisit.json().shopperId);

      // The attacker's cookie still points at a provisional shopper with no email.
      const attackerMe = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(SHOPPER_COOKIE, attackerCookie),
      });
      expect(attackerMe.json().shopper).toMatchObject({ id: attackerId, email: null });
      const owners = await tdb.db.pool.query(
        `SELECT id FROM shoppers WHERE lower(email) = 'victim@example.com'`,
      );
      expect(owners.rows).toEqual([{ id: victimMe.json().shopper.id }]);

      // Opened with no cookie at all: also a fresh shopper, never the requester's.
      await app.inject({
        method: 'POST',
        url: '/api/auth/shopper/magic-link',
        headers: { ...cookieHeader(SHOPPER_COOKIE, attackerCookie), ...k() },
        payload: { email: 'other@example.com' },
      });
      const second = new URL(links[1]!.url);
      const bare = await app.inject({ method: 'GET', url: second.pathname + second.search });
      const bareMe = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(SHOPPER_COOKIE, cookiesFrom(bare)[SHOPPER_COOKIE]!),
      });
      expect(bareMe.json().shopper.id).not.toBe(attackerId);
      expect(bareMe.json().shopper.email).toBe('other@example.com');
      await app.close();
    });

    it('per-email limit: the 4th link for one address in a minute → 429', async () => {
      const app = server();
      const ask = (email: string) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/shopper/magic-link',
          headers: k(),
          payload: { email },
        });
      for (let i = 0; i < 3; i++) expect((await ask('bomb@example.com')).statusCode).toBe(202);
      const limited = await ask('Bomb@Example.com');
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
      expect((await ask('someone-else@example.com')).statusCode).toBe(202);
      expect(links.filter((l) => l.email === 'bomb@example.com')).toHaveLength(3);
      await app.close();
    });

    it('rejects tampered or expired links, bad emails and open redirects', async () => {
      const app = server();
      const expired = sealToken(SECRET, 'magic-link', {
        sub: 'x@example.com',
        exp: Date.now() - 1,
      });
      const forged = signToken(SECRET, 'shopper-session', {
        sub: 'x@example.com',
        exp: Date.now() + 60_000,
      });
      // A readable signed token for the right purpose is not a magic link either (HF-047).
      const signed = signToken(SECRET, 'magic-link', {
        sub: 'x@example.com',
        exp: Date.now() + 60_000,
      });
      const otherPurpose = sealToken(SECRET, 'paypal-state', {
        sub: 'x@example.com',
        exp: Date.now() + 60_000,
      });
      for (const t of [expired, forged, signed, otherPurpose, 'nope']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/auth/shopper/magic-link/verify?token=${t}`,
        });
        expect(res.statusCode).toBe(401);
      }
      for (const payload of [
        { email: 'not-an-email' },
        { email: 'a@b.co', next: '//evil.example' },
        { email: 'a@b.co', next: 'https://evil.example' },
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/shopper/magic-link',
          headers: k(),
          payload,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      }
      expect(links).toHaveLength(0);
      await app.close();
    });
  });

  describe('DEMO_MODE logins', () => {
    it('on: demo brand OWNER / VIEWER and demo shopper sign in; concurrent logins create one brand', async () => {
      const app = server();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          app.inject({
            method: 'POST',
            url: '/api/auth/demo/brand',
            headers: k(),
            payload: { role: i % 2 ? 'VIEWER' : 'OWNER' },
          }),
        ),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      const brands = await tdb.db.pool.query(
        `SELECT DISTINCT brand_id FROM brand_users WHERE email IN ($1, $2)`,
        [DEMO_ACCOUNTS.ownerEmail, DEMO_ACCOUNTS.viewerEmail],
      );
      expect(brands.rowCount).toBe(1);

      const owner = results[0]!;
      expect(owner.json().brandUser).toMatchObject({
        role: 'OWNER',
        brand: { name: 'Aurel Audio', verificationStatus: 'VERIFIED' },
      });
      expect(String(owner.headers['set-cookie'])).toMatch(
        /hf_brand=.*HttpOnly; SameSite=Lax; Max-Age=43200/,
      );

      const shopper = await app.inject({
        method: 'POST',
        url: '/api/auth/demo/shopper',
        headers: k(),
      });
      expect(shopper.statusCode).toBe(200);
      expect(shopper.json().shopper).toMatchObject({
        email: DEMO_ACCOUNTS.shopperEmail,
        provisional: false,
      });
      const again = await app.inject({
        method: 'POST',
        url: '/api/auth/demo/shopper',
        headers: k(),
      });
      expect(again.json().shopper.id).toBe(shopper.json().shopper.id);

      // Logins need no principal, so nothing is stored under their keys.
      const keys = await tdb.db.pool.query(
        `SELECT 1 FROM idempotency_keys WHERE route LIKE '%/api/auth/%'`,
      );
      expect(keys.rowCount).toBe(0);
      await app.close();
    });

    it('off: 404, and existing sessions keep working', async () => {
      const on = server();
      const owner = (await demoBrand(on, 'OWNER')).cookie;
      await on.close();
      const off = server({ DEMO_MODE: 'false' });
      const res = await off.inject({
        method: 'POST',
        url: '/api/auth/demo/brand',
        headers: k(),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(
        (await off.inject({ method: 'POST', url: '/api/auth/demo/shopper', headers: k() }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await off.inject({
            method: 'GET',
            url: '/api/test/brand',
            headers: cookieHeader(BRAND_COOKIE, owner),
          })
        ).statusCode,
      ).toBe(200);
      await off.close();
    });

    it('logout clears the cookies', async () => {
      const app = server();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: k(),
        payload: {},
      });
      expect(res.json()).toEqual({ signedOut: 'all' });
      const set = String(res.headers['set-cookie']);
      expect(set).toContain('hf_brand=;');
      expect(set).toContain('hf_shopper=;');
      expect(set).toContain('Max-Age=0');
      await app.close();
    });
  });

  describe('idempotency wiring and per-user limits', () => {
    it("app.idempotent: HF-003b's store, scoped to the guard's principal", async () => {
      const app = server();
      const a = cookiesFrom(await app.inject({ method: 'GET', url: '/api/test/offer' }))[
        SHOPPER_COOKIE
      ]!;
      const b = cookiesFrom(await app.inject({ method: 'GET', url: '/api/test/offer' }))[
        SHOPPER_COOKIE
      ]!;
      const hold = (c: string, key: string, payload: unknown) =>
        app.inject({
          method: 'POST',
          url: '/api/test/hold',
          headers: { ...cookieHeader(SHOPPER_COOKIE, c), 'idempotency-key': key },
          payload: payload as object,
        });

      const first = await hold(a, 'same-key', { amountCents: 22900 });
      expect(first.statusCode).toBe(201);
      const replay = await hold(a, 'same-key', { amountCents: 22900 });
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      expect(runs).toHaveLength(1);

      // Same key, different body → 422; another shopper's identical key → a fresh run.
      const mismatch = await hold(a, 'same-key', { amountCents: 23900 });
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
      const other = await hold(b, 'same-key', { amountCents: 22900 });
      expect(other.statusCode).toBe(201);
      expect(other.json().holdNo).toBe(2);
      expect(new Set(runs).size).toBe(2);

      // Concurrent duplicates: exactly one run; the rest replay or get 409 IN_PROGRESS.
      const burst = await Promise.all(
        Array.from({ length: 10 }, () => hold(a, 'burst-key', { amountCents: 25000 })),
      );
      expect(runs.filter((id) => id === runs[0]).length).toBe(2);
      for (const r of burst) {
        expect([201, 409]).toContain(r.statusCode);
        if (r.statusCode === 409) expect(r.json().error.code).toBe('IN_PROGRESS');
      }

      // No key → 400 before the guard or the store runs.
      const noKey = await app.inject({
        method: 'POST',
        url: '/api/test/hold',
        headers: cookieHeader(SHOPPER_COOKIE, a),
        payload: {},
      });
      expect(noKey.statusCode).toBe(400);
      expect(noKey.json().error.code).toBe('VALIDATION_ERROR');
      expect(runs).toHaveLength(3);
      await app.close();
    });

    it('61st REST call by one user → 429; another user is unaffected', async () => {
      const app = server();
      const a = cookiesFrom(await app.inject({ method: 'GET', url: '/api/test/offer' }))[
        SHOPPER_COOKIE
      ]!;
      const b = cookiesFrom(await app.inject({ method: 'GET', url: '/api/test/offer' }))[
        SHOPPER_COOKIE
      ]!;
      const call = (c: string) =>
        app.inject({ method: 'GET', url: '/api/me', headers: cookieHeader(SHOPPER_COOKIE, c) });
      // The cookie-less first visit counted against the IP, not the shopper.
      for (let i = 0; i < 60; i++) expect((await call(a)).statusCode).toBe(200);
      const limited = await call(a);
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
      expect((await call(b)).statusCode).toBe(200);
      await app.close();
    });

    it('agent: 21st turn in a minute → 429', async () => {
      const app = server();
      const c = cookiesFrom(await app.inject({ method: 'GET', url: '/api/test/offer' }))[
        SHOPPER_COOKIE
      ]!;
      const turn = () =>
        app.inject({
          method: 'POST',
          url: '/api/test/agent',
          headers: { ...cookieHeader(SHOPPER_COOKIE, c), ...k() },
        });
      for (let i = 0; i < 20; i++) expect((await turn()).statusCode).toBe(200);
      expect((await turn()).statusCode).toBe(429);
      await app.close();
    });
  });
});
