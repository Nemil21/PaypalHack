/**
 * HF-011b W03 onboarding: `POST/GET /api/brands/verification` against a real, freshly migrated
 * Postgres. Covers the upsert (back/next and "save and exit" re-POSTs, concurrent first POSTs),
 * the session re-issue, another brand's domain → DUPLICATE, the locked payout email, and the
 * full create → admin verify → publish → offer badge path (with HF-011a and HF-012a).
 * Needs TEST_DATABASE_URL; skipped when unset:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/brand-verification.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dnsTxtRecord, loadConfig } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, BRAND_PENDING_COOKIE } from '../auth/guards.js';
import { sealPending } from '../auth/paypal-login.js';
import { RATE_LIMITS, RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'v'.repeat(40);
const ADMIN = 'ops@holdfast.example';
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  CHANNEL3_MODE: 'fixtures',
  ADMIN_EMAILS: ADMIN,
};

let n = 0;
const key = () => `w03-${++n}`;

/** Set-Cookie headers by name ('' when the cookie is being cleared). */
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

/** HF-010's pending identity cookie for a LIPP login with no brand_users row yet. */
function pendingCookie(email: string, payerId: string | null = `PAYER-${randomUUID()}`) {
  const sealed = sealPending(SECRET, { email, payerId, name: 'Pat', exp: Date.now() + 600_000 });
  return `${BRAND_PENDING_COOKIE}=${encodeURIComponent(sealed)}`;
}

const brandCookieFrom = (res: { headers: Record<string, unknown> }) => {
  const v = setCookies(res)[BRAND_COOKIE];
  return v ? `${BRAND_COOKIE}=${encodeURIComponent(v)}` : null;
};

const uniq = () => randomUUID().slice(0, 8);

describe.skipIf(!TEST_DATABASE_URL)('HF-011b brand onboarding (Postgres)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      // Pending callers are keyed by IP, and every inject shares one.
      limiter: new RateLimiter({ ...RATE_LIMITS, rest: 10_000 }),
    });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    tdb.db.pool.query<T>(sql, params).then((r) => r.rows);

  const post = (cookie: string | null, payload: Record<string, unknown>, idem = key()) =>
    app.inject({
      method: 'POST',
      url: '/api/brands/verification',
      headers: { ...(cookie ? { cookie } : {}), 'idempotency-key': idem },
      payload,
    });
  const get = (cookie: string | null) =>
    app.inject({
      method: 'GET',
      url: '/api/brands/verification',
      headers: cookie ? { cookie } : {},
    });

  const brandsFor = (email: string) =>
    q<{ id: string; name: string; domain: string; status: string }>(
      `SELECT b.id, b.name, b.domain, b.verification_status AS status
         FROM brands b JOIN brand_users bu ON bu.brand_id = b.id WHERE lower(bu.email) = $1`,
      [email],
    );
  const audits = (brandId: string) =>
    q<{ action: string }>(
      `SELECT action FROM audit_events WHERE brand_id = $1 AND entity = 'brand' ORDER BY at, id`,
      [brandId],
    ).then((r) => r.map((x) => x.action));

  it('step 1 from a pending LIPP identity: PENDING brand + OWNER row, payer id, audit, DNS token, brand session', async () => {
    const email = `new-${uniq()}@business.example.com`;
    const pending = pendingCookie(email, `PAYER-${uniq()}`);
    const domain = `aurel-${uniq()}.example`;
    const res = await post(pending, {
      name: 'Aurel Audio',
      domain: ` HTTPS://www.${domain}/shop `,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      name: 'Aurel Audio',
      domain,
      payoutEmail: email,
      verificationStatus: 'PENDING',
      created: true,
    });
    expect(body.dnsTxtRecord).toBe(dnsTxtRecord(SECRET, body.brandId));
    expect(body.dnsTxtRecord).toMatch(/^holdfast-verify=[0-9a-f]{32}$/);

    const [row] = await q<{ payer: string; role: string; payout: string }>(
      `SELECT b.paypal_payer_id AS payer, bu.role, b.payout_email AS payout
         FROM brands b JOIN brand_users bu ON bu.brand_id = b.id WHERE b.id = $1`,
      [body.brandId],
    );
    expect(row).toMatchObject({ role: 'OWNER', payout: email });
    expect(row!.payer).toMatch(/^PAYER-/);
    expect(await audits(body.brandId)).toEqual(['BRAND_CREATED']);

    // Same response: brand session issued, pending identity cleared.
    const cookies = setCookies(res);
    expect(cookies[BRAND_COOKIE]).toBeTruthy();
    expect(cookies[BRAND_PENDING_COOKIE]).toBe('');

    // Brand endpoints work without signing in again.
    const brand = brandCookieFrom(res)!;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: brand } });
    expect(me.json().brandUser).toMatchObject({
      role: 'OWNER',
      brand: { id: body.brandId, verificationStatus: 'PENDING' },
    });
    const listings = await app.inject({
      method: 'GET',
      url: '/api/listings',
      headers: { cookie: brand },
    });
    expect(listings.statusCode).toBe(200);
  });

  it('back/next and "save and exit" re-POSTs update the same brand, never a second one or a self-DUPLICATE', async () => {
    const email = `back-${uniq()}@business.example.com`;
    const pending = pendingCookie(email);
    const domain = `back-${uniq()}.example`;
    const first = await post(pending, { name: 'Back Co', domain });
    expect(first.statusCode).toBe(201);
    const brandId = first.json().brandId;
    const brand = brandCookieFrom(first)!;

    // Re-POST from the brand session, same details: unchanged, 200, no new audit row.
    const again = await post(brand, { name: 'Back Co', domain, payoutEmail: email });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ brandId, created: false, domain });

    // Back to step 1, edit the name and domain: same brand, updated, audited.
    const domain2 = `back2-${uniq()}.example`;
    const edited = await post(brand, { name: 'Back Company', domain: domain2 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ brandId, name: 'Back Company', domain: domain2 });

    // The first response's cookie was lost: a re-POST still carrying the pending identity
    // (new key) lands on the same brand too, and gets the brand session.
    const lost = await post(pending, { name: 'Back Company', domain: domain2 });
    expect(lost.statusCode).toBe(200);
    expect(lost.json().brandId).toBe(brandId);
    expect(brandCookieFrom(lost)).toBeTruthy();

    expect(await brandsFor(email)).toHaveLength(1);
    expect(await audits(brandId)).toEqual(['BRAND_CREATED', 'BRAND_UPDATED']);
  });

  it('same Idempotency-Key replays the stored answer and still re-issues the session', async () => {
    const email = `replay-${uniq()}@business.example.com`;
    const pending = pendingCookie(email);
    const idem = key();
    const payload = { name: 'Replay Co', domain: `replay-${uniq()}.example` };
    const a = await post(pending, payload, idem);
    const b = await post(pending, payload, idem);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(brandCookieFrom(b)).toBeTruthy();
    expect(await brandsFor(email)).toHaveLength(1);
  });

  it('race: five concurrent first POSTs from one login → one brand, one OWNER, no DUPLICATE', async () => {
    const email = `race-${uniq()}@business.example.com`;
    const pending = pendingCookie(email);
    const domain = `race-${uniq()}.example`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(pending, { name: 'Race Co', domain })),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.json().brandId)).size).toBe(1);
    const brands = await brandsFor(email);
    expect(brands).toHaveLength(1);
    expect(await audits(brands[0]!.id)).toEqual(['BRAND_CREATED']);
  });

  it("another brand's domain → 409 DUPLICATE (also when two new brands race for it)", async () => {
    const domain = `taken-${uniq()}.example`;
    const owner = await post(pendingCookie(`a-${uniq()}@biz.example`), { name: 'A', domain });
    expect(owner.statusCode).toBe(201);

    const intruder = await post(pendingCookie(`b-${uniq()}@biz.example`), {
      name: 'B',
      domain: `https://WWW.${domain}/`,
    });
    expect(intruder.statusCode).toBe(409);
    expect(intruder.json().error).toMatchObject({ code: 'DUPLICATE', field: 'domain' });
    expect(setCookies(intruder)[BRAND_COOKIE]).toBeUndefined();

    const contested = `contested-${uniq()}.example`;
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        post(pendingCookie(`c${i}-${uniq()}@biz.example`), { name: `C${i}`, domain: contested }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().error.code).toBe('DUPLICATE');
    }
    expect(await q(`SELECT 1 FROM brands WHERE domain = $1`, [contested])).toHaveLength(1);
  });

  it('payout email is locked to the login email; bad input and no session are rejected', async () => {
    const email = `lock-${uniq()}@business.example.com`;
    const pending = pendingCookie(email);
    const typo = await post(pending, {
      name: 'Lock Co',
      domain: `lock-${uniq()}.example`,
      payoutEmail: 'someone-else@business.example.com',
    });
    expect(typo.statusCode).toBe(400);
    expect(typo.json().error).toMatchObject({
      field: 'payoutEmail',
      reason: 'PAYOUT_EMAIL_LOCKED',
    });

    const badDomain = await post(pending, { name: 'Lock Co', domain: 'not a domain' });
    expect(badDomain.statusCode).toBe(400);
    expect(badDomain.json().error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'domain' });
    expect(await brandsFor(email)).toHaveLength(0);

    const anon = await post(null, { name: 'X', domain: 'x.example' });
    expect(anon.statusCode).toBe(401);
    expect((await get(null)).statusCode).toBe(401);
  });

  it('GET: pending without a brand → brand null; after step 1 a reload re-issues the session', async () => {
    const email = `get-${uniq()}@business.example.com`;
    const pending = pendingCookie(email);
    const before = await get(pending);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ loginEmail: email, brand: null, isAdmin: false });

    const created = await post(pending, { name: 'Get Co', domain: `get-${uniq()}.example` });
    const reload = await get(pending);
    expect(reload.json().brand).toMatchObject({
      brandId: created.json().brandId,
      verificationStatus: 'PENDING',
    });
    expect(reload.json().brand.dnsTxtRecord).toBe(created.json().dnsTxtRecord);
    expect(brandCookieFrom(reload)).toBeTruthy();
    expect(setCookies(reload)[BRAND_PENDING_COOKIE]).toBe('');
  });

  it('create → admin "Verify now" → publish allowed → Verified badge on the offer page', async () => {
    // The admin onboards their own brand (the demo path: ADMIN_EMAILS holds the LIPP email).
    const res = await post(pendingCookie(ADMIN), { name: 'JBL', domain: `jbl-${uniq()}.example` });
    expect(res.statusCode, res.body).toBe(201);
    const brandId = res.json().brandId;
    const brand = brandCookieFrom(res)!;
    expect((await get(brand)).json()).toMatchObject({ isAdmin: true, role: 'OWNER' });

    const draft = await app.inject({
      method: 'POST',
      url: '/api/listings',
      headers: { cookie: brand, 'idempotency-key': key() },
      payload: {
        channel3Id: 'r4bivjG',
        variant: 'Color=Green',
        mpn: 'JBLT770NCGRN',
        quantity: 10,
        floorCents: 9900,
        liquidationQuoteCents: 3800,
        windowHours: 48,
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const listingId = draft.json().listingId;
    const publish = () =>
      app.inject({
        method: 'POST',
        url: `/api/listings/${listingId}/publish`,
        headers: { cookie: brand, 'idempotency-key': key() },
      });
    const blocked = await publish();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('BRAND_NOT_VERIFIED');

    const verify = await app.inject({
      method: 'POST',
      url: `/api/admin/brands/${brandId}/verify`,
      headers: { cookie: brand, 'idempotency-key': key() },
    });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json()).toMatchObject({ verificationStatus: 'VERIFIED' });
    expect(await audits(brandId)).toEqual(['BRAND_CREATED', 'BRAND_VERIFIED']);

    // The W03 reload shows VERIFIED; an unchanged re-POST is a no-op, a domain change is refused.
    expect((await get(brand)).json().brand.verificationStatus).toBe('VERIFIED');
    const domain = res.json().domain;
    expect((await post(brand, { name: 'JBL', domain })).statusCode).toBe(200);
    const change = await post(brand, { name: 'JBL', domain: `other-${uniq()}.example` });
    expect(change.statusCode).toBe(409);
    expect(change.json().error).toMatchObject({ code: 'STATE_CONFLICT', reason: 'BRAND_VERIFIED' });

    const published = await publish();
    expect(published.statusCode, published.body).toBe(200);
    const offer = await app.inject({
      method: 'GET',
      url: `/api/offers/${published.json().slug}`,
    });
    expect(offer.statusCode, offer.body).toBe(200);
    expect(offer.json().brand).toMatchObject({ name: 'JBL', verified: true });
  });

  it('a non-OWNER brand user cannot change the brand (403)', async () => {
    const email = `owner-${uniq()}@biz.example`;
    const created = await post(pendingCookie(email), {
      name: 'Team',
      domain: `team-${uniq()}.example`,
    });
    const brandId = created.json().brandId;
    const viewerEmail = `viewer-${uniq()}@biz.example`;
    const [u] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'VIEWER') RETURNING id`,
      [brandId, viewerEmail],
    );
    const viewer = await post(pendingCookie(viewerEmail), {
      name: 'Hijack',
      domain: `h-${uniq()}.example`,
    });
    expect(viewer.statusCode).toBe(403);
    expect(u).toBeTruthy();
    expect((await brandsFor(email))[0]!.name).toBe('Team');
  });
});
