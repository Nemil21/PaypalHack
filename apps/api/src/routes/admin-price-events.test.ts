/**
 * HF-042a route test: `POST /api/admin/replay-price-event` over HTTP on real Postgres with
 * `FakePayPal`: admin only, replays through the watcher's own path and labels the event. The
 * watcher logic is covered in packages/core/src/price-watch/process.test.ts. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/admin-price-events
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook, loadConfig, placeBid, type Channel3Product } from '@holdfast/core';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { Channel3Error } from '../../../../packages/core/src/channel3/errors.js';
import { FakePayPal } from '../../../../packages/core/src/paypal/fake.js';
import { BRAND_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';
import { REPLAY_PRICE_EVENT_PATH } from './admin-price-events.js';

const SECRET = 'c'.repeat(40);
const ADMIN_EMAIL = 'ops@holdfast.example';
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  ADMIN_EMAILS: ADMIN_EMAIL,
  APP_BASE_URL: 'http://localhost:3000',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-042a replay-price-event route', { timeout: 60_000 }, () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let listingId: string;
  let bidId: string;
  let ownerUser: string;
  let adminUser: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const cookie = (userId: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`;
  const replay = (userId: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url: REPLAY_PRICE_EVENT_PATH,
      headers: {
        cookie: cookie(userId),
        'idempotency-key': randomUUID(),
        origin: 'http://localhost:3000',
      },
      payload: body as Record<string, unknown>,
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const fake = new FakePayPal();
    const paypal = fake.client();
    const db = tdb.db;
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: db,
      db: db.pool,
      limiter: new RateLimiter(),
      priceWatch: {
        db,
        paypal,
        audit: auditHook,
        voidBackoffMs: [0, 0, 0],
        channel3: {
          product: async (): Promise<Channel3Product> => {
            throw new Channel3Error('NOT_FOUND', 'No such Channel3 product', 404);
          },
        },
      },
    });
    const brand = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email, authorized_domains, verification_status)
       VALUES ('Aurel Audio (demo)', 'payouts@aurel.example', '{bestbuy.com}', 'VERIFIED') RETURNING id`,
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (title, channel3_id, condition, best_public_price_cents,
                             best_public_merchant, best_public_offer_url, price_updated_at)
       VALUES ('Aurel A7', 'aurel-a7-route', 'NEW', 27900, 'bestbuy.com',
               'https://buy.trychannel3.com/a7', now()) RETURNING id`,
    );
    listingId = (
      await one<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, published_at,
                               window_opens_at, window_closes_at)
         VALUES ($1, $2, 'OPEN', 300, 19900, now(), now() - interval '1 hour', now() + interval '4 hours')
         RETURNING id`,
        [brand.id, product.id],
      )
    ).id;
    const shopper = await one<{ id: string }>(
      `INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`,
    );
    const placed = await placeBid(
      { db, paypal, voidBackoffMs: [0, 0, 0], audit: auditHook, allowTestCard: true },
      {
        shopperId: shopper.id,
        listingId,
        amountCents: 24_900,
        paymentMethod: 'TEST_CARD',
        source: 'OFFER_PAGE',
        idempotencyKey: randomUUID(),
      },
    );
    if (!placed.ok) throw new Error('hold failed');
    bidId = placed.bid.id;
    ownerUser = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
        [brand.id, `${randomUUID()}@aurel.example`],
      )
    ).id;
    const ops = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Ops', 'p@ops.example') RETURNING id`,
    );
    adminUser = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
        [ops.id, ADMIN_EMAIL],
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('a brand user (not in ADMIN_EMAILS) gets 403 and nothing is recorded', async () => {
    const res = await replay(ownerUser, { listingId, priceCents: 24_500 });
    expect(res.statusCode).toBe(403);
    expect(await one(`SELECT count(*)::int AS n FROM webhook_events`)).toEqual({ n: 0 });
  });

  it('validation: bad body → 422; a store off the allowlist → 422 DOMAIN_NOT_ALLOWED; unknown listing → 404', async () => {
    expect((await replay(adminUser, { priceCents: 'cheap' })).statusCode).toBe(422);
    const off = await replay(adminUser, { listingId, priceCents: 24_500, domain: 'grey.example' });
    expect(off.statusCode).toBe(422);
    expect(off.json()).toMatchObject({ error: { reason: 'DOMAIN_NOT_ALLOWED' } });
    expect(
      (await replay(adminUser, { listingId: randomUUID(), priceCents: 24_500 })).statusCode,
    ).toBe(404);
  });

  it('an admin replays a labelled drop: the bid is released with the cheaper offer', async () => {
    const res = await replay(adminUser, { listingId, priceCents: 24_500 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      replayed: true,
      label: 'replayed event (demo)',
      outcome: 'MATCHED',
      cheaper: { priceCents: 24_500, merchant: 'bestbuy.com' },
      releasedCount: 1,
      released: [{ bidId, status: 'VOIDED' }],
    });
    const ev = await one<{ payload: { replayed: boolean }; processed_at: Date | null }>(
      `SELECT payload, processed_at FROM webhook_events WHERE id = $1`,
      [res.json().eventId],
    );
    expect(ev.payload.replayed).toBe(true);
    expect(ev.processed_at).not.toBeNull();
  });
});
