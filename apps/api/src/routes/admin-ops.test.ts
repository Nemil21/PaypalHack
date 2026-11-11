/**
 * HF-058 W20 routes against a real, freshly migrated Postgres and `FakePayPal`: admin gating,
 * `GET /api/admin/audit` by capture id, `POST /api/admin/void-dangling` (the HF-034 sweeper,
 * audited as the admin; 409 while the sweeper runs), every W20 action leaving an admin audit row,
 * and `GET /api/admin/health`. Needs TEST_DATABASE_URL; skipped when unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditHook,
  CRON_JOB_IDS,
  cronLockName,
  FakePayPal,
  loadConfig,
  orderRequestId,
  paypalTokenProbe,
  SANDBOX_TEST_CARD,
  settleBid,
  type PayPalClient,
} from '@holdfast/core';
// Test-only harnesses (throwaway migrated database, settlement seed); not part of the package API.
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { seedSettlement } from '../../../../packages/core/src/settlement/test-fixtures.js';
import { BRAND_COOKIE } from '../auth/guards.js';
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
  ADMIN_EMAILS: 'ops@holdfast.example',
};

let n = 0;
const key = () => ({ 'idempotency-key': `admin-ops-${++n}` });

describe.skipIf(!TEST_DATABASE_URL)(
  'HF-058 admin ops routes (Postgres)',
  { timeout: 60_000 },
  () => {
    let tdb: TestDatabase;
    let app: ReturnType<typeof buildServer>;
    let fake: FakePayPal;
    let client: PayPalClient;

    const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      tdb.db.pool.query<T>(sql, params).then((r) => r.rows);

    beforeAll(async () => {
      tdb = await createTestDatabase();
      fake = new FakePayPal();
      client = fake.client();
      const sweep = {
        db: tdb.db,
        paypal: client,
        audit: auditHook,
        voidBackoffMs: [],
        sleep: async () => {},
        allowTestCard: true,
        appBaseUrl: 'http://localhost:3000',
      };
      app = buildServer(loadConfig(ENV), {
        webDistDir: null,
        sql: tdb.db,
        db: tdb.db.pool,
        limiter: new RateLimiter(),
        ops: { paypalToken: paypalTokenProbe(client), sweep },
      });
    }, 60_000);
    afterAll(async () => {
      await app?.close();
      await tdb?.close();
    });

    async function session(email: string, role = 'OWNER') {
      const [b] = await q<{ id: string }>(
        `INSERT INTO brands (name, payout_email, verification_status)
       VALUES ('Ops Brand', 'payouts@ops.example', 'VERIFIED') RETURNING id`,
      );
      const [u] = await q<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3)
       ON CONFLICT ((lower(email))) DO UPDATE SET role = EXCLUDED.role RETURNING id`,
        [b!.id, email, role],
      );
      const token = signToken(SECRET, 'brand-session', { sub: u!.id, exp: Date.now() + 60_000 });
      return { userId: u!.id, headers: { cookie: `${BRAND_COOKIE}=${token}` } };
    }

    /** A real capture on the fake, settled by HF-029's `settleBid`. */
    async function captured() {
      const s = await seedSettlement(tdb.db, client, { action: 'CAPTURE' });
      await settleBid(
        { db: tdb.db, paypal: client, backoffMs: [], sleep: async () => {} },
        s.settlementId,
      );
      const [row] = await q<{ paypal_id: string }>(
        `SELECT paypal_id FROM settlements WHERE id = $1`,
        [s.settlementId],
      );
      return { ...s, captureId: row!.paypal_id };
    }

    describe('admin gating', () => {
      const routes = [
        { method: 'GET' as const, url: '/api/admin/audit' },
        { method: 'GET' as const, url: '/api/admin/health' },
        { method: 'POST' as const, url: '/api/admin/void-dangling' },
      ];
      it.each(routes)('$method $url: anonymous 401, non-admin owner 403', async (r) => {
        const anon = await app.inject({ ...r, headers: key() });
        expect(anon.statusCode).toBe(401);
        const owner = await session(`owner-${randomUUID()}@brand.example`);
        const res = await app.inject({ ...r, headers: { ...key(), ...owner.headers } });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      });
    });

    it('GET /api/admin/audit?q=<capture id> finds the capture event', async () => {
      const admin = await session('ops@holdfast.example', 'VIEWER');
      const c = await captured();
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/audit?q=${encodeURIComponent(c.captureId)}`,
        headers: admin.headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      const hit = body.rows.find(
        (r: { action: string; direct: boolean }) => r.action === 'CAPTURE_SUCCEEDED' && r.direct,
      );
      expect(hit).toMatchObject({
        paypalId: c.captureId,
        entity: 'settlement',
        entityId: c.settlementId,
        listingId: c.listingId,
      });
    });

    it('GET /api/admin/audit validates its query', async () => {
      const admin = await session('ops@holdfast.example', 'VIEWER');
      for (const qs of ['brandId=nope', 'from=yesterday', 'limit=0', 'beforeId=abc', 'bogus=1']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/admin/audit?${qs}`,
          headers: admin.headers,
        });
        expect(res.statusCode, qs).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('POST /api/admin/void-dangling voids a dangling hold through the sweeper; audited as the admin', async () => {
      const admin = await session('ops@holdfast.example', 'VIEWER');
      // A HELD bid with a live authorization on an EXPIRED listing.
      const [b] = await q<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'p@aurel.example') RETURNING id`,
      );
      const [p] = await q<{ id: string }>(
        `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
      );
      const [l] = await q<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, 'EXPIRED', 1, 10000, now() - interval '3 days', now() - interval '1 day')
       RETURNING id`,
        [b!.id, p!.id],
      );
      const [s] = await q<{ id: string }>(
        `INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`,
      );
      const [bid] = await q<{ id: string }>(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key)
       VALUES ($1, $2, 20000, 'HELD', gen_random_uuid()::text) RETURNING id`,
        [l!.id, s!.id],
      );
      const hold = await client.createAuthOrder({
        requestId: orderRequestId(bid!.id),
        amountCents: 20_000,
        paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD },
      });
      if (hold.kind !== 'held') throw new Error('no hold');
      await q(
        `UPDATE bids SET paypal_order_id = $2, paypal_authorization_id = $3,
              authorized_amount_cents = amount_cents, authorized_at = now() - interval '2 days'
        WHERE id = $1`,
        [bid!.id, hold.orderId, hold.authorizationId],
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/void-dangling',
        headers: { ...key(), ...admin.headers },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.voided).toBeGreaterThanOrEqual(1);
      expect(fake.authorization(hold.authorizationId)?.status).toBe('VOIDED');

      const rows = await q<{ action: string; actor_type: string; actor_id: string }>(
        `SELECT action, actor_type, actor_id FROM audit_events
        WHERE entity = 'ops' ORDER BY id DESC LIMIT 2`,
      );
      expect(rows.map((r) => r.action).sort()).toEqual([
        'ADMIN_VOID_DANGLING_COMPLETED',
        'ADMIN_VOID_DANGLING_REQUESTED',
      ]);
      expect(rows.every((r) => r.actor_type === 'ADMIN' && r.actor_id === admin.userId)).toBe(true);

      // The admin action is itself searchable in W20.
      const search = await app.inject({
        method: 'GET',
        url: '/api/admin/audit?entity=ops&action=ADMIN_VOID_DANGLING_COMPLETED',
        headers: admin.headers,
      });
      expect(search.json().rows[0]).toMatchObject({ actorType: 'ADMIN', actorId: admin.userId });
    });

    it('POST /api/admin/void-dangling answers 409 SWEEP_RUNNING while the sweeper holds its lock', async () => {
      const admin = await session('ops@holdfast.example', 'VIEWER');
      const lock = await tdb.db.pool.connect();
      const name = cronLockName(CRON_JOB_IDS.holdSweeper);
      try {
        await lock.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [name]);
        const res = await app.inject({
          method: 'POST',
          url: '/api/admin/void-dangling',
          headers: { ...key(), ...admin.headers },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toMatchObject({ code: 'STATE_CONFLICT', reason: 'SWEEP_RUNNING' });
      } finally {
        await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [name]);
        lock.release();
      }
    });

    it('every W20 action is audited as the admin: verify brand, retry settlement (refused after SETTLED)', async () => {
      const admin = await session('ops@holdfast.example', 'VIEWER');
      const [pending] = await q<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('New Brand', 'p@new.example') RETURNING id`,
      );
      const verify = await app.inject({
        method: 'POST',
        url: `/api/admin/brands/${pending!.id}/verify`,
        headers: { ...key(), ...admin.headers },
      });
      expect(verify.statusCode).toBe(200);

      const c = await captured();
      // Clear's settlement run for the listing (still CLEARING).
      await q(`INSERT INTO settlement_runs (listing_id) VALUES ($1)`, [c.listingId]);
      const retry = await app.inject({
        method: 'POST',
        url: `/api/admin/listings/${c.listingId}/retry-settlement`,
        headers: { ...key(), ...admin.headers },
      });
      expect(retry.statusCode).toBe(202);
      await q(`UPDATE listings SET status = 'SETTLED' WHERE id = $1`, [c.listingId]);
      const refused = await app.inject({
        method: 'POST',
        url: `/api/admin/listings/${c.listingId}/retry-settlement`,
        headers: { ...key(), ...admin.headers },
      });
      expect(refused.statusCode).toBe(409);

      const audited = await app.inject({
        method: 'GET',
        url: `/api/admin/audit?q=${pending!.id}`,
        headers: admin.headers,
      });
      expect(audited.json().rows.map((r: { action: string }) => r.action)).toContain(
        'BRAND_VERIFIED',
      );
      const retries = await q<{ actor_type: string; actor_id: string }>(
        `SELECT actor_type, actor_id FROM audit_events
        WHERE listing_id = $1 AND action = 'SETTLEMENT_RETRY_REQUESTED'`,
        [c.listingId],
      );
      expect(retries).toEqual([{ actor_type: 'ADMIN', actor_id: admin.userId }]);
    });

    it('GET /api/admin/health answers the four tiles', async () => {
      const admin = await session('ops@holdfast.example', 'VIEWER');
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/health',
        headers: admin.headers,
      });
      expect(res.statusCode).toBe(200);
      const h = res.json();
      expect(h.paypal).toMatchObject({ ok: true, mode: 'stub' });
      expect(h).toHaveProperty('channel3.ok');
      expect(h).toHaveProperty('settlementQueue.depth');
      expect(h).toHaveProperty('webhooks.lastHour.paypal');
      expect(['healthy', 'degraded']).toContain(h.status);
    });
  },
);
