/**
 * HF-030a route tests: `GET /api/listings/:id/settlement` and
 * `POST /api/admin/listings/:id/retry-settlement` over HTTP on a real Postgres (guards, tenancy,
 * the SettlementView schema, admin-only retry, 409 once SETTLED). The coordinator itself is
 * covered in packages/core/src/settlement/settle-listing.test.ts. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/settlement
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type KickSettlement } from '@holdfast/core';
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

describe.skipIf(!TEST_DATABASE_URL)('HF-030a settlement routes', () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let seeded: ClearedListing;
  let ownerUser: string;
  let otherBrandUser: string;
  let adminUser: string;
  const kicks: string[] = [];

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const cookie = (userId: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`;

  async function brandUser(brandId: string, email: string, role = 'OWNER'): Promise<string> {
    return (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
        [brandId, email, role],
      )
    ).id;
  }
  async function newBrand(): Promise<string> {
    return (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('Other', 'p@other.example') RETURNING id`,
      )
    ).id;
  }

  const getView = (userId: string | null, id = seeded.listingId) =>
    app.inject({
      method: 'GET',
      url: `/api/listings/${id}/settlement`,
      headers: userId ? { cookie: cookie(userId) } : {},
    });
  const retry = (userId: string, id = seeded.listingId) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/listings/${id}/retry-settlement`,
      headers: { cookie: cookie(userId), 'idempotency-key': randomUUID() },
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const kick: KickSettlement = ({ listingId }) => {
      kicks.push(listingId);
    };
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      settlement: { kick },
    });
    const fake = new FakePayPal();
    seeded = await seedClearedListing(tdb.db, fake.client(), {
      winners: 3,
      reserve: 2,
      belowFloor: 1,
    });
    const { brand_id } = await one<{ brand_id: string }>(
      `SELECT brand_id FROM listings WHERE id = $1`,
      [seeded.listingId],
    );
    ownerUser = await brandUser(brand_id, `${randomUUID()}@aurel.example`, 'VIEWER');
    const other = await newBrand();
    otherBrandUser = await brandUser(other, `${randomUUID()}@other.example`);
    adminUser = await brandUser(other, ADMIN_EMAIL);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('GET: a brand VIEWER reads the SettlementView of their listing', async () => {
    const res = await getView(ownerUser);
    expect(res.statusCode).toBe(200);
    const view = settlementViewSchema.parse(res.json());
    expect(view).toMatchObject({
      listingId: seeded.listingId,
      listingStatus: 'CLEARING',
      quantity: 3,
      clearedCents: 30_000 + 29_900 + 29_800,
      capturedCents: 0,
      counts: { total: 6, queued: 6 },
      payout: null,
    });
    expect(view.rows).toHaveLength(6);
  });

  it('GET: another brand gets 404, no session 401; an admin reads any listing', async () => {
    expect((await getView(otherBrandUser)).statusCode).toBe(404);
    expect((await getView(ownerUser, 'not-a-uuid')).statusCode).toBe(404);
    expect((await getView(null)).statusCode).toBe(401);
    expect((await getView(adminUser)).statusCode).toBe(200);
  });

  it('POST retry: admins only; 202 with counts and a kick while CLEARING', async () => {
    expect((await retry(ownerUser)).statusCode).toBe(403);
    await tdb.db.pool.query(
      `UPDATE settlements SET status = 'RETRY', next_attempt_at = now() + interval '1 hour'
        WHERE id = $1`,
      [seeded.winners[0]!.settlementId],
    );
    const res = await retry(adminUser);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      listingId: seeded.listingId,
      runId: seeded.runId,
      retried: 1,
      staleRunning: 0,
      kicked: true,
    });
    expect(kicks).toEqual([seeded.listingId]);
    const audit = await one<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_events
        WHERE listing_id = $1 AND action = 'SETTLEMENT_RETRY_REQUESTED'`,
      [seeded.listingId],
    );
    expect(audit).toEqual({ actor_type: 'ADMIN', actor_id: adminUser });
  });

  it('POST retry: 409 once SETTLED; 404 for an unknown listing', async () => {
    await tdb.db.pool.query(`UPDATE listings SET status = 'SETTLED' WHERE id = $1`, [
      seeded.listingId,
    ]);
    const res = await retry(adminUser);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'STATE_CONFLICT', reason: 'NOT_CLEARING', status: 'SETTLED' },
    });
    expect((await retry(adminUser, randomUUID())).statusCode).toBe(404);
  });
});
