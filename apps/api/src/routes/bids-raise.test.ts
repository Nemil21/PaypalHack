/**
 * HF-018 `POST /api/bids/:id/raise` through the real server (guards, Idempotency-Key store) on
 * Postgres with the `FakePayPal` stub. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/bids-raise.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditHook,
  FakePayPal,
  loadConfig,
  orderRequestId,
  SANDBOX_TEST_CARD,
  type PayPalClient,
} from '@holdfast/core';
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

describe.skipIf(!TEST_DATABASE_URL)('POST /api/bids/:id/raise (HF-018)', () => {
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
          appBaseUrl: 'https://holdfast.test',
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

  async function vaultedShopper(): Promise<string> {
    const s = await fx.shopper();
    const r = await client.createAuthOrder({
      requestId: orderRequestId(randomUUID()),
      amountCents: 100,
      paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD, vault: true },
    });
    if (r.kind !== 'held' || !r.vault?.id) throw new Error('no vault');
    await tdb.db.pool.query(`UPDATE shoppers SET paypal_vault_id = $2 WHERE id = $1`, [
      s.id,
      r.vault.id,
    ]);
    return s.id;
  }

  const post = (shopperId: string | null, body: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/bids',
      headers: {
        ...(shopperId ? { cookie: session(shopperId) } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      payload: body as Record<string, unknown>,
    });

  const raise = (
    shopperId: string | null,
    bidId: string,
    body: unknown,
    key: string | null = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/bids/${bidId}/raise`,
      headers: {
        ...(shopperId ? { cookie: session(shopperId) } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      payload: body as Record<string, unknown>,
    });

  async function heldBid(listingId: string, shopperId: string): Promise<string> {
    const res = await post(shopperId, { listingId, amountCents: 22_900, paymentMethod: 'VAULT' });
    expect(res.statusCode).toBe(201);
    return res.json().bidId as string;
  }

  it('raise → 201 HELD with the raise copy; old bid VOIDED (REPLACED); same key replays', async () => {
    const l = await fx.listing();
    const s = await vaultedShopper();
    const oldId = await heldBid(l.id, s);
    const key = randomUUID();
    const res = await raise(s, oldId, { amountCents: 23_900 }, key);
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json).toMatchObject({
      status: 'HELD',
      amountCents: 23_900,
      replacesBidId: oldId,
      previousAmountCents: 22_900,
      raiseCount: 1,
      message: expect.stringContaining('Raised to $239.'),
      warnSeveralHolds: null,
    });
    expect(await fx.bid(oldId)).toMatchObject({ status: 'VOIDED', void_reason: 'REPLACED' });
    const again = await raise(s, oldId, { amountCents: 23_900 }, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().bidId).toBe(json.bidId);
  });

  it('declined new hold → 422 HOLD_FAILED "still stands"; old bid HELD', async () => {
    const l = await fx.listing();
    const s = await vaultedShopper();
    const oldId = await heldBid(l.id, s);
    fake.failNext('order_create', { kind: 'decline' });
    const res = await raise(s, oldId, { amountCents: 23_900 });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: 'HOLD_FAILED', message: "Couldn't raise. Your $229 bid still stands." },
    });
    expect((await fx.bid(oldId)).status).toBe('HELD');
  });

  it("guards: no session → 401; no key → 400; bad body → 400; someone else's bid → 404", async () => {
    const l = await fx.listing();
    const s = await vaultedShopper();
    const oldId = await heldBid(l.id, s);
    expect((await raise(null, oldId, { amountCents: 23_900 })).statusCode).toBe(401);
    expect((await raise(s, oldId, { amountCents: 23_900 }, null)).statusCode).toBe(400);
    const bad = await raise(s, oldId, { amountCents: 23_900, shopperId: s });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    const other = await fx.shopper();
    expect((await raise(other.id, oldId, { amountCents: 23_900 })).statusCode).toBe(404);
    expect((await fx.bid(oldId)).status).toBe('HELD');
  });

  it('below the minimum raise → 400 VALIDATION_ERROR', async () => {
    const l = await fx.listing();
    const s = await vaultedShopper();
    const oldId = await heldBid(l.id, s);
    const res = await raise(s, oldId, { amountCents: 23_000 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        field: 'amountCents',
        message: 'Raise to at least $231.29.',
      },
    });
  });
});
