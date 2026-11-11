/**
 * HF-028: `POST /api/listings/:id/clear` behind the real HF-006 brand session (the wiring
 * `main.ts` uses: no custom `authenticate`). The seeded `DEMO_MODE` VIEWER is refused; the demo
 * OWNER clears. Needs TEST_DATABASE_URL; skipped when unset.
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
import { BRAND_COOKIE } from '../auth/guards.js';
import { DEMO_ACCOUNTS } from '../auth/store.js';
import { buildServer } from '../server.js';

const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: 's'.repeat(40),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
};

let n = 0;
const key = () => ({ 'idempotency-key': `clear-session-${++n}` });

describe.skipIf(!TEST_DATABASE_URL)('Clear behind the brand session (HF-028)', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: t.db,
      clear: { money: { db: t.db, paypal: new StubPayPal(), voidBackoffMs: [0, 0, 0] } },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  async function login(role: 'OWNER' | 'VIEWER'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/demo/brand',
      headers: key(),
      payload: { role },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.headers['set-cookie'];
    const list = (Array.isArray(raw) ? raw : [String(raw)]) as string[];
    const c = list.find((s) => s.startsWith(`${BRAND_COOKIE}=`))!;
    return c.split(';')[0]!;
  }

  async function seedListing(): Promise<string> {
    const one = async (sql: string, params: unknown[] = []) =>
      (await t.db.pool.query(sql, params)).rows[0] as { id: string };
    const { brand_id: brandId } = (
      await t.db.pool.query(`SELECT brand_id FROM brand_users WHERE email = $1`, [
        DEMO_ACCOUNTS.ownerEmail,
      ])
    ).rows[0] as { brand_id: string };
    const product = await one(`INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`);
    const listing = await one(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, window_opens_at, window_closes_at)
       VALUES ($1, $2, 'OPEN', 2, 10000, now(), now() + interval '24 hours') RETURNING id`,
      [brandId, product.id],
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
    return listing.id;
  }

  const clear = (listingId: string, cookie?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/listings/${listingId}/clear`,
      headers: { ...key(), ...(cookie ? { cookie } : {}) },
      payload: { quantity: 2, expectedGrossCents: 50_000 },
    });

  it('no session → 401; demo VIEWER → 403 and nothing changes; demo OWNER → 202', async () => {
    const owner = await login('OWNER');
    const viewer = await login('VIEWER');
    const listingId = await seedListing();

    expect((await clear(listingId)).statusCode).toBe(401);

    const refused = await clear(listingId, viewer);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const { status } = (
      await t.db.pool.query(`SELECT status FROM listings WHERE id = $1`, [listingId])
    ).rows[0] as { status: string };
    expect(status).toBe('OPEN');

    const ok = await clear(listingId, owner);
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ status: 'CLEARING', grossCents: 50_000, winners: 2 });
  });
});
