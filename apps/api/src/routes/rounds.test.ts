/**
 * HF-036a route tests: the live-rounds endpoints over HF-006 sessions on real Postgres — role
 * matrix, validation, conflicts and idempotent replay. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/rounds
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
import type { Nudge } from '@holdfast/shared';
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  newAuthId,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'r'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

let n = 0;
const key = () => `rounds-${++n}`;

describe.skipIf(!TEST_DATABASE_URL)('live rounds routes (HF-036a)', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof buildServer>;
  const nudged: Nudge[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: t.db,
      limiter: new RateLimiter(),
      rounds: { onNudge: (x) => void nudged.push(x) },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  const one = async <T = { id: string }>(sql: string, params: unknown[] = []) =>
    (await t.db.pool.query(sql, params)).rows[0] as T;

  const cookie = (name: string, sub: string, purpose: 'brand-session' | 'shopper-session') =>
    `${name}=${signToken(SECRET, purpose, { sub, exp: Date.now() + 600_000 })}`;

  async function seed() {
    const brand = await one(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel', 'p@aurel.example') RETURNING id`,
    );
    const product = await one(`INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`);
    const listing = await one(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, window_opens_at, window_closes_at)
       VALUES ($1, $2, 'OPEN', 5, 10000, now() - interval '1 hour', now() + interval '24 hours') RETURNING id`,
      [brand.id, product.id],
    );
    const users: Record<string, string> = {};
    for (const role of ['OWNER', 'MANAGER', 'VIEWER']) {
      const u = await one(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
        [brand.id, `${role.toLowerCase()}-${brand.id}@aurel.example`, role],
      );
      users[role] = cookie(BRAND_COOKIE, u.id, 'brand-session');
    }
    let shopperCookie = '';
    for (const amount of [30_000, 25_000, 20_000]) {
      const s = await one(`INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`);
      shopperCookie = cookie(SHOPPER_COOKIE, s.id, 'shopper-session');
      await t.db.pool.query(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key,
                           paypal_authorization_id, authorized_amount_cents, authorized_at)
         VALUES ($1, $2, $3, 'HELD', gen_random_uuid()::text, $4, $3, now())`,
        [listing.id, s.id, amount, newAuthId()],
      );
    }
    return { listingId: listing.id, brandId: brand.id, users, shopperCookie };
  }

  const call = (
    method: 'POST' | 'PATCH',
    url: string,
    opts: { headers?: Record<string, string>; body?: unknown; key?: string | null } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(opts.key === null ? {} : { 'idempotency-key': opts.key ?? key() }),
        ...opts.headers,
      },
      ...(opts.body === undefined ? {} : { payload: opts.body as object }),
    });

  const endpoints = (id: string) =>
    [
      ['POST', `/api/listings/${id}/rounds/start`, { targetQuantity: 2 }],
      ['POST', `/api/listings/${id}/rounds/next`, {}],
      ['POST', `/api/listings/${id}/rounds/stop`, undefined],
      ['PATCH', `/api/listings/${id}/rounds`, { targetQuantity: 2 }],
    ] as const;

  it('401 without a session; 403 for VIEWER, a shopper / buyer-agent session and an MCP bearer', async () => {
    const s = await seed();
    for (const [method, url, body] of endpoints(s.listingId)) {
      const anon = await call(method, url, { body });
      expect(anon.statusCode).toBe(401);
      for (const headers of [
        { cookie: s.users.VIEWER! },
        { cookie: s.shopperCookie },
        { authorization: 'Bearer hf_mcp_not_a_brand_session' },
      ]) {
        const res = await call(method, url, { headers, body });
        expect(res.statusCode, `${method} ${url} ${Object.keys(headers)[0]}`).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
    }
  });

  it('401 (not 403) for an expired or invalid brand session next to a shopper cookie or bearer', async () => {
    const s = await seed();
    const ownerId = await one(`SELECT id FROM brand_users WHERE brand_id = $1 AND role = 'OWNER'`, [
      s.brandId,
    ]);
    const expired = `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', {
      sub: ownerId.id,
      exp: Date.now() - 1_000,
    })}`;
    const forged = `${BRAND_COOKIE}=${signToken('z'.repeat(40), 'brand-session', {
      sub: ownerId.id,
      exp: Date.now() + 600_000,
    })}`;
    for (const [method, url, body] of endpoints(s.listingId)) {
      for (const headers of [
        { cookie: `${expired}; ${s.shopperCookie}` },
        { cookie: `${forged}; ${s.shopperCookie}` },
        { cookie: expired, authorization: 'Bearer hf_mcp_not_a_brand_session' },
      ]) {
        const res = await call(method, url, { headers, body });
        expect(res.statusCode, `${method} ${url} ${headers.cookie}`).toBe(401);
        expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      }
    }
    const row = await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
      s.listingId,
    ]);
    expect(row.status).toBe('OPEN');
  });

  it('400 on a bad body or a missing Idempotency-Key; 422 when Q > quantity; 404 for another brand', async () => {
    const s = await seed();
    const url = `/api/listings/${s.listingId}/rounds/start`;
    const owner = { cookie: s.users.OWNER! };
    for (const body of [
      {},
      { targetQuantity: 0 },
      { targetQuantity: 1.5 },
      { targetQuantity: 1, floorCents: 1 },
    ]) {
      expect((await call('POST', url, { headers: owner, body })).statusCode).toBe(400);
    }
    expect(
      (await call('POST', url, { headers: owner, body: { targetQuantity: 1 }, key: null }))
        .statusCode,
    ).toBe(400);
    const tooMany = await call('POST', url, { headers: owner, body: { targetQuantity: 6 } });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', maxQuantity: 5 } });

    const other = await seed();
    const foreign = await call('POST', url, {
      headers: { cookie: other.users.OWNER! },
      body: { targetQuantity: 1 },
    });
    expect(foreign.statusCode).toBe(404);
    expect(
      (
        await call('POST', '/api/listings/not-a-uuid/rounds/start', {
          headers: owner,
          body: { targetQuantity: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('start → next × 2 → stop over HTTP; replays and conflicts', async () => {
    const s = await seed();
    const base = `/api/listings/${s.listingId}/rounds`;
    const manager = { cookie: s.users.MANAGER! };

    const startKey = key();
    const start = await call('POST', `${base}/start`, {
      headers: manager,
      body: { targetQuantity: 2 },
      key: startKey,
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({
      listingId: s.listingId,
      status: 'ROUNDS',
      round: 1,
      targetQuantity: 2,
      nudged: 1,
      endedReason: null,
    });
    expect(JSON.stringify(start.json())).not.toContain('10000');
    // Same key → stored response, no second start.
    const replay = await call('POST', `${base}/start`, {
      headers: manager,
      body: { targetQuantity: 2 },
      key: startKey,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(start.json());
    const again = await call('POST', `${base}/start`, {
      headers: manager,
      body: { targetQuantity: 2 },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { code: 'STATE_CONFLICT', reason: 'ROUNDS_ALREADY_STARTED' },
    });

    const next1 = await call('POST', `${base}/next`, { headers: manager, body: { fromRound: 1 } });
    expect(next1.statusCode).toBe(200);
    expect(next1.json()).toMatchObject({ round: 2, nudged: 1 });
    const stale = await call('POST', `${base}/next`, { headers: manager, body: { fromRound: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { reason: 'ROUND_ADVANCED', round: 2 } });

    const patch = await call('PATCH', base, { headers: manager, body: { targetQuantity: 1 } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ targetQuantity: 1, round: 2 });

    // No body at all is accepted for next.
    const next2 = await call('POST', `${base}/next`, { headers: { cookie: s.users.OWNER! } });
    expect(next2.statusCode).toBe(200);
    expect(next2.json()).toMatchObject({ round: 3, targetQuantity: 1, nudged: 2 });

    const stop = await call('POST', `${base}/stop`, { headers: manager });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ endedReason: 'BRAND_STOPPED' });
    const frozen = await call('POST', `${base}/next`, { headers: manager });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json()).toMatchObject({ error: { reason: 'ROUNDS_ENDED' } });

    await new Promise((r) => setTimeout(r, 10));
    expect(nudged.filter((x) => x.listingId === s.listingId)).toHaveLength(4);
  });

  it('start on a listing that is not OPEN → 409 NOT_OPEN', async () => {
    const s = await seed();
    await t.db.pool.query(`UPDATE listings SET status = 'CANCELLED' WHERE id = $1`, [s.listingId]);
    const res = await call('POST', `/api/listings/${s.listingId}/rounds/start`, {
      headers: { cookie: s.users.OWNER! },
      body: { targetQuantity: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'STATE_CONFLICT', reason: 'NOT_OPEN' } });
  });
});
