/**
 * HF-027 route tests: `POST /api/listings/:id/clear` guards, validation and status codes on real
 * Postgres. Needs TEST_DATABASE_URL; skipped when unset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
import {
  StubPayPal,
  TEST_DATABASE_URL,
  createTestDatabase,
  newAuthId,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { buildServer } from '../server.js';
import type { SessionPrincipal as Principal } from './clear.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://holdfast:pw@localhost:5432/holdfast',
  SESSION_SECRET: 'x'.repeat(32),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

describe.skipIf(!TEST_DATABASE_URL)('POST /api/listings/:id/clear', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof buildServer>;
  /** The principal the fake session resolves to; set per test. */
  let principal: Principal | null = null;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = buildServer(loadConfig(REQUIRED), {
      webDistDir: null,
      clear: {
        money: { db: t.db, paypal: new StubPayPal(), voidBackoffMs: [0, 0, 0] },
        authenticate: () => principal,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  async function seed(quantity = 5): Promise<{ listingId: string; brandId: string }> {
    const one = async (sql: string, params: unknown[] = []) =>
      (await t.db.pool.query(sql, params)).rows[0] as { id: string };
    const brand = await one(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel', 'p@aurel.example') RETURNING id`,
    );
    const product = await one(`INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`);
    const listing = await one(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, window_opens_at, window_closes_at)
       VALUES ($1, $2, 'OPEN', $3, 10000, now(), now() + interval '24 hours') RETURNING id`,
      [brand.id, product.id, quantity],
    );
    for (const amount of [30_000, 20_000]) {
      const s = await one(`INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`);
      await t.db.pool.query(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key,
                           paypal_authorization_id, authorized_amount_cents, authorized_at)
         VALUES ($1, $2, $3, 'HELD', gen_random_uuid()::text, $4, $3, now())`,
        [listing.id, s.id, amount, newAuthId()],
      );
    }
    return { listingId: listing.id, brandId: brand.id };
  }

  const post = (listingId: string, body: unknown, key: string | null = `k-${Math.random()}`) =>
    app.inject({
      method: 'POST',
      url: `/api/listings/${listingId}/clear`,
      headers: key ? { 'idempotency-key': key } : {},
      payload: body as object,
    });

  const owner = (brandId: string): Principal => ({
    type: 'BRAND_USER',
    id: 'u1',
    brandId,
    role: 'OWNER',
  });

  it('401 without a session; 403 for VIEWER, shoppers and agents', async () => {
    const { listingId, brandId } = await seed();
    principal = null;
    expect((await post(listingId, { quantity: 1, expectedGrossCents: 30_000 })).statusCode).toBe(
      401,
    );
    for (const p of [
      { ...owner(brandId), role: 'VIEWER' as const },
      { type: 'SHOPPER' as const, id: 's1' },
      { type: 'BRAND_AGENT' as const, id: 'a1', brandId, role: 'OWNER' as const },
      { type: 'MCP_CLIENT' as const, id: 'm1' },
    ]) {
      principal = p;
      const res = await post(listingId, { quantity: 1, expectedGrossCents: 30_000 });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('400 without Idempotency-Key or with a bad body (Q = 0, non-integer, extra fields)', async () => {
    const { listingId, brandId } = await seed();
    principal = owner(brandId);
    const noKey = await post(listingId, { quantity: 1, expectedGrossCents: 30_000 }, null);
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', field: 'Idempotency-Key' },
    });
    for (const body of [
      { quantity: 0, expectedGrossCents: 0 },
      { quantity: 1.5, expectedGrossCents: 30_000 },
      { quantity: 1, expectedGrossCents: '30000' },
      { quantity: 1, expectedGrossCents: 30_000, floorCents: 1 },
    ]) {
      expect((await post(listingId, body)).statusCode).toBe(400);
    }
  });

  it('422 when Q > listing.quantity', async () => {
    const { listingId, brandId } = await seed(3);
    principal = { ...owner(brandId), role: 'MANAGER' };
    const res = await post(listingId, { quantity: 4, expectedGrossCents: 50_000 });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', maxQuantity: 3 } });
  });

  it('409 BOOK_CHANGED carries the new numbers; then 202, replay, and 409 NOT_CLEARABLE', async () => {
    const { listingId, brandId } = await seed();
    principal = owner(brandId);
    const stale = await post(listingId, { quantity: 2, expectedGrossCents: 30_000 }, 'stale-1');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: 'STATE_CONFLICT',
        reason: 'BOOK_CHANGED',
        numbers: { cutoffCents: 20_000, grossCents: 50_000, winners: 2 },
      },
    });

    const ok = await post(listingId, { quantity: 2, expectedGrossCents: 50_000 }, 'clear-1');
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({
      status: 'CLEARING',
      cutoffCents: 20_000,
      grossCents: 50_000,
      winners: 2,
      losers: 0,
    });
    const replay = await post(listingId, { quantity: 2, expectedGrossCents: 50_000 }, 'clear-1');
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(ok.json());
    const mismatch = await post(listingId, { quantity: 1, expectedGrossCents: 30_000 }, 'clear-1');
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_MISMATCH' } });
    // The BOOK_CHANGED 409 was not stored: its key runs again and now sees the cleared listing.
    const retried = await post(listingId, { quantity: 2, expectedGrossCents: 30_000 }, 'stale-1');
    expect(retried.statusCode).toBe(409);
    expect(retried.json()).toMatchObject({ error: { reason: 'NOT_CLEARABLE' } });

    const again = await post(listingId, { quantity: 2, expectedGrossCents: 50_000 }, 'clear-2');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { code: 'STATE_CONFLICT', reason: 'NOT_CLEARABLE', status: 'CLEARING' },
    });
  });

  it("404 for another brand's listing or a malformed id", async () => {
    const { listingId } = await seed();
    const other = await seed();
    principal = owner(other.brandId);
    expect((await post(listingId, { quantity: 1, expectedGrossCents: 30_000 })).statusCode).toBe(
      404,
    );
    expect((await post('not-a-uuid', { quantity: 1, expectedGrossCents: 30_000 })).statusCode).toBe(
      404,
    );
  });
});
