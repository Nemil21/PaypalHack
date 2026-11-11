/**
 * HF-016 `POST /api/bids/:id/cancel`, `GET /api/bids/mine`, `GET /api/bids/:id` through the real
 * server (guards, CSRF, Idempotency-Key store) on Postgres with the `FakePayPal` stub.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/my-bids.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook, FakePayPal, loadConfig, voidKey, type PayPalClient } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'q'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  PAYPAL_MODE: 'stub',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-016 shopper bid routes', () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      bids: {
        money: {
          db: tdb.db,
          paypal: client,
          audit: auditHook,
          voidBackoffMs: [0, 0, 0],
          allowTestCard: true,
        },
      },
    });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const session = (shopperId: string) =>
    `${SHOPPER_COOKIE}=${signToken(SECRET, 'shopper-session', { sub: shopperId, exp: Date.now() + 60_000 })}`;

  async function heldBid(listingId: string, shopperId: string, amountCents = 22_900) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bids',
      headers: { cookie: session(shopperId), 'idempotency-key': randomUUID() },
      payload: { listingId, amountCents, paymentMethod: 'TEST_CARD' },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { bidId: string; authorizationId: string };
  }

  const cancel = (shopperId: string | null, bidId: string, key: string = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `/api/bids/${bidId}/cancel`,
      headers: {
        ...(shopperId ? { cookie: session(shopperId) } : {}),
        'idempotency-key': key,
      },
    });
  const get = (shopperId: string | null, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: shopperId ? { cookie: session(shopperId) } : {},
    });

  it('cancel → 200 VOIDED "released"; same key replays; a new key returns the current state', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const { bidId, authorizationId } = await heldBid(l.id, s.id);
    const key = randomUUID();
    const first = await cancel(s.id, bidId, key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      bidId,
      status: 'VOIDED',
      voidReason: 'CANCELLED',
      moneyKey: 'released',
      authorizationId,
      voidAttempts: 1,
    });
    expect(first.json().message).toContain('Your bank may show it as pending for a few days.');
    expect(fake.authorization(authorizationId)?.status).toBe('VOIDED');

    const replay = await cancel(s.id, bidId, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const again = await cancel(s.id, bidId);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('VOIDED');
    const voids = fake.calls.filter((c) => c.op === 'void' && c.requestId === voidKey(bidId));
    expect(voids).toHaveLength(1);
  });

  it('cancel needs a session and an Idempotency-Key', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const { bidId } = await heldBid(l.id, s.id);
    expect((await cancel(null, bidId)).statusCode).toBe(401);
    const noKey = await app.inject({
      method: 'POST',
      url: `/api/bids/${bidId}/cancel`,
      headers: { cookie: session(s.id) },
    });
    expect(noKey.statusCode).toBe(400);
    expect((await fx.bid(bidId)).status).toBe('HELD');
  });

  it("another shopper's bid, an unknown id or a malformed id → 404", async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const intruder = await fx.shopper();
    const { bidId } = await heldBid(l.id, s.id);
    for (const res of [
      await cancel(intruder.id, bidId),
      await cancel(s.id, randomUUID()),
      await cancel(s.id, 'not-a-uuid'),
      await get(intruder.id, `/api/bids/${bidId}`),
      await get(s.id, '/api/bids/not-a-uuid'),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    expect((await fx.bid(bidId)).status).toBe('HELD');
  });

  it('WON during CLEARING → 409 STATE_CONFLICT', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const { bidId } = await heldBid(l.id, s.id);
    await tdb.db.pool.query(`UPDATE listings SET status = 'CLEARING' WHERE id = $1`, [l.id]);
    await tdb.db.pool.query(`UPDATE bids SET status = 'WON' WHERE id = $1`, [bidId]);
    const res = await cancel(s.id, bidId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'STATE_CONFLICT', reason: 'WON', bidId });
  });

  it('GET /api/bids/mine lists only my bids; GET /api/bids/:id returns the timeline', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const other = await fx.shopper();
    const { bidId } = await heldBid(l.id, s.id);
    await heldBid(l.id, other.id, 25_000);

    expect((await get(null, '/api/bids/mine')).statusCode).toBe(401);
    const mine = await get(s.id, '/api/bids/mine');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().bids).toHaveLength(1);
    expect(mine.json().bids[0]).toMatchObject({
      bidId,
      status: 'HELD',
      moneyKey: 'held',
      belowCutoff: null,
    });

    await cancel(s.id, bidId);
    const detail = await get(s.id, `/api/bids/${bidId}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.bid).toMatchObject({ bidId, status: 'VOIDED', moneyKey: 'released' });
    expect(body.timeline.map((e: { step: string }) => e.step)).toEqual([
      'PLACED',
      'HELD',
      'RELEASING',
      'RELEASED',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/floor/i);
  });
});
