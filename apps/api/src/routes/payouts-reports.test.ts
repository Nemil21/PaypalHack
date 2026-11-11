/**
 * HF-059b W09 routes over HTTP on a real Postgres with `FakePayPal`: payouts, reports (JSON and
 * CSV), the shipping roster, `POST /listings/:id/shipments` (role gate, 201 then 200 with one
 * PayPal call, 404 cross-tenant) and the CSV upload. Shipment logic and races are covered in
 * packages/core/src/shipments/shipments.test.ts. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/payouts-reports
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, payoutBrand, settleListing } from '@holdfast/core';
import type {
  BrandPayoutsBody,
  BrandReportBody,
  ShipmentRosterBody,
  ShipmentUploadBody,
} from '@holdfast/shared';
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
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-059b W09 routes', { timeout: 60_000 }, () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let fake: FakePayPal;
  let seeded: ClearedListing;
  let owner: string;
  let viewer: string;
  let stranger: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const cookie = (userId: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`;
  const get = (userId: string, url: string, accept?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { cookie: cookie(userId), ...(accept ? { accept } : {}) },
    });
  const post = (userId: string, url: string, payload: unknown, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: { cookie: cookie(userId), 'idempotency-key': key, origin: 'http://localhost:3000' },
    });
  const user = async (brandId: string, role: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
        [brandId, `${randomUUID()}@aurel.example`, role],
      )
    ).id;
  const tracks = () => fake.calls.filter((c) => c.op === 'track').length;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fake = new FakePayPal();
    const client = fake.client();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      shipments: { paypal: client },
    });
    seeded = await seedClearedListing(tdb.db, client, { winners: 3, reserve: 1, belowFloor: 0 });
    await settleListing(
      { db: tdb.db, paypal: client, sleep: async () => {}, payoutBrand: async () => {} },
      seeded.listingId,
    );
    await payoutBrand({ db: tdb.db, paypal: client }, seeded.listingId);
    const { brand_id } = await one<{ brand_id: string }>(
      `SELECT brand_id FROM listings WHERE id = $1`,
      [seeded.listingId],
    );
    owner = await user(brand_id, 'OWNER');
    viewer = await user(brand_id, 'VIEWER');
    const other = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Other', 'p@other.example') RETURNING id`,
    );
    stranger = await user(other.id, 'OWNER');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('payouts and reports are tenant-scoped; reports match the captures, JSON and CSV', async () => {
    const payouts = (await get(owner, '/api/brands/me/payouts')).json<BrandPayoutsBody>();
    expect(payouts.payouts).toHaveLength(1);
    expect(payouts.payouts[0]).toMatchObject({ listingId: seeded.listingId, attempt: 1 });
    expect((await get(stranger, '/api/brands/me/payouts')).json()).toEqual({ payouts: [] });

    const gross = seeded.winners.reduce((s, w) => s + w.amountCents, 0);
    const report = (await get(viewer, '/api/brands/me/reports')).json<BrandReportBody>();
    expect(report.statements).toHaveLength(1);
    expect(report.statements[0]).toMatchObject({
      units: 3,
      grossRealCents: gross,
      feeCents: payouts.payouts[0]!.feeCents,
      netCents: payouts.payouts[0]!.netCents,
    });
    expect(report.totals.grossRealCents).toBe(gross);

    const csv = await get(owner, '/api/brands/me/reports?from=2020-01-01', 'text/csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.body.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(seeded.listingId);

    const empty = (
      await get(owner, '/api/brands/me/reports?to=2020-01-01')
    ).json<BrandReportBody>();
    expect(empty.statements).toHaveLength(0);
    expect((await get(owner, '/api/brands/me/reports?from=nope')).statusCode).toBe(400);
    expect((await get(owner, '/api/brands/me/reports')).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/brands/me/reports' })).statusCode).toBe(
      401,
    );
  });

  it('POST /shipments: managers only, 201 then 200 with one PayPal call, 404 cross-tenant', async () => {
    const bidId = seeded.winners[0]!.bidId;
    const url = `/api/listings/${seeded.listingId}/shipments`;
    const body = { bidId, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' };
    expect((await post(viewer, url, body)).statusCode).toBe(403);
    expect((await post(stranger, url, body)).statusCode).toBe(404);
    expect((await post(owner, url, { ...body, trackingNumber: '' })).statusCode).toBe(400);

    const before = tracks();
    const first = await post(owner, url, body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      replayed: false,
      shipment: { bidId, status: 'SHIPPED', carrier: 'UPS' },
    });
    const again = await post(owner, url, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true });
    expect(tracks() - before).toBe(1);

    const conflict = await post(owner, url, { ...body, trackingNumber: 'NEW1' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'STATE_CONFLICT', reason: 'ALREADY_SHIPPED' },
    });
    const loser = await post(owner, url, { ...body, bidId: seeded.reserve[0]!.bidId });
    expect(loser.json()).toMatchObject({ error: { reason: 'NOT_CAPTURED' } });
  });

  it('roster + CSV template + CSV upload with per-row errors', async () => {
    const base = `/api/listings/${seeded.listingId}/shipments`;
    const roster = (await get(viewer, base)).json<ShipmentRosterBody>();
    expect(roster.rows).toHaveLength(3);
    expect(roster.rows.filter((r) => r.shipment?.status === 'SHIPPED')).toHaveLength(1);
    expect((await get(stranger, base)).statusCode).toBe(404);

    const template = await get(owner, base, 'text/csv');
    const lines = template.body.trim().split('\r\n');
    expect(lines[0]).toBe('bidId,carrier,trackingNumber,winner,status');
    expect(lines).toHaveLength(4);

    const csv = [
      'bidId,carrier,trackingNumber',
      `${seeded.winners[1]!.bidId},USPS,9400111`,
      `${seeded.winners[2]!.bidId},,9400222`,
    ].join('\n');
    expect((await post(viewer, `${base}/csv`, { csv })).statusCode).toBe(403);
    const up = await post(owner, `${base}/csv`, { csv });
    expect(up.statusCode).toBe(200);
    const body = up.json<ShipmentUploadBody>();
    expect(body).toMatchObject({ okCount: 1, errorCount: 1 });
    expect(body.results[1]).toMatchObject({ row: 2, ok: false });
    expect((await post(stranger, `${base}/csv`, { csv })).statusCode).toBe(404);
  });
});
