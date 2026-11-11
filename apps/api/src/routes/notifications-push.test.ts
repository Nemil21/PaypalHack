/**
 * HF-054b `POST /api/notifications/subscribe`, `/unsubscribe` and `/push-test` through the real
 * server: a shopper's and a brand user's device are stored against the session's recipient (the
 * brand device also records the user), bad subscriptions are refused, push off answers
 * PUSH_NOT_CONFIGURED, and the test push reaches only the caller's own devices, throttled.
 * Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/notifications
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type PushSender } from '@holdfast/core';
import type { PushMessage } from '@holdfast/shared';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'p'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  CHANNEL3_MODE: 'fixtures',
};

const device = () => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
  // Random per test: shaped like real keys, never a literal the secret scan flags.
  keys: {
    p256dh: randomBytes(65).toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  },
});

describe.skipIf(!TEST_DATABASE_URL)('HF-054b push subscription API', { timeout: 60_000 }, () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let off: FastifyInstance;
  let clock = 0;
  const sent: { endpoint: string; message: PushMessage }[] = [];
  const push: PushSender = {
    async send(sub, payload) {
      sent.push({ endpoint: sub.endpoint, message: JSON.parse(payload) as PushMessage });
      return 'OK';
    },
  };
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
  const post = (server: FastifyInstance, url: string, cookie: string, payload?: unknown) =>
    server.inject({
      method: 'POST',
      url,
      headers: { cookie, 'idempotency-key': randomUUID() },
      payload: payload as object,
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const base = { webDistDir: null, sql: tdb.db, db: tdb.db.pool };
    app = buildServer(loadConfig(ENV), {
      ...base,
      limiter: new RateLimiter(),
      notifications: { push, now: () => clock },
    });
    off = buildServer(loadConfig(ENV), { ...base, limiter: new RateLimiter() });
    shopperA = (await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`)).id;
    shopperB = (await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`)).id;
    brandId = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'p@aurel.example') RETURNING id`,
      )
    ).id;
    brandUser = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
        [brandId, `${randomUUID()}@brand.example`],
      )
    ).id;
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await off?.close();
    await tdb?.close();
  });

  it('401 without a session; 409 PUSH_NOT_CONFIGURED without VAPID keys', async () => {
    expect(
      (await post(app, '/api/notifications/subscribe', '', { subscription: device() })).statusCode,
    ).toBe(401);
    const res = await post(off, '/api/notifications/subscribe', shopperCookie(shopperA), {
      subscription: device(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'STATE_CONFLICT', reason: 'PUSH_NOT_CONFIGURED' },
    });
  });

  it('refuses a malformed subscription', async () => {
    for (const subscription of [
      null,
      { endpoint: 'http://insecure.example/x', keys: device().keys },
      { endpoint: device().endpoint, keys: { p256dh: '<script>', auth: 'x' } },
    ]) {
      const res = await post(app, '/api/notifications/subscribe', shopperCookie(shopperA), {
        subscription,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('stores shopper and brand devices against the session; test push reaches only them', async () => {
    const a = device();
    const b = device();
    const brandPhone = device();
    expect(
      (
        await post(app, '/api/notifications/subscribe', shopperCookie(shopperA), {
          subscription: a,
        })
      ).json(),
    ).toEqual({ subscribed: true });
    await post(app, '/api/notifications/subscribe', shopperCookie(shopperB), { subscription: b });
    await post(app, '/api/notifications/subscribe?as=brand', brandCookie(brandUser), {
      subscription: brandPhone,
    });
    const row = await one<{ recipient_type: string; recipient_id: string; brand_user_id: string }>(
      `SELECT recipient_type, recipient_id, brand_user_id FROM push_subscriptions WHERE endpoint = $1`,
      [brandPhone.endpoint],
    );
    expect(row).toEqual({
      recipient_type: 'BRAND',
      recipient_id: brandId,
      brand_user_id: brandUser,
    });

    sent.length = 0;
    const t = await post(app, '/api/notifications/push-test', shopperCookie(shopperA));
    expect(t.json()).toEqual({ devices: 1, sent: 1, failed: 0 });
    expect(sent.map((s) => s.endpoint)).toEqual([a.endpoint]);
    expect(sent[0]!.message).toMatchObject({ url: '/notifications', tag: 'push-test' });
    // Throttled per recipient.
    expect(
      (await post(app, '/api/notifications/push-test', shopperCookie(shopperA))).statusCode,
    ).toBe(429);
    clock += 10_000;

    sent.length = 0;
    await post(app, '/api/notifications/push-test?as=brand', brandCookie(brandUser));
    expect(sent.map((s) => s.endpoint)).toEqual([brandPhone.endpoint]);
    expect(sent[0]!.message.url).toBe('/brand/notifications');

    // Unsubscribe: someone else's endpoint changes nothing; their own revokes it.
    await post(app, '/api/notifications/unsubscribe', shopperCookie(shopperB), {
      endpoint: a.endpoint,
    });
    sent.length = 0;
    await post(app, '/api/notifications/push-test', shopperCookie(shopperA));
    expect(sent).toHaveLength(1);
    await post(app, '/api/notifications/unsubscribe', shopperCookie(shopperA), {
      endpoint: a.endpoint,
    });
    clock += 10_000;
    sent.length = 0;
    expect(
      (await post(app, '/api/notifications/push-test', shopperCookie(shopperA))).json(),
    ).toEqual({
      devices: 0,
      sent: 0,
      failed: 0,
    });
  });
});
