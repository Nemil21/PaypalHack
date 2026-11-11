/**
 * HF-017b `GET/POST/PATCH /api/mandates` through the real server (guards, CSRF, Idempotency-Key
 * store) on Postgres with the `FakePayPal` stub: CRUD, defaults, tenancy, pause releasing holds,
 * the cap-below-live-holds refusal, and races of cap edits / pause against placements.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/mandates.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditHook,
  FakePayPal,
  loadConfig,
  MANDATE_CAP_STATUSES,
  voidKey,
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
import { RATE_LIMITS, RateLimiter } from '../http/rate-limit.js';
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
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)('HF-017b mandate routes', () => {
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
      // Races fire many requests from one shopper; give the REST limiter room.
      limiter: new RateLimiter({ ...RATE_LIMITS, rest: 10_000 }),
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

  const send = (
    method: 'POST' | 'PATCH',
    shopperId: string | null,
    url: string,
    payload: unknown,
    key: string = randomUUID(),
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(shopperId ? { cookie: session(shopperId) } : {}),
        'idempotency-key': key,
      },
      payload: payload as Record<string, unknown>,
    });
  const get = (shopperId: string | null, url: string) =>
    app.inject({ method: 'GET', url, headers: shopperId ? { cookie: session(shopperId) } : {} });

  const create = (shopperId: string, body: Record<string, unknown>, key?: string) =>
    send('POST', shopperId, '/api/mandates', body, key);
  const patch = (shopperId: string, id: string, body: Record<string, unknown>, key?: string) =>
    send('PATCH', shopperId, `/api/mandates/${id}`, body, key);

  async function productOf(listingId: string): Promise<string> {
    const r = await tdb.db.pool.query(`SELECT product_id FROM listings WHERE id = $1`, [listingId]);
    return (r.rows[0] as { product_id: string }).product_id;
  }

  async function placeUnder(
    listingId: string,
    shopperId: string,
    mandateId: string,
    cents: number,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/bids',
      headers: { cookie: session(shopperId), 'idempotency-key': randomUUID() },
      payload: { listingId, amountCents: cents, paymentMethod: 'TEST_CARD', mandateId },
    });
  }

  async function liveSum(mandateId: string): Promise<number> {
    const r = await tdb.db.pool.query(
      `SELECT coalesce(sum(amount_cents), 0)::int AS s FROM bids
        WHERE mandate_id = $1 AND status = ANY($2::text[])`,
      [mandateId, MANDATE_CAP_STATUSES],
    );
    return (r.rows[0] as { s: number }).s;
  }

  async function auditActions(mandateId: string): Promise<string[]> {
    const r = await tdb.db.pool.query(
      `SELECT action FROM audit_events WHERE entity = 'mandate' AND entity_id = $1 ORDER BY at, id`,
      [mandateId],
    );
    return (r.rows as { action: string }[]).map((x) => x.action);
  }

  it('POST applies the defaults (cap = max price, 30 days, auto-roll + notify on) and audits', async () => {
    const s = await fx.shopper();
    const key = randomUUID();
    const res = await create(s.id, { maxPriceCents: 23_000 }, key);
    expect(res.statusCode).toBe(201);
    const m = res.json().mandate;
    expect(m).toMatchObject({
      status: 'ACTIVE',
      state: 'active',
      maxPriceCents: 23_000,
      totalHoldCapCents: 23_000,
      productIds: [],
      autoRoll: true,
      notifyEveryAction: true,
      needsPaymentMethod: true,
      savedPaymentMethod: false,
      liveHoldCents: 0,
      liveHolds: [],
    });
    const days = (Date.parse(m.expiresAt) - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(await auditActions(m.mandateId)).toEqual(['MANDATE_CREATED']);

    const replay = await create(s.id, { maxPriceCents: 23_000 }, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().mandate.mandateId).toBe(m.mandateId);
  });

  it('POST stores products, toggles and expiry; flags no payment method only when none is vaulted', async () => {
    const l = await fx.listing();
    const productId = await productOf(l.id);
    const s = await fx.shopper();
    await tdb.db.pool.query(`UPDATE shoppers SET paypal_vault_id = 'VAULT-1' WHERE id = $1`, [
      s.id,
    ]);
    const expiresAt = new Date(Date.now() + 7 * DAY_MS).toISOString();
    const res = await create(s.id, {
      maxPriceCents: 23_000,
      totalHoldCapCents: 46_000,
      productIds: [productId, productId],
      autoRoll: false,
      notifyEveryAction: false,
      expiresAt,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().mandate).toMatchObject({
      totalHoldCapCents: 46_000,
      productIds: [productId],
      products: [{ productId, title: 'Aurel One' }],
      autoRoll: false,
      notifyEveryAction: false,
      needsPaymentMethod: false,
      savedPaymentMethod: true,
      expiresAt,
    });
  });

  it('POST validates: cap below max, past expiry, unknown product, bad amounts, no key, no session', async () => {
    const s = await fx.shopper();
    const bad = [
      { maxPriceCents: 23_000, totalHoldCapCents: 10_000 },
      { maxPriceCents: 23_000, expiresAt: new Date(Date.now() - DAY_MS).toISOString() },
      { maxPriceCents: 23_000, productIds: [randomUUID()] },
      { maxPriceCents: 50 },
      { maxPriceCents: 230.5 },
      { maxPriceCents: 23_000, status: 'PAUSED' },
    ];
    for (const body of bad) {
      const res = await create(s.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    const noKey = await app.inject({
      method: 'POST',
      url: '/api/mandates',
      headers: { cookie: session(s.id) },
      payload: { maxPriceCents: 23_000 },
    });
    expect(noKey.statusCode).toBe(400);
    expect((await send('POST', null, '/api/mandates', { maxPriceCents: 23_000 })).statusCode).toBe(
      401,
    );
    const count = await tdb.db.pool.query(
      `SELECT count(*)::int AS n FROM mandates WHERE shopper_id = $1`,
      [s.id],
    );
    expect((count.rows[0] as { n: number }).n).toBe(0);
  });

  it('GET lists only my mandates with live holds; another shopper gets 404 on GET and PATCH', async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const other = await fx.shopper();
    const mine = (await create(s.id, { maxPriceCents: 25_000, totalHoldCapCents: 50_000 })).json()
      .mandate;
    await create(other.id, { maxPriceCents: 10_000 });
    const placed = await placeUnder(l.id, s.id, mine.mandateId, 22_900);
    expect(placed.statusCode).toBe(201);

    expect((await get(null, '/api/mandates')).statusCode).toBe(401);
    const list = await get(s.id, '/api/mandates');
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.mandates).toHaveLength(1);
    expect(body.mandates[0]).toMatchObject({
      mandateId: mine.mandateId,
      liveHoldCents: 22_900,
      liveHolds: [
        {
          bidId: placed.json().bidId,
          status: 'HELD',
          amountCents: 22_900,
          productTitle: 'Aurel One',
        },
      ],
    });
    expect(body.productOptions.map((p: { productId: string }) => p.productId)).toContain(
      await productOf(l.id),
    );

    for (const res of [
      await get(other.id, `/api/mandates/${mine.mandateId}`),
      await get(s.id, `/api/mandates/${randomUUID()}`),
      await get(s.id, '/api/mandates/not-a-uuid'),
      await patch(other.id, mine.mandateId, { maxPriceCents: 1_000 }),
      await patch(other.id, mine.mandateId, { status: 'PAUSED' }),
      await patch(s.id, 'not-a-uuid', { status: 'PAUSED' }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    const after = (await get(s.id, `/api/mandates/${mine.mandateId}`)).json().mandate;
    expect(after).toMatchObject({ status: 'ACTIVE', maxPriceCents: 25_000, liveHoldCents: 22_900 });
  });

  it('PATCH edits limits and toggles, audits MANDATE_UPDATED with the changes', async () => {
    const l = await fx.listing();
    const productId = await productOf(l.id);
    const s = await fx.shopper();
    const m = (await create(s.id, { maxPriceCents: 23_000 })).json().mandate;
    const expiresAt = new Date(Date.now() + 10 * DAY_MS).toISOString();
    const res = await patch(s.id, m.mandateId, {
      maxPriceCents: 24_000,
      totalHoldCapCents: 48_000,
      productIds: [productId],
      autoRoll: false,
      notifyEveryAction: false,
      expiresAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mandate).toMatchObject({
      maxPriceCents: 24_000,
      totalHoldCapCents: 48_000,
      productIds: [productId],
      autoRoll: false,
      notifyEveryAction: false,
      expiresAt,
    });
    const r = await tdb.db.pool.query(
      `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'MANDATE_UPDATED'`,
      [m.mandateId],
    );
    expect(r.rows).toHaveLength(1);
    expect(Object.keys((r.rows[0] as { data: { changes: object } }).data.changes).sort()).toEqual([
      'autoRoll',
      'expiresAt',
      'maxPriceCents',
      'notifyEveryAction',
      'productIds',
      'totalHoldCapCents',
    ]);

    // No-op edit: 200, nothing audited.
    expect((await patch(s.id, m.mandateId, { autoRoll: false })).statusCode).toBe(200);
    expect(await auditActions(m.mandateId)).toEqual(['MANDATE_CREATED', 'MANDATE_UPDATED']);

    // Max price above the stored cap → refused.
    const over = await patch(s.id, m.mandateId, { maxPriceCents: 60_000 });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'totalHoldCapCents',
    });
  });

  it('lowering the cap below the live holds is refused with a clear message', async () => {
    const l1 = await fx.listing();
    const l2 = await fx.listing();
    const s = await fx.shopper();
    const m = (await create(s.id, { maxPriceCents: 25_000, totalHoldCapCents: 50_000 })).json()
      .mandate;
    expect((await placeUnder(l1.id, s.id, m.mandateId, 22_900)).statusCode).toBe(201);
    expect((await placeUnder(l2.id, s.id, m.mandateId, 22_900)).statusCode).toBe(201);

    const res = await patch(s.id, m.mandateId, { totalHoldCapCents: 30_000 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'MANDATE_EXCEEDED',
      reason: 'CAP_BELOW_LIVE_HOLDS',
      liveHoldCents: 45_800,
    });
    expect(res.json().error.message).toBe(
      'Your live holds under this mandate total $458. Set a total cap of at least $458, or release a hold first.',
    );
    expect((await get(s.id, `/api/mandates/${m.mandateId}`)).json().mandate.totalHoldCapCents).toBe(
      50_000,
    );
    // Exactly the live total is fine.
    expect((await patch(s.id, m.mandateId, { totalHoldCapCents: 45_800 })).statusCode).toBe(200);
  });

  it('pause releases every live hold on PayPal and the list updates; resume re-activates', async () => {
    const l1 = await fx.listing();
    const l2 = await fx.listing();
    const s = await fx.shopper();
    const m = (await create(s.id, { maxPriceCents: 25_000, totalHoldCapCents: 50_000 })).json()
      .mandate;
    const b1 = (await placeUnder(l1.id, s.id, m.mandateId, 22_900)).json();
    const b2 = (await placeUnder(l2.id, s.id, m.mandateId, 21_000)).json();

    const key = randomUUID();
    const res = await patch(s.id, m.mandateId, { status: 'PAUSED' }, key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mandate: { status: 'PAUSED', state: 'paused', liveHoldCents: 0, liveHolds: [] },
      release: { voided: 2, releasing: 0 },
    });
    for (const b of [b1, b2]) {
      expect(fake.authorization(b.authorizationId)?.status).toBe('VOIDED');
      expect(await fx.bid(b.bidId)).toMatchObject({
        status: 'VOIDED',
        void_reason: 'MANDATE_PAUSED',
      });
    }
    const replay = await patch(s.id, m.mandateId, { status: 'PAUSED' }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const again = await patch(s.id, m.mandateId, { status: 'PAUSED' });
    expect(again.statusCode).toBe(200);
    for (const b of [b1, b2]) {
      expect(
        fake.calls.filter((c) => c.op === 'void' && c.requestId === voidKey(b.bidId)),
      ).toHaveLength(1);
    }
    const list = (await get(s.id, '/api/mandates')).json();
    expect(list.mandates[0]).toMatchObject({ state: 'paused', liveHoldCents: 0 });

    // A paused mandate refuses new holds; resume lets them through again.
    const refused = await placeUnder(l1.id, s.id, m.mandateId, 20_000);
    expect(refused.statusCode).not.toBe(201);
    const resumed = await patch(s.id, m.mandateId, { status: 'ACTIVE', maxPriceCents: 24_000 });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().mandate).toMatchObject({
      status: 'ACTIVE',
      maxPriceCents: 24_000,
      pausedAt: null,
    });
    expect((await placeUnder(l1.id, s.id, m.mandateId, 20_000)).statusCode).toBe(201);
    expect(await auditActions(m.mandateId)).toEqual([
      'MANDATE_CREATED',
      'MANDATE_PAUSED',
      'MANDATE_UPDATED',
    ]);

    // Pause must be sent alone.
    const mixed = await patch(s.id, m.mandateId, { status: 'PAUSED', maxPriceCents: 1_000 });
    expect(mixed.statusCode).toBe(400);
  });

  it('a FULFILLED mandate cannot be edited, paused or resumed (409)', async () => {
    const s = await fx.shopper();
    const m = (await create(s.id, { maxPriceCents: 23_000 })).json().mandate;
    await tdb.db.pool.query(`UPDATE mandates SET status = 'FULFILLED' WHERE id = $1`, [
      m.mandateId,
    ]);
    for (const body of [{ maxPriceCents: 20_000 }, { status: 'PAUSED' }, { status: 'ACTIVE' }]) {
      const res = await patch(s.id, m.mandateId, body);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'STATE_CONFLICT',
        reason: 'MANDATE_FULFILLED',
      });
    }
    expect((await get(s.id, `/api/mandates/${m.mandateId}`)).json().mandate.state).toBe(
      'fulfilled',
    );
  });

  it('race: lowering the cap while 8 placements run never leaves live holds above the cap', async () => {
    // Stagger the PATCH so some rounds lower the cap first and others after holds have landed.
    const outcomes = new Set<number>();
    for (const delayMs of [0, 2, 5, 10, 20, 60, 120]) {
      const listings = await Promise.all(Array.from({ length: 8 }, () => fx.listing()));
      const s = await fx.shopper();
      const m = (await create(s.id, { maxPriceCents: 20_000, totalHoldCapCents: 160_000 })).json()
        .mandate;
      const placing = listings.map((l) => placeUnder(l.id, s.id, m.mandateId, 20_000));
      await new Promise((r) => setTimeout(r, delayMs));
      const [cap, ...placed] = await Promise.all([
        patch(s.id, m.mandateId, { totalHoldCapCents: 60_000 }),
        ...placing,
      ]);
      outcomes.add(cap!.statusCode);
      const live = await liveSum(m.mandateId);
      const finalCap = (await get(s.id, `/api/mandates/${m.mandateId}`)).json().mandate
        .totalHoldCapCents as number;
      expect(live).toBeLessThanOrEqual(finalCap);
      if (cap!.statusCode === 200) {
        expect(finalCap).toBe(60_000);
        expect(placed.filter((p) => p.statusCode === 201).length).toBeLessThanOrEqual(3);
      } else {
        expect(cap!.statusCode).toBe(422);
        expect(cap!.json().error.liveHoldCents).toBeGreaterThan(60_000);
        expect(finalCap).toBe(160_000);
      }
    }
    // Both orders were exercised (cap first → 200; holds first → 422).
    expect([...outcomes].sort()).toEqual([200, 422]);
  });

  it('race: pause while placements run leaves no HELD bid and no live PayPal hold', async () => {
    const listings = await Promise.all(Array.from({ length: 6 }, () => fx.listing()));
    const s = await fx.shopper();
    const m = (await create(s.id, { maxPriceCents: 20_000, totalHoldCapCents: 200_000 })).json()
      .mandate;
    const [pause, ...placed] = await Promise.all([
      patch(s.id, m.mandateId, { status: 'PAUSED' }),
      ...listings.map((l) => placeUnder(l.id, s.id, m.mandateId, 20_000)),
    ]);
    expect(pause!.statusCode).toBe(200);
    // Landed before the pause → released by it; still in flight → landHold sees PAUSED and voids.
    const r = await tdb.db.pool.query(
      `SELECT id, status, paypal_authorization_id FROM bids WHERE mandate_id = $1`,
      [m.mandateId],
    );
    const bids = r.rows as { id: string; status: string; paypal_authorization_id: string | null }[];
    expect(bids.length).toBeLessThanOrEqual(placed.length);
    for (const b of bids) {
      expect(['VOIDED', 'VOIDING']).toContain(b.status);
      if (b.paypal_authorization_id) {
        expect(fake.authorization(b.paypal_authorization_id)?.status).not.toBe('CREATED');
      }
    }
  });
});
