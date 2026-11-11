/**
 * HF-060 order-timeline routes over HTTP on a real Postgres: guards and tenancy 404s. The facts
 * themselves are covered in packages/core/src/order-timeline.test.ts. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/order-timeline
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
import { orderTimeline, type OrderTimelineFacts } from '@holdfast/shared';
import {
  createTestDatabase,
  newAuthId,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'b'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-060 order-timeline routes', () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let listingId: string;
  let bidId: string;
  let viewer: string;
  let otherBrandUser: string;
  let owner: string;
  let stranger: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const brand = (userId: string) => ({
    cookie: `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`,
  });
  const shopper = (id: string) => ({
    cookie: `${SHOPPER_COOKIE}=${signToken(SECRET, 'shopper-session', { sub: id, exp: Date.now() + 60_000 })}`,
  });

  async function brandWithUser(role: string): Promise<{ brandId: string; userId: string }> {
    const brandId = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'p@aurel.example') RETURNING id`,
      )
    ).id;
    const userId = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
        [brandId, `${randomUUID()}@aurel.example`, role],
      )
    ).id;
    return { brandId, userId };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
    });
    const b = await brandWithUser('VIEWER');
    viewer = b.userId;
    otherBrandUser = (await brandWithUser('OWNER')).userId;
    const product = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel A7') RETURNING id`,
    );
    listingId = (
      await one<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                               window_opens_at, window_closes_at, clear_deadline_at)
         VALUES ($1, $2, 'OPEN', 5, 19900, now() - interval '1 hour', now() + interval '24 hours',
                 now() + interval '30 hours')
         RETURNING id`,
        [b.brandId, product.id],
      )
    ).id;
    owner = (await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`)).id;
    stranger = (await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`)).id;
    bidId = (
      await one<{ id: string }>(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key,
                           paypal_authorization_id, authorized_amount_cents, authorized_at,
                           release_if_cheaper)
         VALUES ($1, $2, 22900, 'HELD', gen_random_uuid()::text, $3, 22900, now(), true)
         RETURNING id`,
        [listingId, owner, newAuthId()],
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('a VIEWER reads the listing timeline (W06 / W09)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/timeline`,
      headers: brand(viewer),
    });
    expect(res.statusCode).toBe(200);
    const f = res.json() as OrderTimelineFacts;
    expect(f).toMatchObject({ audience: 'brand', listingStatus: 'OPEN', settlement: null });
    const window = orderTimeline(f, new Date(f.asOf))[0]!;
    expect(window).toMatchObject({ key: 'window', state: 'active', planned: true });
  });

  it('another brand, an unknown id and no session are refused', async () => {
    const other = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/timeline`,
      headers: brand(otherBrandUser),
    });
    expect(other.statusCode).toBe(404);
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/listings/${randomUUID()}/timeline`,
      headers: brand(viewer),
    });
    expect(unknown.statusCode).toBe(404);
    const anon = await app.inject({ method: 'GET', url: `/api/listings/${listingId}/timeline` });
    expect(anon.statusCode).toBe(401);
    const asShopper = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/timeline`,
      headers: shopper(owner),
    });
    expect(asShopper.statusCode).toBe(401);
  });

  it('the bid owner reads the bid timeline (W15); anyone else gets 404', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: `/api/bids/${bidId}/order-timeline`,
      headers: shopper(owner),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({
      audience: 'shopper',
      outcome: null,
      priceWatch: { on: true, events: 0 },
    });
    const theirs = await app.inject({
      method: 'GET',
      url: `/api/bids/${bidId}/order-timeline`,
      headers: shopper(stranger),
    });
    expect(theirs.statusCode).toBe(404);
    const malformed = await app.inject({
      method: 'GET',
      url: `/api/bids/not-a-bid/order-timeline`,
      headers: shopper(owner),
    });
    expect(malformed.statusCode).toBe(404);
  });
});
