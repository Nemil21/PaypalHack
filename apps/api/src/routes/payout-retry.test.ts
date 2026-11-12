/**
 * HF-032 route test: `POST /api/admin/listings/:id/retry-payout` over HTTP on a real Postgres with
 * `FakePayPal` (admin only, 202 with attempt 2 after a DENIED payout, 409 while one is in flight,
 * 404 unknown) and the payout card in `GET /api/listings/:id/settlement`. v4 §3.1: the brand-side
 * `POST /api/listings/:id/retry-payout` (OWNER of that brand only, rate-limited). The payout logic itself
 * is covered in packages/core/src/payouts/payout-brand.test.ts. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/payout-retry
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadConfig,
  payoutBrand,
  pollPayouts,
  retryPayout,
  settleListing,
  type PayoutDeps,
} from '@holdfast/core';
import { settlementViewSchema } from '@holdfast/shared';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { FakePayPal } from '../../../../packages/core/src/paypal/fake.js';
import {
  seedClearedListing,
  type ClearedListing,
} from '../../../../packages/core/src/settlement/test-fixtures.js';
import { BRAND_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

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
};

describe.skipIf(!TEST_DATABASE_URL)('HF-032 retry-payout route', { timeout: 60_000 }, () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let fake: FakePayPal;
  let payouts: PayoutDeps;
  let seeded: ClearedListing;
  let ownerUser: string;
  let managerUser: string;
  let adminUser: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const cookie = (userId: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`;
  const retry = (userId: string, id = seeded.listingId) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/listings/${id}/retry-payout`,
      headers: { cookie: cookie(userId), 'idempotency-key': randomUUID() },
    });
  const brandRetry = (userId: string, id = seeded.listingId) =>
    app.inject({
      method: 'POST',
      url: `/api/listings/${id}/retry-payout`,
      headers: { cookie: cookie(userId), 'idempotency-key': randomUUID() },
    });
  const view = async (userId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/listings/${seeded.listingId}/settlement`,
      headers: { cookie: cookie(userId) },
    });
    expect(res.statusCode).toBe(200);
    return settlementViewSchema.parse(res.json());
  };
  const poll = () => pollPayouts(payouts, { resendAfterSeconds: 0, fundsRetryAfterSeconds: 0 });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fake = new FakePayPal();
    const client = fake.client();
    payouts = { db: tdb.db, paypal: client };
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      settlement: { retryPayout: (input) => retryPayout(payouts, input) },
    });
    seeded = await seedClearedListing(tdb.db, client, { winners: 3, reserve: 1, belowFloor: 1 });
    const settled = await settleListing(
      { db: tdb.db, paypal: client, sleep: async () => {}, payoutBrand: async () => {} },
      seeded.listingId,
    );
    expect(settled.outcome).toBe('SETTLED');
    const { brand_id } = await one<{ brand_id: string }>(
      `SELECT brand_id FROM listings WHERE id = $1`,
      [seeded.listingId],
    );
    ownerUser = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
        [brand_id, `${randomUUID()}@aurel.example`],
      )
    ).id;
    managerUser = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'MANAGER') RETURNING id`,
        [brand_id, `${randomUUID()}@aurel.example`],
      )
    ).id;
    const other = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Ops', 'p@ops.example') RETURNING id`,
    );
    adminUser = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
        [other.id, ADMIN_EMAIL],
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('409 while the first payout is in flight; the brand sees it on the payout card', async () => {
    await payoutBrand(payouts, seeded.listingId);
    const res = await retry(adminUser);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'STATE_CONFLICT', reason: 'PAYOUT_IN_FLIGHT', status: 'SETTLED' },
    });
    const v = await view(ownerUser);
    const gross = 30_000 + 29_900 + 29_800;
    expect(v.payout).toMatchObject({
      attempt: 1,
      status: 'PENDING',
      grossCents: gross,
      feeCents: 8_073,
      netCents: gross - 8_073,
    });
  });

  it('after a DENIED payout: brand users get 403, an admin gets 202 with attempt 2', async () => {
    const first = await one<{ paypal_batch_id: string }>(
      `SELECT paypal_batch_id FROM payouts WHERE listing_id = $1`,
      [seeded.listingId],
    );
    fake.settlePayout(first.paypal_batch_id, 'FAILED');
    await poll();
    expect((await view(ownerUser)).listingStatus).toBe('PAYOUT_FAILED');

    expect((await retry(ownerUser)).statusCode).toBe(403);
    const res = await retry(adminUser);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      listingId: seeded.listingId,
      attempt: 2,
      status: 'PENDING',
    });
    const audit = await one<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_events
        WHERE listing_id = $1 AND action = 'PAYOUT_RETRY'`,
      [seeded.listingId],
    );
    expect(audit).toEqual({ actor_type: 'ADMIN', actor_id: adminUser });
    expect((await retry(adminUser)).statusCode).toBe(409);

    await poll();
    await poll();
    const v = await view(ownerUser);
    expect(v.listingStatus).toBe('PAID_OUT');
    expect(v.payout).toMatchObject({ attempt: 2, status: 'SUCCESS', itemStatus: 'SUCCESS' });
  });

  it('404 for an unknown or malformed listing id', async () => {
    expect((await retry(adminUser, randomUUID())).statusCode).toBe(404);
    expect((await retry(adminUser, 'nope')).statusCode).toBe(404);
  });

  it('brand route: the OWNER retries a failed payout; others get 403/404; rate-limited', async () => {
    const latest = await one<{ paypal_batch_id: string }>(
      `SELECT paypal_batch_id FROM payouts WHERE listing_id = $1 ORDER BY attempt DESC LIMIT 1`,
      [seeded.listingId],
    );
    // Back to PAYOUT_FAILED: fail attempt 2's batch by hand (the fake already paid it).
    await tdb.db.pool.query(`UPDATE payouts SET status = 'FAILED' WHERE paypal_batch_id = $1`, [
      latest.paypal_batch_id,
    ]);
    await tdb.db.pool.query(`UPDATE listings SET status = 'PAYOUT_FAILED' WHERE id = $1`, [
      seeded.listingId,
    ]);

    expect((await brandRetry(managerUser)).statusCode).toBe(403);
    // Admin's own brand isn't the listing's: the brand route is scoped to the session brand.
    expect((await brandRetry(adminUser)).statusCode).toBe(404);
    expect((await brandRetry(ownerUser, randomUUID())).statusCode).toBe(404);
    expect((await brandRetry(ownerUser, 'nope')).statusCode).toBe(404);

    const res = await brandRetry(ownerUser);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ listingId: seeded.listingId, attempt: 3 });
    const audit = await one<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_events
        WHERE listing_id = $1 AND action = 'PAYOUT_RETRY'
        ORDER BY id DESC LIMIT 1`,
      [seeded.listingId],
    );
    expect(audit).toEqual({ actor_type: 'BRAND_USER', actor_id: ownerUser });

    // 3 per minute per user, counted before the handler: two 404s and the 202 used them up.
    expect((await brandRetry(ownerUser)).statusCode).toBe(429);
  });
});
