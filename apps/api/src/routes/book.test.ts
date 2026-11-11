/**
 * HF-022 route tests: `GET /api/listings/:id/book` and `/simulate` over HTTP on a real Postgres
 * (guards, tenancy 404s, validation and the 300-bid latency budget). The read model itself is
 * covered in packages/core/src/listings/book.test.ts. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/book
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
import { bookResponseSchema, feeCents, simulateResponseSchema } from '@holdfast/shared';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  newAuthId,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'b'.repeat(40);

/** Median wall time of 5 calls after 3 warm-ups (pool connections, JIT). */
async function medianMs(fn: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 3; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[2]!;
}
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-022 /book and /simulate routes', () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let listingId: string;
  let viewer: string;
  let otherBrandUser: string;
  let shopperCookie: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;

  const brandCookie = (userId: string) => ({
    cookie: `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`,
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

    const owner = await brandWithUser('VIEWER');
    viewer = owner.userId;
    otherBrandUser = (await brandWithUser('OWNER')).userId;
    const product = await one<{ id: string }>(
      `INSERT INTO products (title, best_public_price_cents) VALUES ('Aurel A7', 27900) RETURNING id`,
    );
    listingId = (
      await one<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                               liquidation_quote_cents, window_opens_at, window_closes_at)
         VALUES ($1, $2, 'OPEN', 300, 19900, 3800, now() - interval '1 hour', now() + interval '24 hours')
         RETURNING id`,
        [owner.brandId, product.id],
      )
    ).id;
    // 300 held bids with stub authorizations, plus one with no hold (D8).
    const amounts = Array.from({ length: 300 }, (_, i) => 20_000 + ((i * 53) % 9_000));
    await tdb.db.pool.query(
      `WITH s AS (
         INSERT INTO shoppers (is_simulated) SELECT false FROM unnest($2::int[]) RETURNING id
       ), numbered AS (SELECT id, row_number() OVER () AS n FROM s)
       INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key,
                         paypal_authorization_id, authorized_amount_cents, authorized_at, source)
       SELECT $1, numbered.id, a.amount, 'HELD', gen_random_uuid()::text, a.auth, a.amount, now(), 'MCP'
         FROM unnest($2::int[], $3::text[]) WITH ORDINALITY AS a(amount, auth, n)
         JOIN numbered ON numbered.n = a.n`,
      [listingId, [...amounts, 50_000], [...amounts.map(() => newAuthId()), null]],
    );
    const shopper = await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`);
    shopperCookie = `hf_shopper=${signToken(SECRET, 'shopper-session', { sub: shopper.id, exp: Date.now() + 60_000 })}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('a VIEWER reads the book: 300 held bids, no-hold excluded, valid schema, < 200 ms', async () => {
    const get = () =>
      app.inject({
        method: 'GET',
        url: `/api/listings/${listingId}/book`,
        headers: brandCookie(viewer),
      });
    const ms = await medianMs(get);
    const res = await get();
    expect(res.statusCode).toBe(200);
    const book = bookResponseSchema.parse(res.json());
    expect(book.bids).toHaveLength(300);
    expect(book.bids.some((b) => b.amountCents === 50_000)).toBe(false);
    expect(book.stats.liveBids).toBe(300);
    expect(ms).toBeLessThan(200);
  });

  it('simulate returns the api.md numbers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/simulate?quantity=240`,
      headers: brandCookie(viewer),
    });
    expect(res.statusCode).toBe(200);
    const sim = simulateResponseSchema.parse(res.json());
    expect(sim).toMatchObject({ quantity: 240, winners: 240, liquidationCents: 240 * 3800 });
    expect(sim.feeCents).toBe(feeCents(sim.grossCents, 900));
    expect(sim.winnerBidIds).toHaveLength(240);
  });

  it.each(['book', 'simulate?quantity=1'])('another brand gets 404 on %s', async (path) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/${path}`,
      headers: brandCookie(otherBrandUser),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Listing not found.' } });
  });

  it('unknown and malformed ids are 404', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/listings/${id}/book`,
        headers: brandCookie(viewer),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('no session is 401; a shopper session is 401 (brand only)', async () => {
    const anon = await app.inject({ method: 'GET', url: `/api/listings/${listingId}/book` });
    expect(anon.statusCode).toBe(401);
    const shopper = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/simulate`,
      headers: { cookie: shopperCookie },
    });
    expect(shopper.statusCode).toBe(401);
  });

  it.each(['0', '-3', '1.5', 'abc', '301'])('quantity=%s is 400 VALIDATION_ERROR', async (q) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/simulate?quantity=${q}`,
      headers: brandCookie(viewer),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
