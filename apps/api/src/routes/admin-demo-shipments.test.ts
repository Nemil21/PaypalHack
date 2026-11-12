/**
 * v4 §3.6 demo "Mark delivered" (`POST /api/admin/shipments/:id/advance`) against a real, freshly
 * migrated Postgres: 404 when DEMO_MODE is off (not registered), admin only, SHIPPED →
 * OUT_FOR_DELIVERY → DELIVERED in order by shipment id or bid id, audited, then 409.
 * Needs TEST_DATABASE_URL; skipped when unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakePayPal, loadConfig } from '@holdfast/core';
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

const key = () => ({ 'idempotency-key': randomUUID() });

describe.skipIf(!TEST_DATABASE_URL)(
  'v4 demo Mark delivered (Postgres)',
  { timeout: 60_000 },
  () => {
    let tdb: TestDatabase;
    let demo: ReturnType<typeof buildServer>;
    let live: ReturnType<typeof buildServer>;
    const fake = new FakePayPal();

    const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      tdb.db.pool.query<T>(sql, params).then((r) => r.rows);

    beforeAll(async () => {
      tdb = await createTestDatabase();
      const deps = { webDistDir: null, sql: tdb.db, db: tdb.db.pool, limiter: new RateLimiter() };
      demo = buildServer(loadConfig({ ...ENV, DEMO_MODE: 'true' }), deps);
      live = buildServer(loadConfig({ ...ENV, DEMO_MODE: 'false' }), deps);
    }, 60_000);
    afterAll(async () => {
      await demo?.close();
      await live?.close();
      await tdb?.close();
    });

    async function session(email: string) {
      const [b] = await q<{ id: string }>(
        `INSERT INTO brands (name, payout_email, verification_status)
         VALUES ('Ops Brand', 'payouts@ops.example', 'VERIFIED') RETURNING id`,
      );
      const [u] = await q<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER')
         ON CONFLICT ((lower(email))) DO UPDATE SET role = EXCLUDED.role RETURNING id`,
        [b!.id, email],
      );
      const token = signToken(SECRET, 'brand-session', { sub: u!.id, exp: Date.now() + 60_000 });
      return { userId: u!.id, headers: { cookie: `${BRAND_COOKIE}=${token}` } };
    }

    async function shipment(status: string) {
      const s = await seedSettlement(tdb.db, fake.client(), { action: 'CAPTURE' });
      const [row] = await q<{ id: string }>(
        `INSERT INTO shipments (bid_id, listing_id, carrier, tracking_number, status, shipped_at)
         VALUES ($1, $2, 'UPS', '1Z999', $3, now()) RETURNING id`,
        [s.bidId, s.listingId, status],
      );
      return { shipmentId: row!.id, bidId: s.bidId };
    }

    const advance = (
      app: ReturnType<typeof buildServer>,
      id: string,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/admin/shipments/${id}/advance`,
        headers: { ...key(), ...headers },
      });

    it('is not registered when DEMO_MODE=false (404, even for an admin)', async () => {
      const admin = await session('ops@holdfast.example');
      const { shipmentId } = await shipment('SHIPPED');
      const res = await advance(live, shipmentId, admin.headers);
      expect(res.statusCode).toBe(404);
      const [row] = await q<{ status: string }>(`SELECT status FROM shipments WHERE id = $1`, [
        shipmentId,
      ]);
      expect(row!.status).toBe('SHIPPED');
    });

    it('admin only: anonymous 401, non-admin owner 403', async () => {
      const { shipmentId } = await shipment('SHIPPED');
      expect((await advance(demo, shipmentId)).statusCode).toBe(401);
      const owner = await session(`owner-${randomUUID()}@brand.example`);
      expect((await advance(demo, shipmentId, owner.headers)).statusCode).toBe(403);
    });

    it('advances SHIPPED → OUT_FOR_DELIVERY → DELIVERED in order, audited, then 409', async () => {
      const admin = await session('ops@holdfast.example');
      const { shipmentId, bidId } = await shipment('SHIPPED');

      const first = await advance(demo, shipmentId, admin.headers);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        from: 'SHIPPED',
        shipment: { shipmentId, status: 'OUT_FOR_DELIVERY' },
      });
      // The bid id works too (the Ops search finds either).
      const second = await advance(demo, bidId, admin.headers);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        from: 'OUT_FOR_DELIVERY',
        shipment: { status: 'DELIVERED' },
      });
      const third = await advance(demo, shipmentId, admin.headers);
      expect(third.statusCode).toBe(409);
      expect(third.json().error).toMatchObject({
        code: 'STATE_CONFLICT',
        reason: 'ALREADY_DELIVERED',
      });

      const audits = await q<{ actor_type: string; actor_id: string; data: { to: string } }>(
        `SELECT actor_type, actor_id, data FROM audit_events
          WHERE action = 'SHIPMENT_ADVANCED' AND entity_id = $1 ORDER BY id`,
        [shipmentId],
      );
      expect(audits.map((a) => a.data.to)).toEqual(['OUT_FOR_DELIVERY', 'DELIVERED']);
      expect(audits.every((a) => a.actor_type === 'ADMIN' && a.actor_id === admin.userId)).toBe(
        true,
      );
    });

    it('refuses a shipment PayPal has not tracked yet (409 NOT_SHIPPED) and unknown ids (404)', async () => {
      const admin = await session('ops@holdfast.example');
      const { shipmentId } = await shipment('PENDING');
      const res = await advance(demo, shipmentId, admin.headers);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.reason).toBe('NOT_SHIPPED');
      expect((await advance(demo, randomUUID(), admin.headers)).statusCode).toBe(404);
      expect((await advance(demo, 'not-a-uuid', admin.headers)).statusCode).toBe(404);
    });
  },
);
