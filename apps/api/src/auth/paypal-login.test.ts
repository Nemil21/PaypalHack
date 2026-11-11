/**
 * HF-010 Log in with PayPal. Unit tests for the identity client and sealed pending cookie, route
 * tests for `state` / `access_denied` (no database needed), and callback integration tests with a
 * mocked PayPal identity against a freshly migrated Postgres (skipped without TEST_DATABASE_URL):
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/auth/paypal-login.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer, type ServerDeps } from '../server.js';
import { BRAND_COOKIE, BRAND_PENDING_COOKIE, LIPP_STATE_COOKIE } from './guards.js';
import {
  identityFromUserinfo,
  openPending,
  RestPayPalIdentity,
  sealPending,
  StubPayPalIdentity,
  STUB_LIPP_IDENTITY,
  type PayPalLoginIdentity,
} from './paypal-login.js';
import { DEMO_ACCOUNTS } from './store.js';

const SECRET = 'q'.repeat(40);
const CLIENT_SECRET = 'test-client-secret-NEVER-IN-BROWSER';
const BASE_ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: CLIENT_SECRET,
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  APP_BASE_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
};

/** Set-Cookie headers by name (value, or '' when the cookie is being cleared). */
function setCookies(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
  const out: Record<string, string> = {};
  for (const c of list as string[]) {
    const [pair] = c.split(';');
    const eq = pair!.indexOf('=');
    out[pair!.slice(0, eq)] = decodeURIComponent(pair!.slice(eq + 1));
  }
  return out;
}

function identity(email: string, extra: Partial<PayPalLoginIdentity> = {}): PayPalLoginIdentity {
  return { email, emailVerified: true, payerId: `PAYER-${email}`, name: null, ...extra };
}

describe('LIPP identity client (HF-010)', () => {
  it('authorize URL: sandbox consent host, scopes, state, redirect; never the secret', () => {
    const client = new RestPayPalIdentity({
      apiBase: 'https://api-m.sandbox.paypal.com',
      clientId: 'cid',
      clientSecret: CLIENT_SECRET,
    });
    const url = new URL(
      client.authorizeUrl({ state: 'st4te', redirectUri: 'http://localhost:3000/cb' }),
    );
    expect(url.origin + url.pathname).toBe('https://www.sandbox.paypal.com/signin/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(
      'openid email https://uri.paypal.com/services/paypalattributes',
    );
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/cb');
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    const live = new RestPayPalIdentity({
      apiBase: 'https://api-m.paypal.com',
      clientId: 'cid',
      clientSecret: 'x',
    });
    expect(live.authorizeUrl({ state: 's', redirectUri: 'https://x/cb' })).toMatch(
      /^https:\/\/www\.paypal\.com\/signin\/authorize\?/,
    );
  });

  it('exchange: authorization_code token with Basic auth, then paypalv1.1 userinfo', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/oauth2/token')) {
        return Response.json({ access_token: 'AT-1', token_type: 'Bearer' });
      }
      return Response.json({
        user_id: 'https://www.paypal.com/webapps/auth/identity/user/abc',
        payer_id: 'PAYER123',
        name: 'Ada Brand',
        emails: [
          { value: 'old@example.com', primary: false, confirmed: true },
          { value: 'Ada@Brand.Example', primary: true, confirmed: true },
        ],
      });
    }) as unknown as typeof fetch;
    const client = new RestPayPalIdentity({
      apiBase: 'https://api-m.sandbox.paypal.com/',
      clientId: 'cid',
      clientSecret: 'sec',
      fetch: fetchMock,
    });
    await expect(client.exchange('the-code')).resolves.toEqual({
      email: 'ada@brand.example',
      emailVerified: true,
      payerId: 'PAYER123',
      name: 'Ada Brand',
    });
    expect(calls[0]!.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(calls[0]!.init.method).toBe('POST');
    const h0 = calls[0]!.init.headers as Record<string, string>;
    expect(h0.Authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);
    expect(new URLSearchParams(String(calls[0]!.init.body)).get('grant_type')).toBe(
      'authorization_code',
    );
    expect(new URLSearchParams(String(calls[0]!.init.body)).get('code')).toBe('the-code');
    expect(calls[1]!.url).toBe(
      'https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1',
    );
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer AT-1');
  });

  it('exchange failure surfaces only PayPal’s error code', async () => {
    const fetchMock = (async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'code used' },
        { status: 400 },
      )) as unknown as typeof fetch;
    const client = new RestPayPalIdentity({
      apiBase: 'https://api-m.sandbox.paypal.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetch: fetchMock,
    });
    await expect(client.exchange('c')).rejects.toMatchObject({
      stage: 'token',
      http: 400,
      code: 'invalid_grant',
    });
  });

  it('userinfo: OIDC email_verified wins; unconfirmed paypalv1.1 email is unverified', () => {
    expect(identityFromUserinfo({ email: 'A@b.co', email_verified: 'false' })).toMatchObject({
      email: 'a@b.co',
      emailVerified: false,
      payerId: null,
    });
    expect(
      identityFromUserinfo({ emails: [{ value: 'x@y.co', primary: true, confirmed: false }] }),
    ).toMatchObject({ email: 'x@y.co', emailVerified: false });
    expect(identityFromUserinfo({ payer_id: 'P' })).toBeNull();
  });

  it('pending identity cookie is sealed: unreadable, tamper-proof, expiring', () => {
    const sealed = sealPending(SECRET, {
      email: 'ada@brand.example',
      payerId: 'P1',
      name: null,
      exp: Date.now() + 60_000,
    });
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('ada@');
    expect(openPending(SECRET, sealed)?.email).toBe('ada@brand.example');
    expect(openPending('z'.repeat(40), sealed)).toBeNull();
    const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BA' : 'AA');
    expect(openPending(SECRET, flipped)).toBeNull();
    expect(openPending(SECRET, sealed, Date.now() + 120_000)).toBeNull();
  });
});

describe('LIPP routes without a database (HF-010)', () => {
  function server(stub = new StubPayPalIdentity()) {
    return buildServer(loadConfig(BASE_ENV), {
      webDistDir: null,
      limiter: new RateLimiter(),
      paypalIdentity: stub,
    });
  }

  async function start(app: ReturnType<typeof server>, query = '') {
    const res = await app.inject({ method: 'GET', url: `/api/auth/paypal/start${query}` });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    return { res, location, state: location.searchParams.get('state')!, cookie: setCookies(res) };
  }

  it('start: 302 to consent with a fresh state, mirrored in a signed HttpOnly cookie', async () => {
    const app = server();
    const a = await start(app);
    const b = await start(app);
    expect(a.state).toMatch(/^[\w-]{32}$/);
    expect(a.state).not.toBe(b.state);
    expect(a.location.searchParams.get('code')).toBe('stub-code');
    expect(a.location.toString()).toContain('http://localhost:3000/api/auth/paypal/callback');
    const raw = String(([] as unknown[]).concat(a.res.headers['set-cookie'])[0]);
    expect(raw).toMatch(/^hf_lipp_state=/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Max-Age=600');
    expect(JSON.stringify(a.res.headers)).not.toContain(CLIENT_SECRET);
  });

  it('start rejects an off-site `next` (no open redirect)', async () => {
    const app = server();
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/paypal/start?next=//evil.example',
    });
    expect(res.statusCode).toBe(400);
  });

  it('callback with a missing or mismatched state is rejected and never exchanges the code', async () => {
    const stub = new StubPayPalIdentity();
    const app = server(stub);
    const { state, cookie } = await start(app);
    const cookieHdr = `${LIPP_STATE_COOKIE}=${encodeURIComponent(cookie[LIPP_STATE_COOKIE]!)}`;

    const cases = [
      { url: `/api/auth/paypal/callback?code=stub-code`, cookie: cookieHdr }, // no state
      { url: `/api/auth/paypal/callback?code=stub-code&state=${state}` }, // no cookie
      { url: `/api/auth/paypal/callback?code=stub-code&state=${state}x`, cookie: cookieHdr },
      {
        url: `/api/auth/paypal/callback?code=stub-code&state=${state}`,
        cookie: `${LIPP_STATE_COOKIE}=forged.token`,
      },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: 'GET',
        url: c.url,
        headers: c.cookie ? { cookie: c.cookie } : {},
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/brand/sign-in?error=state');
      const set = setCookies(res);
      expect(set[BRAND_COOKIE]).toBeUndefined();
      expect(set[BRAND_PENDING_COOKIE]).toBeUndefined();
      expect(set[LIPP_STATE_COOKIE]).toBe('');
    }
    expect(stub.exchanged).toEqual([]);
  });

  it('error=access_denied → W02 cancelled state; other errors → failed', async () => {
    const stub = new StubPayPalIdentity();
    const app = server(stub);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/auth/paypal/callback?error=access_denied&error_description=User+cancelled',
    });
    expect(denied.statusCode).toBe(302);
    expect(denied.headers.location).toBe('/brand/sign-in?error=cancelled');
    const other = await app.inject({
      method: 'GET',
      url: '/api/auth/paypal/callback?error=server_error',
    });
    expect(other.headers.location).toBe('/brand/sign-in?error=failed');
    expect(stub.exchanged).toEqual([]);
  });

  it('a failed code exchange → failed, with no session', async () => {
    const stub = new StubPayPalIdentity(new Map());
    const app = server(stub);
    const { state, cookie } = await start(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/paypal/callback?code=stub-code&state=${state}`,
      headers: { cookie: `${LIPP_STATE_COOKIE}=${encodeURIComponent(cookie[LIPP_STATE_COOKIE]!)}` },
    });
    expect(res.headers.location).toBe('/brand/sign-in?error=failed');
    expect(setCookies(res)[BRAND_COOKIE]).toBeUndefined();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('LIPP callback (Postgres, HF-010)', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await tdb?.close();
  });

  const stub = new StubPayPalIdentity(
    new Map([
      ['code-new', identity('newbie@brand.example', { payerId: 'PAYERNEW', name: 'New Brand' })],
      ['code-verified', identity('Owner@Verified.Example')],
      ['code-pending', identity('owner@pending.example')],
      ['code-unverified', identity('who@brand.example', { emailVerified: false })],
      ['code-demo-owner', identity(DEMO_ACCOUNTS.ownerEmail)],
    ]),
  );

  function server(deps: ServerDeps = {}) {
    return buildServer(loadConfig(BASE_ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      paypalIdentity: stub,
      ...deps,
    });
  }

  /** Full start → callback round trip for `code`; returns the callback response. */
  async function signIn(app: ReturnType<typeof server>, code: string, startQuery = '') {
    const s = await app.inject({ method: 'GET', url: `/api/auth/paypal/start${startQuery}` });
    const state = new URL(String(s.headers.location)).searchParams.get('state')!;
    const stateCookie = setCookies(s)[LIPP_STATE_COOKIE]!;
    return app.inject({
      method: 'GET',
      url: `/api/auth/paypal/callback?code=${code}&state=${state}`,
      headers: { cookie: `${LIPP_STATE_COOKIE}=${encodeURIComponent(stateCookie)}` },
    });
  }

  async function seedBrand(email: string, status: 'VERIFIED' | 'PENDING') {
    await tdb.db.tx(async (tx) => {
      const b = await tx.query<{ id: string }>(
        `INSERT INTO brands (name, payout_email, verification_status, verified_at)
         VALUES ($1, $2, $3::text,
                 CASE WHEN $3 = 'VERIFIED' THEN now() END) RETURNING id`,
        [`Brand ${email}`, email, status],
      );
      await tx.query(`INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER')`, [
        b.rows[0]!.id,
        email,
      ]);
    });
  }

  async function brandUserCount(email: string): Promise<number> {
    const { rows } = await tdb.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM brand_users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0]!.n;
  }

  async function me(app: ReturnType<typeof server>, cookies: Record<string, string>) {
    const cookie = Object.entries(cookies)
      .filter(([, v]) => v)
      .map(([n, v]) => `${n}=${encodeURIComponent(v)}`)
      .join('; ');
    return (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  }

  it('new user → /brand/onboarding (W03) with the identity in the session only; no brand_users row', async () => {
    const app = server();
    const res = await signIn(app, 'code-new');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/brand/onboarding');
    const set = setCookies(res);
    expect(set[BRAND_COOKIE]).toBe(''); // any older brand session is dropped
    expect(set[BRAND_PENDING_COOKIE]).toBeTruthy();
    expect(set[BRAND_PENDING_COOKIE]).not.toContain('newbie');
    expect(await brandUserCount('newbie@brand.example')).toBe(0);

    const body = await me(app, { [BRAND_PENDING_COOKIE]: set[BRAND_PENDING_COOKIE]! });
    expect(body.brandUser).toBeNull();
    expect(body.pendingBrand).toEqual({
      email: 'newbie@brand.example',
      name: 'New Brand',
      hasPayerId: true,
    });
    // The payer id stays server side for HF-011b (`sessions.pendingBrand(req).payerId`).
    expect(JSON.stringify(body)).not.toContain('PAYERNEW');

    // A pending identity is not a brand session.
    const guarded = await app.inject({
      method: 'GET',
      url: '/api/listings',
      headers: {
        cookie: `${BRAND_PENDING_COOKIE}=${encodeURIComponent(set[BRAND_PENDING_COOKIE]!)}`,
      },
    });
    expect(guarded.statusCode).toBe(401);
  });

  it('returning verified user → /brand (W04) with a brand session; email match is case-insensitive', async () => {
    await seedBrand('owner@verified.example', 'VERIFIED');
    const app = server();
    const res = await signIn(app, 'code-verified');
    expect(res.headers.location).toBe('/brand');
    const set = setCookies(res);
    expect(set[BRAND_COOKIE]).toBeTruthy();
    expect(set[BRAND_PENDING_COOKIE]).toBe('');
    const body = await me(app, { [BRAND_COOKIE]: set[BRAND_COOKIE]! });
    expect(body.brandUser.email).toBe('owner@verified.example');
    expect(body.brandUser.brand.verificationStatus).toBe('VERIFIED');
    expect(body.pendingBrand).toBeNull();
  });

  it('returning verified user honours a same-origin `next`', async () => {
    const app = server();
    const res = await signIn(app, 'code-verified', '?next=%2Fbrand%2Flistings%2Fabc');
    expect(res.headers.location).toBe('/brand/listings/abc');
  });

  it('known user of a PENDING brand → /brand/onboarding with a brand session', async () => {
    await seedBrand('owner@pending.example', 'PENDING');
    const app = server();
    const res = await signIn(app, 'code-pending');
    expect(res.headers.location).toBe('/brand/onboarding');
    expect(setCookies(res)[BRAND_COOKIE]).toBeTruthy();
  });

  it('an unverified PayPal email is refused', async () => {
    const app = server();
    const res = await signIn(app, 'code-unverified');
    expect(res.headers.location).toBe('/brand/sign-in?error=unverified');
    const set = setCookies(res);
    expect(set[BRAND_COOKIE]).toBeUndefined();
    expect(set[BRAND_PENDING_COOKIE]).toBeUndefined();
  });

  it('a state is single use: replaying the callback is rejected', async () => {
    const app = server();
    const s = await app.inject({ method: 'GET', url: '/api/auth/paypal/start' });
    const state = new URL(String(s.headers.location)).searchParams.get('state')!;
    const first = await app.inject({
      method: 'GET',
      url: `/api/auth/paypal/callback?code=code-verified&state=${state}`,
      headers: {
        cookie: `${LIPP_STATE_COOKIE}=${encodeURIComponent(setCookies(s)[LIPP_STATE_COOKIE]!)}`,
      },
    });
    expect(first.headers.location).toBe('/brand');
    // The browser drops the cleared cookie; the replay arrives without it.
    const replay = await app.inject({
      method: 'GET',
      url: `/api/auth/paypal/callback?code=code-verified&state=${state}`,
    });
    expect(replay.headers.location).toBe('/brand/sign-in?error=state');
  });

  it('repeat and concurrent logins never create brand_users rows (unique lower(email))', async () => {
    const app = server();
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => signIn(app, 'code-new')),
      ...Array.from({ length: 6 }, () => signIn(app, 'code-verified')),
    ]);
    expect(results.slice(0, 6).every((r) => r.headers.location === '/brand/onboarding')).toBe(true);
    expect(results.slice(6).every((r) => r.headers.location === '/brand')).toBe(true);
    expect(await brandUserCount('newbie@brand.example')).toBe(0);
    expect(await brandUserCount('owner@verified.example')).toBe(1);
  });

  it('Part 1: DEMO_MODE OWNER and VIEWER buttons sign in to the verified demo brand', async () => {
    const app = server();
    for (const role of ['OWNER', 'VIEWER'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/demo/brand',
        headers: { 'idempotency-key': `demo-${role}` },
        payload: { role },
      });
      expect(res.statusCode).toBe(200);
      const set = setCookies(res);
      expect(set[BRAND_PENDING_COOKIE]).toBe('');
      const body = await me(app, { [BRAND_COOKIE]: set[BRAND_COOKIE]! });
      expect(body.brandUser.role).toBe(role);
      expect(body.brandUser.brand.verificationStatus).toBe('VERIFIED');
    }
    // And the demo owner signing in through PayPal lands on the same row.
    const res = await signIn(app, 'code-demo-owner');
    expect(res.headers.location).toBe('/brand');
    expect(await brandUserCount(DEMO_ACCOUNTS.ownerEmail)).toBe(1);
  });

  it('logout clears the pending identity too', async () => {
    const app = server();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'idempotency-key': 'logout-1', origin: 'http://localhost:3000' },
      payload: { who: 'brand' },
    });
    expect(res.statusCode).toBe(200);
    expect(setCookies(res)[BRAND_PENDING_COOKIE]).toBe('');
  });

  it('PAYPAL_MODE=stub: the default identity signs in as a not-yet-onboarded brand', async () => {
    const app = buildServer(loadConfig({ ...BASE_ENV, PAYPAL_MODE: 'stub' }), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
    });
    const s = await app.inject({ method: 'GET', url: '/api/auth/paypal/start' });
    const location = new URL(String(s.headers.location));
    expect(location.pathname).toBe('/api/auth/paypal/callback');
    const res = await app.inject({
      method: 'GET',
      url: location.pathname + location.search,
      headers: {
        cookie: `${LIPP_STATE_COOKIE}=${encodeURIComponent(setCookies(s)[LIPP_STATE_COOKIE]!)}`,
      },
    });
    expect(res.headers.location).toBe('/brand/onboarding');
    expect(await brandUserCount(STUB_LIPP_IDENTITY.email)).toBe(0);
  });
});
