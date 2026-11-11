/**
 * HF-019 offer page API through the real server (guards, CSRF, Idempotency-Key store) on Postgres
 * with the `FakePayPal` stub: `GET /api/offers/:slug`, the instant demo sign-in, and the offer
 * page's hold flows (test card, double click, two tabs, retry after a decline).
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/offers.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook, FakePayPal, loadConfig, type PayPalClient } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { SHOPPER_COOKIE } from '../auth/guards.js';
import { RATE_LIMITS, RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: 'q'.repeat(40),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  PAYPAL_MODE: 'stub',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
};

describe.skipIf(!TEST_DATABASE_URL)('offer page API (HF-019)', { timeout: 30_000 }, () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      // Generous: these tests make many calls from one shopper.
      limiter: new RateLimiter({ ...RATE_LIMITS, rest: 10_000 }),
      bids: {
        money: {
          db: tdb.db,
          paypal: client,
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

  async function offerListing(quantity = 3) {
    const l = await fx.listing();
    const slug = `aurel-a7-${l.id.slice(0, 8)}`;
    await tdb.db.pool.query(`UPDATE listings SET slug = $2, quantity = $3 WHERE id = $1`, [
      l.id,
      slug,
      quantity,
    ]);
    await tdb.db.pool.query(
      `UPDATE products p SET best_public_price_cents = 27900, best_public_merchant = 'retailer.example'
         FROM listings l WHERE l.product_id = p.id AND l.id = $1`,
      [l.id],
    );
    return { id: l.id, slug };
  }

  /** The shopper cookie from a response's Set-Cookie, as a Cookie header value. */
  const cookieOf = (res: { headers: Record<string, unknown> }): string => {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    const c = list.find((x) => x.startsWith(`${SHOPPER_COOKIE}=`));
    if (!c) throw new Error('no shopper cookie');
    return c.split(';')[0]!;
  };

  const getOffer = (slug: string, cookie?: string) =>
    app.inject({ method: 'GET', url: `/api/offers/${slug}`, headers: cookie ? { cookie } : {} });

  const postBid = (cookie: string, body: Record<string, unknown>, key: string = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/bids',
      headers: { cookie, 'idempotency-key': key },
      payload: body,
    });

  it('first visit binds an anonymous shopper; no floor in the body; floor changes change nothing', async () => {
    const l = await offerListing(2);
    for (const a of [24_900, 23_900, 21_900]) {
      await fx.heldBid(l.id, (await fx.shopper()).id, { amountCents: a });
    }
    const first = await getOffer(l.slug);
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const cookie = cookieOf(first);
    const shopperId = (
      await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    ).json().shopper.id;
    const row = await tdb.db.pool.query(`SELECT email FROM shoppers WHERE id = $1`, [shopperId]);
    expect(row.rows[0]).toEqual({ email: null });

    expect(first.json()).toMatchObject({
      listingId: l.id,
      suggestedBidCents: 22_900,
      likelyBand: { fromCents: 21_000, toCents: 25_000 },
      myBid: null,
    });
    expect(first.body).not.toMatch(/floor/i);

    const before = (await getOffer(l.slug, cookie)).body;
    for (const floor of [100, 23_000, 50_000]) {
      await tdb.db.pool.query(`UPDATE listings SET floor_cents = $2 WHERE id = $1`, [l.id, floor]);
      expect((await getOffer(l.slug, cookie)).body).toBe(before);
    }
  });

  it('unknown or draft slug → 404 NOT_FOUND', async () => {
    const res = await getOffer('no-such-offer');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('demo email sign-in binds the email to this browser at once, and loads it again later', async () => {
    const l = await offerListing();
    const cookie = cookieOf(await getOffer(l.slug));
    const email = `shopper-${randomUUID().slice(0, 8)}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/demo/shopper',
      headers: { cookie, 'idempotency-key': randomUUID() },
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shopper).toMatchObject({ email, provisional: false });
    const me = (
      await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(res) } })
    ).json();
    expect(me.shopper.email).toBe(email);

    // Another browser with the same email lands on the same shopper.
    const other = cookieOf(await getOffer(l.slug));
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/demo/shopper',
      headers: { cookie: other, 'idempotency-key': randomUUID() },
      payload: { email: email.toUpperCase() },
    });
    expect(again.json().shopper.id).toBe(res.json().shopper.id);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/demo/shopper',
      headers: { cookie, 'idempotency-key': randomUUID() },
      payload: { email: 'not-an-email' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('test-card hold from the offer page → HELD; the page then shows myBid; a second bid → ALREADY_BID', async () => {
    const l = await offerListing();
    const cookie = cookieOf(await getOffer(l.slug));
    const res = await postBid(cookie, {
      listingId: l.id,
      amountCents: 22_900,
      paymentMethod: 'TEST_CARD',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'HELD', amountCents: 22_900 });
    expect(res.json().publicOffer).toMatchObject({ priceCents: 27_900 });

    const view = (await getOffer(l.slug, cookie)).json();
    expect(view.myBid).toMatchObject({
      bidId: res.json().bidId,
      status: 'HELD',
      amountCents: 22_900,
    });

    const second = await postBid(cookie, {
      listingId: l.id,
      amountCents: 21_900,
      paymentMethod: 'TEST_CARD',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ code: 'ALREADY_BID', bidId: res.json().bidId });
  });

  it('confirming the above-public warning stores releaseIfCheaper=false', async () => {
    const l = await offerListing();
    const cookie = cookieOf(await getOffer(l.slug));
    const res = await postBid(cookie, {
      listingId: l.id,
      amountCents: 28_900,
      paymentMethod: 'TEST_CARD',
      releaseIfCheaper: false,
    });
    expect(res.statusCode).toBe(201);
    expect(await fx.bid(res.json().bidId)).toMatchObject({ release_if_cheaper: false });
    expect((await getOffer(l.slug, cookie)).json().myBid.releaseIfCheaper).toBe(false);
  });

  it('race (stub): double click (same key, concurrent) → one bid, one PayPal order', async () => {
    const l = await offerListing();
    const cookie = cookieOf(await getOffer(l.slug));
    const body = { listingId: l.id, amountCents: 22_900, paymentMethod: 'TEST_CARD' };
    const key = randomUUID();
    fake.latencyMs = 150;
    try {
      const results = await Promise.all([postBid(cookie, body, key), postBid(cookie, body, key)]);
      const statuses = results.map((r) => r.statusCode).sort();
      // The second click either waits and replays (201) or is told the first is running (409).
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);
      for (const r of results.filter((x) => x.statusCode === 409)) {
        expect(r.json().error.code).toBe('IN_PROGRESS');
      }
    } finally {
      fake.latencyMs = 0;
    }
    const rows = await tdb.db.pool.query(`SELECT id, status FROM bids WHERE listing_id = $1`, [
      l.id,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('HELD');
    expect(
      fake.calls.filter((c) => c.op === 'order_create' && c.requestId === rows.rows[0].id),
    ).toHaveLength(1);
  });

  it('race (stub): two tabs, different keys → exactly one HELD, the other ALREADY_BID', async () => {
    const l = await offerListing();
    const cookie = cookieOf(await getOffer(l.slug));
    fake.latencyMs = 100;
    let results;
    try {
      results = await Promise.all([
        postBid(cookie, { listingId: l.id, amountCents: 22_900, paymentMethod: 'TEST_CARD' }),
        postBid(cookie, { listingId: l.id, amountCents: 23_900, paymentMethod: 'TEST_CARD' }),
      ]);
    } finally {
      fake.latencyMs = 0;
    }
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe('ALREADY_BID');
    const held = await tdb.db.pool.query(
      `SELECT count(*)::int AS n FROM bids WHERE listing_id = $1 AND status = 'HELD'`,
      [l.id],
    );
    expect(held.rows[0].n).toBe(1);
  });

  it('after a declined hold, a retry with a new key succeeds; the page shows the new bid', async () => {
    const l = await offerListing();
    const cookie = cookieOf(await getOffer(l.slug));
    const body = { listingId: l.id, amountCents: 22_900, paymentMethod: 'TEST_CARD' };
    fake.failNext('order_create', { kind: 'decline' });
    const declined = await postBid(cookie, body);
    expect(declined.statusCode).toBe(422);
    expect(declined.json().error.code).toBe('HOLD_FAILED');
    expect((await getOffer(l.slug, cookie)).json().myBid).toBeNull();

    const retry = await postBid(cookie, body); // new key: the client mints one after a terminal failure
    expect(retry.statusCode).toBe(201);
    expect(retry.json().status).toBe('HELD');
    expect(retry.json().bidId).not.toBe(declined.json().error.bidId);
    expect((await getOffer(l.slug, cookie)).json().myBid.bidId).toBe(retry.json().bidId);
  });
});
