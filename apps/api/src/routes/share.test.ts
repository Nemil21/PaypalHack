/**
 * HF-055 share links and embed widget API through the real server (guards, CSRF, Idempotency-Key
 * store) on Postgres with the `FakePayPal` stub:
 *   - `GET /api/widget/:slug`: open / closed (D7) / unknown, CORS for any origin, nothing private;
 *   - `POST /api/offers/:slug/clicks`: one OFFER_CLICK per key, also under a concurrent replay;
 *   - the share link attributes the bid (`utmSource` → `bids.utm_source`) and the W10 stats count
 *     clicks, bids and held $ per source; tenancy on `GET /api/listings/:id/share`.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/share.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook, FakePayPal, loadConfig, OFFER_CLICK, type ShareStats } from '@holdfast/core';
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RATE_LIMITS, RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'w'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  PAYPAL_MODE: 'stub',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
};

describe.skipIf(!TEST_DATABASE_URL)('share links and widget (HF-055)', { timeout: 30_000 }, () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    const fake = new FakePayPal();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter({ ...RATE_LIMITS, rest: 10_000 }),
      bids: {
        money: {
          db: tdb.db,
          paypal: fake.client({ timeoutMs: 10_000, holdRetries: 1 }),
          audit: auditHook,
          voidBackoffMs: [0, 0, 0],
          allowTestCard: true,
        },
      },
    });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;

  async function sharedListing(cols: Parameters<Fixtures['listing']>[0] = {}) {
    const l = await fx.listing(cols);
    const slug = `aurel-a7-${l.id.slice(0, 8)}`;
    await tdb.db.pool.query(`UPDATE listings SET slug = $2 WHERE id = $1`, [l.id, slug]);
    const { brand_id } = await one<{ brand_id: string }>(
      `SELECT brand_id FROM listings WHERE id = $1`,
      [l.id],
    );
    return { id: l.id, slug, brandId: brand_id };
  }

  const brandCookie = async (brandId: string) => {
    const u = await one<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'VIEWER') RETURNING id`,
      [brandId, `${randomUUID()}@brand.example`],
    );
    return `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: u.id, exp: Date.now() + 60_000 })}`;
  };

  /** A fresh shopper: the cookie the offer page's first GET sets. */
  const shopperCookie = async (slug: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/offers/${slug}` });
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    return list.find((c) => c.startsWith(`${SHOPPER_COOKIE}=`))!.split(';')[0]!;
  };

  const click = (cookie: string, slug: string, body: unknown, key: string = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `/api/offers/${slug}/clicks`,
      headers: { cookie, 'idempotency-key': key },
      payload: body as Record<string, unknown>,
    });

  const clicksOn = async (listingId: string) =>
    (
      await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events WHERE listing_id = $1 AND action = $2`,
        [listingId, OFFER_CLICK],
      )
    ).n;

  const stats = async (cookie: string, listingId: string) =>
    app.inject({ method: 'GET', url: `/api/listings/${listingId}/share`, headers: { cookie } });

  it('widget status: open listing is biddable, any origin may read it, nothing private', async () => {
    const l = await sharedListing();
    const res = await app.inject({
      method: 'GET',
      url: `/api/widget/${l.slug}`,
      headers: { origin: 'https://aurelaudio.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.json()).toEqual({
      slug: l.slug,
      biddable: true,
      status: 'OPEN',
      brandName: 'Aurel Audio',
      productTitle: 'Aurel One',
    });
    expect(res.body).not.toMatch(/floor|cents|amount/i);
  });

  it('widget status: closed window, live rounds and cancelled are not biddable (D7)', async () => {
    const closed = await sharedListing({ closesInHours: -1 });
    const rounds = await sharedListing({ status: 'ROUNDS', roundsEndInHours: 2 });
    const cancelled = await sharedListing({ status: 'CANCELLED' });
    for (const l of [closed, rounds, cancelled]) {
      const res = await app.inject({ method: 'GET', url: `/api/widget/${l.slug}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().biddable).toBe(false);
    }
  });

  it('widget status: unknown and draft slugs → 404', async () => {
    const draft = await sharedListing({ status: 'DRAFT' });
    for (const slug of ['no-such-offer', draft.slug]) {
      const res = await app.inject({ method: 'GET', url: `/api/widget/${slug}` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('click: logged once per key, normalized; bad source 400, unknown slug 404', async () => {
    const l = await sharedListing();
    const cookie = await shopperCookie(l.slug);
    const key = randomUUID();
    const first = await click(cookie, l.slug, { source: 'Email', medium: 'widget' }, key);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ recorded: true, source: 'email' });
    // A retry of the same request replays the answer and logs nothing new.
    const again = await click(cookie, l.slug, { source: 'Email', medium: 'widget' }, key);
    expect(again.statusCode).toBe(201);
    expect(await clicksOn(l.id)).toBe(1);
    const row = await one<{ data: unknown; brand_id: string; actor_type: string }>(
      `SELECT data, brand_id, actor_type FROM audit_events WHERE listing_id = $1 AND action = $2`,
      [l.id, OFFER_CLICK],
    );
    expect(row).toEqual({
      data: { source: 'email', medium: 'widget' },
      brand_id: l.brandId,
      actor_type: 'SHOPPER',
    });

    expect((await click(cookie, l.slug, { source: '<script>' })).statusCode).toBe(400);
    expect((await click(cookie, 'no-such-offer', { source: 'email' })).statusCode).toBe(404);
    // CSRF: a cross-site POST is refused like every other mutating call.
    const cross = await app.inject({
      method: 'POST',
      url: `/api/offers/${l.slug}/clicks`,
      headers: { cookie, 'idempotency-key': randomUUID(), origin: 'https://evil.example' },
      payload: { source: 'email' },
    });
    expect(cross.statusCode).toBe(403);
    expect(await clicksOn(l.id)).toBe(1);
  });

  it('race: the same click sent 8 times at once is logged once', async () => {
    const l = await sharedListing();
    const cookie = await shopperCookie(l.slug);
    const key = randomUUID();
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => click(cookie, l.slug, { source: 'instagram' }, key)),
    );
    // The first lands; concurrent duplicates replay it or are told it is in progress.
    for (const a of answers) expect([201, 409]).toContain(a.statusCode);
    expect(answers.filter((a) => a.statusCode === 201).length).toBeGreaterThanOrEqual(1);
    expect(await clicksOn(l.id)).toBe(1);
  });

  it('share link attributes the bid and W10 stats count clicks, bids and held $ by source', async () => {
    const l = await sharedListing();
    const placeBid = (cookie: string, amountCents: number, utmSource?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/bids',
        headers: { cookie, 'idempotency-key': randomUUID() },
        payload: {
          listingId: l.id,
          amountCents,
          paymentMethod: 'TEST_CARD',
          ...(utmSource ? { utmSource } : {}),
        },
      });

    // Two email shoppers (one bids), one widget shopper who bids, one direct bid.
    const emailA = await shopperCookie(l.slug);
    const emailB = await shopperCookie(l.slug);
    const widget = await shopperCookie(l.slug);
    const direct = await shopperCookie(l.slug);
    expect((await click(emailA, l.slug, { source: 'email' })).statusCode).toBe(201);
    expect((await click(emailB, l.slug, { source: 'email' })).statusCode).toBe(201);
    expect((await click(widget, l.slug, { source: 'widget', medium: 'widget' })).statusCode).toBe(
      201,
    );

    const a = await placeBid(emailA, 22_900, 'email');
    expect(a.statusCode).toBe(201);
    expect(a.json().status).toBe('HELD');
    const w = await placeBid(widget, 21_500, 'widget');
    expect(w.json().status).toBe('HELD');
    expect((await placeBid(direct, 20_000)).json().status).toBe('HELD');

    const stored = await one<{ utm_source: string | null }>(
      `SELECT utm_source FROM bids WHERE id = $1`,
      [a.json().bidId],
    );
    expect(stored.utm_source).toBe('email');

    // The widget shopper cancels: the bid still counts as placed, but holds no money.
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/bids/${w.json().bidId}/cancel`,
      headers: { cookie: widget, 'idempotency-key': randomUUID() },
    });
    expect(cancel.statusCode).toBeLessThan(300);

    const viewer = await brandCookie(l.brandId);
    const res = await stats(viewer, l.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<ShareStats>();
    expect(body).toMatchObject({ listingId: l.id, slug: l.slug, status: 'OPEN', biddable: true });
    expect(body.sources).toEqual([
      { source: 'email', clicks: 2, bids: 1, heldCents: 22_900 },
      { source: 'widget', clicks: 1, bids: 1, heldCents: 0 },
      { source: 'direct', clicks: 0, bids: 1, heldCents: 20_000 },
    ]);
    expect(body.totals).toEqual({ clicks: 3, bids: 3, heldCents: 42_900 });
  });

  it('stats are tenant-scoped: another brand, a bad id and no session are refused', async () => {
    const mine = await sharedListing();
    const theirs = await sharedListing();
    const cookie = await brandCookie(mine.brandId);
    expect((await stats(cookie, theirs.id)).statusCode).toBe(404);
    expect((await stats(cookie, 'not-a-uuid')).statusCode).toBe(404);
    const anon = await app.inject({ method: 'GET', url: `/api/listings/${mine.id}/share` });
    expect(anon.statusCode).toBe(401);
    const empty = await stats(cookie, mine.id);
    expect(empty.json()).toMatchObject({
      sources: [],
      totals: { clicks: 0, bids: 0, heldCents: 0 },
    });
  });
});
