/**
 * HF-014a `POST /api/bids` through the real server (guards, CSRF, Idempotency-Key store) on
 * Postgres with the `FakePayPal` stub. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/bids.test.ts
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

describe.skipIf(!TEST_DATABASE_URL)('POST /api/bids (HF-014a, HF-014b)', () => {
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

  const creates = (bidId: string) =>
    fake.calls.filter((c) => c.op === 'order_create' && c.requestId === bidId);

  it('VAULT → 201 HELD with authorizationId; double submit replays the same bid, one order', async () => {
    const l = await fx.listing();
    const s = await vaultedShopper();
    const body = { listingId: l.id, amountCents: 22_900, paymentMethod: 'VAULT' };
    const key = randomUUID();
    const first = await post(s, body, key);
    expect(first.statusCode).toBe(201);
    const json = first.json();
    expect(json).toMatchObject({
      status: 'HELD',
      amountCents: 22_900,
      authorizationId: expect.any(String),
      publicOffer: null,
    });
    const again = await post(s, body, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().bidId).toBe(json.bidId);
    expect(creates(json.bidId)).toHaveLength(1);
    const row = await fx.bid(json.bidId);
    expect(row).toMatchObject({ source: 'OFFER_PAGE', release_if_cheaper: true });
  });

  it('TEST_CARD (server-side card) → 201 HELD', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const res = await post(s.id, {
      listingId: l.id,
      amountCents: 21_900,
      paymentMethod: 'TEST_CARD',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('HELD');
  });

  it('second tab with a new key → 409 ALREADY_BID {bidId}; parallel tabs → one HELD', async () => {
    const l = await fx.listing();
    const s = await vaultedShopper();
    const [a, b] = await Promise.all([
      post(s, { listingId: l.id, amountCents: 22_900, paymentMethod: 'VAULT' }),
      post(s, { listingId: l.id, amountCents: 23_900, paymentMethod: 'VAULT' }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    const winner = a.statusCode === 201 ? a : b;
    expect(loser.json().error).toMatchObject({ code: 'ALREADY_BID', bidId: winner.json().bidId });
  });

  it('closed window → 409 WINDOW_CLOSED with no PayPal call', async () => {
    const l = await fx.listing({ closesInHours: -1 });
    const s = await vaultedShopper();
    const before = fake.calls.length;
    const res = await post(s, { listingId: l.id, amountCents: 22_900, paymentMethod: 'VAULT' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('WINDOW_CLOSED');
    expect(fake.calls.length).toBe(before);
  });

  it('declined → 422 HOLD_FAILED, not stored as final (the key is free again)', async () => {
    const l = await fx.listing();
    const s = await vaultedShopper();
    fake.failNext('order_create', { kind: 'decline' });
    const key = randomUUID();
    const body = { listingId: l.id, amountCents: 22_900, paymentMethod: 'VAULT' };
    const res = await post(s, body, key);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'HOLD_FAILED', bidId: expect.any(String) });
    const stored = await tdb.db.pool.query(
      `SELECT 1 FROM idempotency_keys WHERE principal_id = $1 AND key = $2`,
      [s, key],
    );
    expect(stored.rowCount).toBe(0);
    // A new key is a new bid and may succeed.
    const retry = await post(s, body);
    expect(retry.statusCode).toBe(201);
  });

  it('401 without a shopper session; 400 without an Idempotency-Key; raw card fields refused', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const body = { listingId: l.id, amountCents: 22_900, paymentMethod: 'VAULT' };
    expect((await post(null, body)).statusCode).toBe(401);
    const noKey = await post(s.id, body, null);
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('VALIDATION_ERROR');
    const card = await post(s.id, {
      ...body,
      paymentMethod: 'TEST_CARD',
      card: { number: '4111111111111111' },
    });
    expect(card.statusCode).toBe(400);
    const tooSmall = await post(s.id, { ...body, amountCents: 50 });
    expect(tooSmall.statusCode).toBe(400);
  });

  // ------------------------------------------------------------------ HF-014b two-step holds

  const authorize = (shopperId: string | null, bidId: string, key: string = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `/api/bids/${bidId}/authorize`,
      headers: {
        ...(shopperId ? { cookie: session(shopperId) } : {}),
        'idempotency-key': key,
      },
    });
  const back = (query: string) => app.inject({ method: 'GET', url: `/api/bids/return?${query}` });

  it('CARD → 201 PENDING_APPROVAL {orderId}; card-fields submit → authorize → 200 HELD; replay is stored', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const res = await post(s.id, { listingId: l.id, amountCents: 22_900, paymentMethod: 'CARD' });
    expect(res.statusCode).toBe(201);
    const { bidId, orderId, status } = res.json();
    expect(status).toBe('PENDING_APPROVAL');
    expect(orderId).toEqual(expect.any(String));
    // Card data never reaches our API: the order create carries no card number.
    expect(creates(bidId)).toHaveLength(1);

    // Before the submit: nothing to authorize yet (409 IN_PROGRESS, not stored).
    const early = await authorize(s.id, bidId);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({ code: 'IN_PROGRESS', reason: 'NOT_APPROVED' });

    fake.approve(orderId);
    const key = randomUUID();
    const ok = await authorize(s.id, bidId, key);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      bidId,
      status: 'HELD',
      authorizationId: expect.any(String),
    });
    const again = await authorize(s.id, bidId, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const vault = await tdb.db.pool.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [
      s.id,
    ]);
    expect(vault.rows[0].paypal_vault_id).toEqual(expect.any(String));
  });

  it('authorize another shopper’s bid → 404; no session → 401', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const res = await post(s.id, { listingId: l.id, amountCents: 22_900, paymentMethod: 'CARD' });
    const other = await fx.shopper();
    expect((await authorize(other.id, res.json().bidId)).statusCode).toBe(404);
    expect((await authorize(null, res.json().bidId)).statusCode).toBe(401);
  });

  it('PAYPAL → approveUrl; return → 302 /bids/:id?held=1; a refresh does not authorize twice', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const res = await post(s.id, { listingId: l.id, amountCents: 22_900, paymentMethod: 'PAYPAL' });
    expect(res.statusCode).toBe(201);
    const { bidId, orderId, approveUrl } = res.json();
    expect(approveUrl).toContain(orderId);
    fake.approve(orderId);

    const first = await back(`token=${orderId}&PayerID=TESTPAYER`);
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`/bids/${bidId}?held=1`);
    const authorizes = () => fake.calls.filter((c) => c.requestId === `authz-${bidId}`).length;
    expect(authorizes()).toBe(1);
    const refresh = await back(`token=${orderId}&PayerID=TESTPAYER`);
    expect(refresh.headers.location).toBe(`/bids/${bidId}?held=1`);
    expect(authorizes()).toBe(1);
    expect((await fx.bid(bidId)).status).toBe('HELD');
  });

  it('cancel URL → 302 ?cancelled=1, the bid keeps waiting; window closed → 302 ?error=WINDOW_CLOSED', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const res = await post(s.id, { listingId: l.id, amountCents: 22_900, paymentMethod: 'PAYPAL' });
    const { bidId, orderId } = res.json();
    const cancelled = await back(`cancelled=1&token=${orderId}`);
    expect(cancelled.headers.location).toBe(`/bids/${bidId}?cancelled=1`);
    expect((await fx.bid(bidId)).status).toBe('PENDING_APPROVAL');

    fake.approve(orderId);
    await tdb.db.pool.query(
      `UPDATE listings SET window_closes_at = now() - interval '1 second' WHERE id = $1`,
      [l.id],
    );
    const closed = await back(`token=${orderId}`);
    expect(closed.headers.location).toBe(`/bids/${bidId}?error=WINDOW_CLOSED`);
    expect(fake.calls.some((c) => c.requestId === `authz-${bidId}`)).toBe(false);
    expect((await fx.bid(bidId)).status).toBe('ABANDONED');
  });

  it('unknown or malformed token → 302 /bids?error=NOT_FOUND', async () => {
    expect((await back('token=NOPE123')).headers.location).toBe('/bids?error=NOT_FOUND');
    expect((await back("token=x'%20or%201=1")).headers.location).toBe('/bids?error=NOT_FOUND');
    expect((await back('')).headers.location).toBe('/bids?error=NOT_FOUND');
  });
});
