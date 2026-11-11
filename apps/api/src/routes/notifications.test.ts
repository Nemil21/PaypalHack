/**
 * HF-054a `GET /api/notifications`, `POST /api/notifications/:id/read` and `/read-all` through the
 * real server (guards, Idempotency-Key store): the shopper's own list with an unread count,
 * mark-as-read, another recipient's id → 404, and `?as=brand` for a brand user's brand.
 * Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/notifications
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, notify } from '@holdfast/core';
import type { NotificationsResponse } from '@holdfast/shared';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'n'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  CHANNEL3_MODE: 'fixtures',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-054a notifications API', { timeout: 60_000 }, () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let shopperA: string;
  let shopperB: string;
  let brandId: string;
  let brandUser: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const shopperCookie = (id: string) =>
    `${SHOPPER_COOKIE}=${signToken(SECRET, 'shopper-session', { sub: id, exp: Date.now() + 60_000 })}`;
  const brandCookie = (id: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: id, exp: Date.now() + 60_000 })}`;
  const list = async (cookie: string, as = '') => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/notifications${as}`,
      headers: { cookie },
    });
    return res;
  };
  const read = (cookie: string, id: string, as = '') =>
    app.inject({
      method: 'POST',
      url: `/api/notifications/${id}/read${as}`,
      headers: { cookie, 'idempotency-key': randomUUID() },
    });
  const lost = (recipientId: string, entityId = randomUUID()) =>
    notify(tdb.db.pool, {
      template: 'lost',
      recipientId,
      entityId,
      payload: { bidId: entityId, listingId: randomUUID(), amountCents: 22_900 },
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
    });
    shopperA = (await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`)).id;
    shopperB = (await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`)).id;
    brandId = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'p@aurel.example') RETURNING id`,
      )
    ).id;
    brandUser = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'VIEWER') RETURNING id`,
        [brandId, `${randomUUID()}@brand.example`],
      )
    ).id;
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('401 without a session', async () => {
    expect((await list('')).statusCode).toBe(401);
    expect((await list('', '?as=brand')).statusCode).toBe(401);
  });

  it("lists the shopper's own notifications with an unread count; mark-as-read", async () => {
    const n1 = (await lost(shopperA))!;
    await lost(shopperA);
    const other = (await lost(shopperB))!;

    let res = await list(shopperCookie(shopperA));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    let body = res.json<NotificationsResponse>();
    expect(body.notifications).toHaveLength(2);
    expect(body.unreadCount).toBe(2);
    expect(body.notifications[0]).toMatchObject({ template: 'lost', readAt: null });

    const r = await read(shopperCookie(shopperA), n1.id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: n1.id, unreadCount: 1 });

    // Another shopper's notification, an unknown id and a malformed id all 404.
    expect((await read(shopperCookie(shopperA), other.id)).statusCode).toBe(404);
    expect((await read(shopperCookie(shopperA), randomUUID())).statusCode).toBe(404);
    expect((await read(shopperCookie(shopperA), 'nope')).statusCode).toBe(404);

    const all = await app.inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: { cookie: shopperCookie(shopperA), 'idempotency-key': randomUUID() },
    });
    expect(all.json()).toEqual({ unreadCount: 0 });
    res = await list(shopperCookie(shopperB));
    body = res.json<NotificationsResponse>();
    expect(body.unreadCount).toBe(1);
  });

  it('?as=brand lists the brand user’s brand notifications, not a shopper list', async () => {
    const n = (await notify(tdb.db.pool, {
      template: 'brand_payout_failed',
      recipientId: brandId,
      entityId: randomUUID(),
      payload: { listingId: randomUUID() },
    }))!;
    const res = await list(brandCookie(brandUser), '?as=brand');
    expect(res.statusCode).toBe(200);
    const body = res.json<NotificationsResponse>();
    expect(body.notifications.map((x) => x.id)).toEqual([n.id]);
    expect(body.unreadCount).toBe(1);
    // A brand cookie alone is not a shopper session.
    expect((await list(brandCookie(brandUser))).statusCode).toBe(401);
    // The shopper can't mark the brand's row, the brand can.
    expect((await read(shopperCookie(shopperA), n.id)).statusCode).toBe(404);
    expect((await read(brandCookie(brandUser), n.id, '?as=brand')).statusCode).toBe(200);
  });
});
