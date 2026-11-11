/**
 * HF-011a integration tests against a real, freshly migrated Postgres: the admin verify endpoint
 * with admin, non-admin and anonymous sessions, the `admin:verify` CLI, and the publish guard's
 * error envelope. Needs TEST_DATABASE_URL; skipped when unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertBrandVerified, loadConfig } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { adminVerify } from '../admin-verify.js';
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
  NODE_ENV: 'test',
  ADMIN_EMAILS: 'ops@holdfast.example, Admin@Holdfast.Example',
};

let n = 0;
const key = () => ({ 'idempotency-key': `admin-verify-${++n}` });

describe.skipIf(!TEST_DATABASE_URL)('HF-011a admin brand verification (Postgres)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
    });
    // Stand-in for HF-012a's publish route: the guard thrown from a handler.
    app.post(
      '/api/test/publish',
      { onRequest: app.guards.requireBrandUser('MANAGER') },
      async (req) => {
        assertBrandVerified({ verificationStatus: req.auth.brandUser!.brandVerificationStatus });
        return { published: true };
      },
    );
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    tdb.db.pool.query<T>(sql, params).then((r) => r.rows);

  async function brand(status = 'PENDING', domain: string | null = null): Promise<string> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO brands (name, domain, payout_email, verification_status)
       VALUES ('Aurel Audio', $1, 'payouts@aurel.example', $2) RETURNING id`,
      [domain, status],
    );
    return row!.id;
  }

  /** A brand user (reused by email) and a signed session cookie for them. */
  async function session(email: string, role = 'OWNER', brandId?: string) {
    const [u] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3)
       ON CONFLICT ((lower(email))) DO UPDATE SET role = EXCLUDED.role RETURNING id`,
      [brandId ?? (await brand('VERIFIED')), email, role],
    );
    const token = signToken(SECRET, 'brand-session', { sub: u!.id, exp: Date.now() + 60_000 });
    return { userId: u!.id, headers: { cookie: `${BRAND_COOKIE}=${token}` } };
  }

  const verify = (brandId: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/brands/${brandId}/verify`,
      headers: { ...key(), ...headers },
    });

  const auditsFor = (brandId: string) =>
    q(`SELECT actor_type, actor_id, action, data FROM audit_events WHERE entity_id = $1`, [
      brandId,
    ]);

  const statusOf = async (brandId: string) =>
    (
      await q<{ s: string }>(`SELECT verification_status AS s FROM brands WHERE id = $1`, [brandId])
    )[0]!.s;

  it('anonymous → 401 UNAUTHENTICATED; brand stays PENDING', async () => {
    const id = await brand();
    const res = await verify(id);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    expect(await statusOf(id)).toBe('PENDING');
  });

  it('non-admin (even an OWNER of that brand) → 403 FORBIDDEN; no change, no audit', async () => {
    const id = await brand();
    const owner = await session(`owner-${randomUUID()}@aurel.example`, 'OWNER', id);
    const res = await verify(id, owner.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(await statusOf(id)).toBe('PENDING');
    expect(await auditsFor(id)).toHaveLength(0);
  });

  it('admin (case-insensitive ADMIN_EMAILS) → 200 VERIFIED, verified_at, BRAND_VERIFIED audit', async () => {
    const id = await brand('PENDING', 'aurel-admin.example');
    const admin = await session('ADMIN@holdfast.example', 'VIEWER');
    const res = await verify(id, admin.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      brandId: id,
      name: 'Aurel Audio',
      domain: 'aurel-admin.example',
      verificationStatus: 'VERIFIED',
      alreadyVerified: false,
    });
    expect(Number.isNaN(Date.parse(body.verifiedAt))).toBe(false);
    expect(await auditsFor(id)).toEqual([
      {
        actor_type: 'BRAND_USER',
        actor_id: admin.userId,
        action: 'BRAND_VERIFIED',
        data: { admin: true, via: 'api', from: 'PENDING', domain: 'aurel-admin.example' },
      },
    ]);

    const again = await verify(id, admin.headers);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ verificationStatus: 'VERIFIED', alreadyVerified: true });
    expect(await auditsFor(id)).toHaveLength(1);
  });

  it('admin: unknown or malformed id → 404; REJECTED brand → 409 STATE_CONFLICT', async () => {
    const admin = await session('ops@holdfast.example');
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await verify(id, admin.headers);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    const rejected = await brand('REJECTED');
    const res = await verify(rejected, admin.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'STATE_CONFLICT', reason: 'BRAND_REJECTED' });
    expect(await statusOf(rejected)).toBe('REJECTED');
  });

  it('needs an Idempotency-Key; a replay with the same key returns the stored response', async () => {
    const id = await brand();
    const admin = await session(`admin-${randomUUID()}@x.example`);
    // Not on the allowlist: still 400 first, since the key check runs before any guard.
    const noKey = await app.inject({
      method: 'POST',
      url: `/api/admin/brands/${id}/verify`,
      headers: admin.headers,
    });
    expect(noKey.statusCode).toBe(400);

    const ops = await session('Ops@Holdfast.example');
    const headers = { ...ops.headers, 'idempotency-key': `replay-${id}` };
    const first = await app.inject({
      method: 'POST',
      url: `/api/admin/brands/${id}/verify`,
      headers,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/admin/brands/${id}/verify`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.json().alreadyVerified).toBe(false);
  });

  it('publish guard: PENDING brand → 403 BRAND_NOT_VERIFIED; after admin verify → allowed', async () => {
    const id = await brand();
    const manager = await session(`mgr-${randomUUID()}@aurel.example`, 'MANAGER', id);
    const publish = () =>
      app.inject({
        method: 'POST',
        url: '/api/test/publish',
        headers: { ...key(), ...manager.headers },
      });

    const blocked = await publish();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatchObject({
      code: 'BRAND_NOT_VERIFIED',
      verificationStatus: 'PENDING',
    });

    const admin = await session('ops@holdfast.example');
    expect((await verify(id, admin.headers)).statusCode).toBe(200);
    const allowed = await publish();
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ published: true });
  });

  describe('npm run admin:verify <domain>', () => {
    it('verifies the seeded pending aurelaudio.example brand and writes an audit row', async () => {
      const id = await brand('PENDING', 'aurelaudio.example');
      const out = await adminVerify(tdb.db, ['aurelaudio.example']);
      expect(out.exitCode).toBe(0);
      expect(out.message).toMatch(/^Verified Aurel Audio \(aurelaudio\.example/);
      expect(await statusOf(id)).toBe('VERIFIED');
      expect(await auditsFor(id)).toEqual([
        {
          actor_type: 'SYSTEM',
          actor_id: null,
          action: 'BRAND_VERIFIED',
          data: { admin: true, via: 'cli', from: 'PENDING', domain: 'aurelaudio.example' },
        },
      ]);

      const again = await adminVerify(tdb.db, ['https://www.AurelAudio.example/']);
      expect(again).toMatchObject({
        exitCode: 0,
        message: expect.stringMatching(/already verified/),
      });
      expect(await auditsFor(id)).toHaveLength(1);
    });

    it('usage errors and unknown domains exit non-zero', async () => {
      expect((await adminVerify(tdb.db, [])).exitCode).toBe(2);
      expect((await adminVerify(tdb.db, ['a.example', 'b.example'])).exitCode).toBe(2);
      expect((await adminVerify(tdb.db, ['not a domain'])).exitCode).toBe(2);
      expect(await adminVerify(tdb.db, ['nobody.example'])).toEqual({
        exitCode: 1,
        message: 'No brand has the domain nobody.example.',
      });
    });
  });
});
