/**
 * HF-012b route tests: `POST /api/listings/:id/cancel` and `PATCH /api/listings/:id` against a
 * real, freshly migrated Postgres with the `FakePayPal` stub. Needs TEST_DATABASE_URL; skipped
 * when unset. The money logic and race tests live in packages/core/src/listings/cancel-quantity.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook, Channel3FixtureClient, FakePayPal, loadConfig } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
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
  CHANNEL3_MODE: 'fixtures',
};

let n = 0;
const key = () => `cancel-test-${++n}`;

describe.skipIf(!TEST_DATABASE_URL)('HF-012b listing cancel + PATCH quantity routes', () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let app: ReturnType<typeof buildServer>;
  const fake = new FakePayPal();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      channel3: new Channel3FixtureClient(),
      listings: {
        money: {
          db: tdb.db,
          paypal: fake.client({ timeoutMs: 10_000 }),
          audit: auditHook,
          voidBackoffMs: [0, 0, 0],
        },
      },
    });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    tdb.db.pool.query<T>(sql, params).then((r) => r.rows);

  /** A listing from the fixture factory plus a session for a user of its brand. */
  async function listingWithSession(status = 'OPEN', role = 'MANAGER') {
    const l = await fx.listing({ status });
    const [row] = await q<{ brand_id: string }>(`SELECT brand_id FROM listings WHERE id = $1`, [
      l.id,
    ]);
    const [u] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
      [row!.brand_id, `user-${randomUUID()}@brand.example`, role],
    );
    const token = signToken(SECRET, 'brand-session', { sub: u!.id, exp: Date.now() + 600_000 });
    return { listingId: l.id, cookie: `${BRAND_COOKIE}=${token}` };
  }

  const cancel = (cookie: string, id: string, idem = key()) =>
    app.inject({
      method: 'POST',
      url: `/api/listings/${id}/cancel`,
      headers: { cookie, 'idempotency-key': idem },
    });
  const patch = (cookie: string, id: string, payload: unknown, idem = key()) =>
    app.inject({
      method: 'PATCH',
      url: `/api/listings/${id}`,
      headers: { cookie, 'idempotency-key': idem },
      payload: payload as Record<string, unknown>,
    });
  const status = async (id: string) =>
    (
      await q<{ status: string; quantity: number }>(
        `SELECT status, quantity FROM listings WHERE id = $1`,
        [id],
      )
    )[0]!;

  describe('POST /api/listings/:id/cancel', () => {
    it('202 CANCELLED; the HELD bid is voided in the background; a replay returns the same 202', async () => {
      const s = await listingWithSession('OPEN');
      const b = await fx.heldBid(s.listingId, (await fx.shopper()).id);
      const idem = key();
      const res = await cancel(s.cookie, s.listingId, idem);
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual({
        listingId: s.listingId,
        status: 'CANCELLED',
        from: 'OPEN',
        voiding: 1,
        abandoned: 0,
      });
      expect((await status(s.listingId)).status).toBe('CANCELLED');
      // Never HELD again, whatever PayPal says about the fixture authorization.
      expect((await fx.bid(b.id)).status).not.toBe('HELD');

      const replay = await cancel(s.cookie, s.listingId, idem);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toEqual(res.json());
    });

    it('ROUNDS → 202', async () => {
      const s = await listingWithSession('ROUNDS');
      const res = await cancel(s.cookie, s.listingId);
      expect(res.statusCode, res.body).toBe(202);
    });

    it('CLEARING → 409 STATE_CONFLICT', async () => {
      const s = await listingWithSession('CLEARING');
      const res = await cancel(s.cookie, s.listingId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'STATE_CONFLICT',
        reason: 'NOT_CANCELLABLE',
        status: 'CLEARING',
      });
      expect((await status(s.listingId)).status).toBe('CLEARING');
    });

    it('VIEWER → 403; another brand → 404; no session → 401', async () => {
      const viewer = await listingWithSession('OPEN', 'VIEWER');
      expect((await cancel(viewer.cookie, viewer.listingId)).statusCode).toBe(403);
      const other = await listingWithSession('OPEN');
      expect((await cancel(other.cookie, viewer.listingId)).statusCode).toBe(404);
      const anon = await app.inject({
        method: 'POST',
        url: `/api/listings/${viewer.listingId}/cancel`,
        headers: { 'idempotency-key': key() },
      });
      expect(anon.statusCode).toBe(401);
      expect((await status(viewer.listingId)).status).toBe('OPEN');
    });
  });

  describe('PATCH /api/listings/:id', () => {
    it('raises quantity on OPEN → 200', async () => {
      const s = await listingWithSession('OPEN');
      const res = await patch(s.cookie, s.listingId, { quantity: 40 });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        listingId: s.listingId,
        status: 'OPEN',
        previousQuantity: 10,
        quantity: 40,
      });
      expect((await status(s.listingId)).quantity).toBe(40);
    });

    it('down or equal → 400 VALIDATION_ERROR', async () => {
      const s = await listingWithSession('OPEN');
      for (const quantity of [10, 3]) {
        const res = await patch(s.cookie, s.listingId, { quantity });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatchObject({
          code: 'VALIDATION_ERROR',
          field: 'quantity',
          reason: 'QUANTITY_NOT_INCREASED',
          currentQuantity: 10,
        });
      }
      expect((await status(s.listingId)).quantity).toBe(10);
    });

    it('on ROUNDS → 409 STATE_CONFLICT', async () => {
      const s = await listingWithSession('ROUNDS');
      const res = await patch(s.cookie, s.listingId, { quantity: 50 });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'STATE_CONFLICT',
        reason: 'NOT_OPEN',
        status: 'ROUNDS',
      });
    });

    it('floor or window in the body → 400 (locked after publish); nothing changes', async () => {
      const s = await listingWithSession('OPEN');
      for (const payload of [
        { quantity: 20, floorCents: 5_000 },
        { floorCents: 5_000 },
        { quantity: 20, windowHours: 24 },
      ]) {
        const res = await patch(s.cookie, s.listingId, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      const [row] = await q<{ quantity: number; floor_cents: number }>(
        `SELECT quantity, floor_cents FROM listings WHERE id = $1`,
        [s.listingId],
      );
      expect(row).toEqual({ quantity: 10, floor_cents: 10_000 });
    });

    it('VIEWER → 403; another brand → 404', async () => {
      const viewer = await listingWithSession('OPEN', 'VIEWER');
      expect((await patch(viewer.cookie, viewer.listingId, { quantity: 20 })).statusCode).toBe(403);
      const other = await listingWithSession('OPEN');
      expect((await patch(other.cookie, viewer.listingId, { quantity: 20 })).statusCode).toBe(404);
    });
  });
});
