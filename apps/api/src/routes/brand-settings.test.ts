/**
 * HF-056 W11 brand settings, integration tests against a real, freshly migrated Postgres:
 *   - DNS check with a mocked resolver (PENDING → 30 s throttle → VERIFIED → publish allowed);
 *   - invite flow: OWNER link → Log in with PayPal (stub) → join as VIEWER → console with Clear
 *     refused; DEMO_MODE join; roles and removal; tenancy;
 *   - allowlist round trip into `brands.authorized_domains` and the HF-009 gate (fixtures);
 *   - payout email change: OWNER + PayPal re-login, audited.
 * Needs TEST_DATABASE_URL; skipped when unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dnsTxtRecord, loadConfig, type TxtResolver } from '@holdfast/core';
import {
  createTestDatabase,
  StubPayPal,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import {
  BRAND_COOKIE,
  BRAND_PENDING_COOKIE,
  LIPP_STATE_COOKIE,
  PAYOUT_REAUTH_COOKIE,
} from '../auth/guards.js';
import { StubPayPalIdentity, type PayPalLoginIdentity } from '../auth/paypal-login.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'w'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  APP_BASE_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
  CHANNEL3_MODE: 'fixtures',
};

let n = 0;
const key = () => `settings-test-${++n}`;

function setCookies(res: { headers: Record<string, unknown> }): Record<string, string> {
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

const identity = (email: string): PayPalLoginIdentity => ({
  email,
  emailVerified: true,
  payerId: `PAYER-${email}`,
  name: 'Invitee',
});

describe.skipIf(!TEST_DATABASE_URL)('HF-056 brand settings (Postgres)', () => {
  let tdb: TestDatabase;
  const zone = new Map<string, string[][]>();
  const resolveTxt: TxtResolver = async (d) => {
    const r = zone.get(d);
    if (!r) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    return r;
  };
  let clock = Date.now();
  const lipp = new StubPayPalIdentity(new Map());

  function server(env: Record<string, string> = {}) {
    return buildServer(loadConfig({ ...ENV, ...env }), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      paypalIdentity: lipp,
      clear: { money: { db: tdb.db, paypal: new StubPayPal(), voidBackoffMs: [0, 0, 0] } },
      brandSettings: { resolveTxt, now: () => clock },
    });
  }
  let app: ReturnType<typeof server>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = server();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    tdb.db.pool.query<T>(sql, params).then((r) => r.rows);

  async function brandWith(
    opts: { name?: string; status?: string; domain?: string | null; domains?: string[] } = {},
  ) {
    const [b] = await q<{ id: string }>(
      `INSERT INTO brands (name, domain, payout_email, verification_status, authorized_domains)
       VALUES ($1, $2, 'payouts@aurel.example', $3, $4) RETURNING id`,
      [opts.name ?? 'JBL', opts.domain ?? null, opts.status ?? 'VERIFIED', opts.domains ?? []],
    );
    return b!.id;
  }
  async function member(brandId: string, role = 'OWNER') {
    const email = `u-${randomUUID()}@aurel.example`;
    const [u] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
      [brandId, email, role],
    );
    const token = signToken(SECRET, 'brand-session', { sub: u!.id, exp: Date.now() + 600_000 });
    return { id: u!.id, email, cookie: `${BRAND_COOKIE}=${token}` };
  }

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    cookie?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': key() }),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** Log in with PayPal (stub) as `who`; returns the callback response. */
  async function lippRoundTrip(who: PayPalLoginIdentity, startQuery: string, cookie = '') {
    const code = `code-${randomUUID()}`;
    lipp.identities.set(code, who);
    const s = await app.inject({
      method: 'GET',
      url: `/api/auth/paypal/start${startQuery}`,
      headers: cookie ? { cookie } : {},
    });
    const state = new URL(String(s.headers.location)).searchParams.get('state')!;
    const stateCookie = `${LIPP_STATE_COOKIE}=${setCookies(s)[LIPP_STATE_COOKIE]}`;
    return app.inject({
      method: 'GET',
      url: `/api/auth/paypal/callback?code=${code}&state=${state}`,
      headers: { cookie: [stateCookie, cookie].filter(Boolean).join('; ') },
    });
  }

  // --- DNS ----------------------------------------------------------------------------------------

  it('DNS check with a mocked resolver: PENDING, throttled 30 s, then VERIFIED and publishable', async () => {
    const domain = `aurel-${randomUUID().slice(0, 8)}.example`;
    const brandId = await brandWith({ status: 'PENDING', domain });
    const owner = await member(brandId);

    const first = await call('POST', '/api/brands/verification/check', owner.cookie);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      verificationStatus: 'PENDING',
      verified: false,
      lookup: 'NOT_FOUND',
      domain,
      cached: false,
    });
    expect(Date.parse(first.json().nextCheckAt) - Date.parse(first.json().checkedAt)).toBe(30_000);

    // The record goes live, but a re-check inside 30 s answers from the last lookup.
    zone.set(domain, [[dnsTxtRecord(SECRET, brandId)]]);
    clock += 10_000;
    const early = await call('POST', '/api/brands/verification/check', owner.cookie);
    expect(early.json()).toMatchObject({ verificationStatus: 'PENDING', cached: true });

    clock += 20_000;
    const ok = await call('POST', '/api/brands/verification/check', owner.cookie);
    expect(ok.json()).toMatchObject({
      verificationStatus: 'VERIFIED',
      verified: true,
      lookup: 'FOUND',
    });
    const me = await call('GET', '/api/me', owner.cookie);
    expect(me.json().brandUser.brand.verificationStatus).toBe('VERIFIED');
    const [audit] = await q<{ data: Record<string, unknown> }>(
      `SELECT data FROM audit_events WHERE brand_id = $1 AND action = 'BRAND_VERIFIED'`,
      [brandId],
    );
    expect(audit!.data).toMatchObject({ method: 'DNS_TXT', admin: false });
  });

  it('DNS check: signed out → 401; a brand without a domain → 409 NO_DOMAIN', async () => {
    expect((await call('POST', '/api/brands/verification/check')).statusCode).toBe(401);
    const owner = await member(await brandWith({ status: 'PENDING' }));
    const res = await call('POST', '/api/brands/verification/check', owner.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.reason).toBe('NO_DOMAIN');
  });

  // --- Invites ------------------------------------------------------------------------------------

  it('invite flow: copyable link → PayPal sign-in → VIEWER sees the console, Clear refused', async () => {
    const brandId = await brandWith();
    const owner = await member(brandId);
    const created = await call('POST', '/api/brands/me/invites', owner.cookie, { role: 'VIEWER' });
    expect(created.statusCode).toBe(201);
    const url = new URL(created.json().url);
    expect(url.origin + url.pathname).toBe('http://localhost:3000/brand/join');
    const token = url.hash.slice(1);
    expect(token).toMatch(/^hfi_/);

    // The owner sees it open; nobody else (VIEWER) sees open invites.
    const settings = await call('GET', '/api/brands/me/settings', owner.cookie);
    expect(settings.json().team.invites).toHaveLength(1);

    const preview = await call('POST', '/api/invites/preview', undefined, { token });
    expect(preview.json()).toEqual({
      brandName: 'JBL',
      role: 'VIEWER',
      state: 'OPEN',
      emailLocked: false,
    });

    // A new person signs in with PayPal from the join page and comes back to it.
    const email = `invitee-${randomUUID()}@example.com`;
    const cb = await lippRoundTrip(identity(email), '?next=/brand/join');
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/brand/join');
    const pending = `${BRAND_PENDING_COOKIE}=${setCookies(cb)[BRAND_PENDING_COOKIE]}`;

    const accepted = await call('POST', '/api/invites/accept', pending, { token });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      brandUser: { email, role: 'VIEWER', brand: { id: brandId } },
      alreadyMember: false,
    });
    const viewer = `${BRAND_COOKIE}=${setCookies(accepted)[BRAND_COOKIE]}`;
    expect(setCookies(accepted)[BRAND_PENDING_COOKIE]).toBe('');

    // Console: signed in as VIEWER, listings readable, Clear refused (and disabled in the UI).
    const me = await call('GET', '/api/me', viewer);
    expect(me.json().brandUser).toMatchObject({ email, role: 'VIEWER' });
    const [product] = await q<{ id: string }>(`INSERT INTO products DEFAULT VALUES RETURNING id`);
    const [listing] = await q<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, window_opens_at,
                             window_closes_at)
       VALUES ($1, $2, 'OPEN', 2, 10000, now(), now() + interval '1 day') RETURNING id`,
      [brandId, product!.id],
    );
    const list = await call('GET', '/api/listings', viewer);
    expect(list.statusCode).toBe(200);
    expect(list.json().listings.map((l: { listingId: string }) => l.listingId)).toContain(
      listing!.id,
    );
    const clear = await call('POST', `/api/listings/${listing!.id}/clear`, viewer, {
      quantity: 1,
    });
    expect(clear.statusCode).toBe(403);
    expect(clear.json().error.code).toBe('FORBIDDEN');
    // …and every OWNER / MANAGER settings action.
    expect((await call('POST', '/api/brands/me/invites', viewer, {})).statusCode).toBe(403);
    expect(
      (await call('PUT', '/api/brands/me/authorized-domains', viewer, { domains: [] })).statusCode,
    ).toBe(403);
    expect((await call('GET', '/api/brands/me/settings', viewer)).json().team.invites).toEqual([]);

    // The link is single use.
    const late = await lippRoundTrip(
      identity(`late-${randomUUID()}@example.com`),
      '?next=/brand/join',
    );
    const latePending = `${BRAND_PENDING_COOKIE}=${setCookies(late)[BRAND_PENDING_COOKIE]}`;
    const again = await call('POST', '/api/invites/accept', latePending, { token });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('INVITE_USED');
  });

  it('accept needs an identity; DEMO_MODE may join by typed email; bad tokens → 404', async () => {
    const brandId = await brandWith();
    const owner = await member(brandId);
    const created = await call('POST', '/api/brands/me/invites', owner.cookie, { role: 'MANAGER' });
    const token = new URL(created.json().url).hash.slice(1);
    const email = `demo-${randomUUID()}@example.com`;

    const anon = await call('POST', '/api/invites/accept', undefined, { token, email });
    expect(anon.statusCode).toBe(401);
    expect(
      (await call('POST', '/api/invites/preview', undefined, { token: 'nope' })).statusCode,
    ).toBe(404);

    const demo = server({ DEMO_MODE: 'true' });
    try {
      const res = await demo.inject({
        method: 'POST',
        url: '/api/invites/accept',
        headers: { 'idempotency-key': key() },
        payload: { token, email },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().brandUser).toMatchObject({ email, role: 'MANAGER' });
    } finally {
      await demo.close();
    }
  });

  it('roles: OWNER changes and removes; last OWNER protected; other brands are 404', async () => {
    const brandId = await brandWith();
    const owner = await member(brandId);
    const manager = await member(brandId, 'MANAGER');
    const viewer = await member(brandId, 'VIEWER');

    const promote = await call('PATCH', `/api/brands/me/team/${viewer.id}`, owner.cookie, {
      role: 'MANAGER',
    });
    expect(promote.json()).toEqual({ changed: true });
    expect(
      (await call('PATCH', `/api/brands/me/team/${viewer.id}`, manager.cookie, { role: 'OWNER' }))
        .statusCode,
    ).toBe(403);
    const demoteSelf = await call('PATCH', `/api/brands/me/team/${owner.id}`, owner.cookie, {
      role: 'VIEWER',
    });
    expect(demoteSelf.statusCode).toBe(409);
    expect(demoteSelf.json().error.reason).toBe('LAST_OWNER');

    const stranger = await member(await brandWith(), 'VIEWER');
    expect(
      (await call('DELETE', `/api/brands/me/team/${stranger.id}`, owner.cookie)).statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/api/brands/me/team/${viewer.id}`, owner.cookie)).statusCode,
    ).toBe(200);
    // The removed user's session stops working at once.
    expect((await call('GET', '/api/brands/me/settings', viewer.cookie)).statusCode).toBe(401);

    const team = (await call('GET', '/api/brands/me/settings', owner.cookie)).json().team;
    expect(team.members.map((m: { role: string }) => m.role)).toEqual(['OWNER', 'MANAGER']);
  });

  // --- Allowlist ----------------------------------------------------------------------------------

  it('allowlist round trip: persists to authorized_domains and the HF-009 gate uses it', async () => {
    const brandId = await brandWith({ domains: ['jbl.com'] });
    const manager = await member(brandId, 'MANAGER');
    const listing = (floorCents: number) =>
      call('POST', '/api/listings', manager.cookie, {
        channel3Id: 'r4bivjG',
        variant: 'Color=Green',
        mpn: 'JBLT770NCGRN',
        quantity: 10,
        floorCents,
        liquidationQuoteCents: 3800,
        windowHours: 48,
      });

    // jbl.com only: the $139 jcpenney.com offer is not an authorized price, so $139 is a valid floor.
    expect((await listing(13900)).statusCode).toBe(201);

    const put = await call('PUT', '/api/brands/me/authorized-domains', manager.cookie, {
      domains: ['jbl.com', 'https://www.JCPenney.com/p/1'],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({
      authorizedDomains: ['jbl.com', 'jcpenney.com'],
      changed: true,
      added: ['jcpenney.com'],
    });
    const [row] = await q<{ authorized_domains: string[] }>(
      `SELECT authorized_domains FROM brands WHERE id = $1`,
      [brandId],
    );
    expect(row!.authorized_domains).toEqual(['jbl.com', 'jcpenney.com']);
    expect((await call('GET', '/api/brands/me/settings', manager.cookie)).json()).toMatchObject({
      authorizedDomains: ['jbl.com', 'jcpenney.com'],
      maxAuthorizedDomains: 25,
    });

    // Now jcpenney.com's $139 is the cheapest authorized offer: a $139 floor is refused.
    const refused = await listing(13900);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({
      reason: 'FLOOR_NOT_BELOW_PUBLIC_PRICE',
      bestPublicPriceCents: 13900,
    });

    const tooMany = await call('PUT', '/api/brands/me/authorized-domains', manager.cookie, {
      domains: Array.from({ length: 26 }, (_, i) => `shop${i}.example`),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toMatchObject({ reason: 'TOO_MANY', max: 25 });
    const invalid = await call('PUT', '/api/brands/me/authorized-domains', manager.cookie, {
      domains: ['not a domain'],
    });
    expect(invalid.json().error).toMatchObject({
      reason: 'INVALID_DOMAIN',
      invalid: ['not a domain'],
    });
  });

  // --- Payout -------------------------------------------------------------------------------------

  it('payout email change: OWNER + PayPal re-login, audited; MANAGER and stale sessions refused', async () => {
    const brandId = await brandWith();
    const owner = await member(brandId);
    const manager = await member(brandId, 'MANAGER');

    // Without the re-login: refused.
    const bare = await call('POST', '/api/brands/me/payout-account', owner.cookie);
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.reason).toBe('REAUTH_REQUIRED');

    // A MANAGER's re-login is refused at the callback and at the endpoint.
    const mgrCb = await lippRoundTrip(identity('m@example.com'), '?purpose=payout', manager.cookie);
    expect(mgrCb.headers.location).toBe('/brand/settings?tab=payout&reauth=forbidden');
    expect(setCookies(mgrCb)[PAYOUT_REAUTH_COOKIE]).toBeUndefined();
    expect((await call('POST', '/api/brands/me/payout-account', manager.cookie)).statusCode).toBe(
      403,
    );

    // The OWNER re-logs in as the new PayPal business account; the brand session is untouched.
    const newEmail = `payouts-${randomUUID()}@business.example.com`;
    const cb = await lippRoundTrip(identity(newEmail), '?purpose=payout', owner.cookie);
    expect(cb.headers.location).toBe('/brand/settings?tab=payout&reauth=ok');
    expect(setCookies(cb)[BRAND_COOKIE]).toBeUndefined();
    const reauth = `${PAYOUT_REAUTH_COOKIE}=${setCookies(cb)[PAYOUT_REAUTH_COOKIE]}`;
    const both = `${owner.cookie}; ${reauth}`;

    expect((await call('GET', '/api/brands/me/settings', both)).json().payout).toEqual({
      email: 'payouts@aurel.example',
      pendingEmail: newEmail,
    });
    // Another OWNER can't use this OWNER's re-login.
    const owner2 = await member(brandId);
    expect(
      (await call('POST', '/api/brands/me/payout-account', `${owner2.cookie}; ${reauth}`))
        .statusCode,
    ).toBe(403);

    const changed = await call('POST', '/api/brands/me/payout-account', both);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ payoutEmail: newEmail, changed: true });
    expect(setCookies(changed)[PAYOUT_REAUTH_COOKIE]).toBe('');
    const [b] = await q<{ payout_email: string }>(`SELECT payout_email FROM brands WHERE id = $1`, [
      brandId,
    ]);
    expect(b!.payout_email).toBe(newEmail);
    const audits = await q<{ actor_id: string; data: Record<string, unknown> }>(
      `SELECT actor_id, data FROM audit_events
        WHERE brand_id = $1 AND action = 'BRAND_PAYOUT_EMAIL_CHANGED'`,
      [brandId],
    );
    expect(audits).toEqual([
      {
        actor_id: owner.id,
        data: {
          from: 'payouts@aurel.example',
          to: newEmail,
          via: 'paypal_relogin',
          inFlightListings: 0,
        },
      },
    ]);
  });

  // --- Notifications ------------------------------------------------------------------------------

  it('notifications: per-user switches, any role; unknown templates rejected', async () => {
    const viewer = await member(await brandWith(), 'VIEWER');
    const res = await call('PUT', '/api/brands/me/notifications', viewer.cookie, {
      prefs: { brand_cleared: { EMAIL: false } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().notifications.brand_cleared).toEqual({ EMAIL: false, PUSH: true });
    expect(
      (await call('GET', '/api/brands/me/settings', viewer.cookie)).json().notifications
        .brand_cleared,
    ).toEqual({ EMAIL: false, PUSH: true });
    expect(
      (
        await call('PUT', '/api/brands/me/notifications', viewer.cookie, {
          prefs: { won: { EMAIL: false } },
        })
      ).statusCode,
    ).toBe(400);
  });
});
