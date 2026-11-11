/**
 * HF-026 `GET /api/brands/me/overview` (W04) over HTTP against seeded data: a listing settled on
 * `FakePayPal` (real captures, one SIM winner, a pending payout), an OPEN listing with live,
 * pending and released bids, a draft, and a second brand. Checks the KPIs, the cards and their
 * sparklines, tenancy both ways, and that the activity feed carries no shopper emails or PayPal
 * ids even when audit `data` holds them. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/brand-overview
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, makePayoutBrand, settleListing } from '@holdfast/core';
import { feeCents, netCents, type BrandOverview } from '@holdfast/shared';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { FakePayPal } from '../../../../packages/core/src/paypal/fake.js';
import {
  seedClearedListing,
  type ClearedListing,
} from '../../../../packages/core/src/settlement/test-fixtures.js';
import { BRAND_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'e'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  CHANNEL3_MODE: 'fixtures',
};
const PAYER_ID = 'PAYERX7QZ9LMN';

describe.skipIf(!TEST_DATABASE_URL)('HF-026 brand overview', { timeout: 60_000 }, () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let cleared: ClearedListing;
  let brandA: string;
  let ownerA: string;
  let viewerA: string;
  let ownerB: string;
  let ownerC: string;
  let openA: string;
  let draftA: string;
  let openB: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const cookie = (userId: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`;
  const overview = async (userId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands/me/overview',
      headers: { cookie: cookie(userId) },
    });
    expect(res.statusCode).toBe(200);
    return { body: res.json<BrandOverview>(), raw: res.body };
  };
  const user = async (brandId: string, role: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
        [brandId, `${randomUUID()}@brand.example`, role],
      )
    ).id;
  const listing = async (brandId: string, status: string, title: string) => {
    const p = await one<{ id: string }>(`INSERT INTO products (title) VALUES ($1) RETURNING id`, [
      title,
    ]);
    const open = status !== 'DRAFT';
    return (
      await one<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, slug,
                               window_opens_at, window_closes_at, clear_deadline_at)
         VALUES ($1, $2, $3, 10, 20000, $4,
                 CASE WHEN $5 THEN now() - interval '3 hours' END,
                 CASE WHEN $5 THEN now() + interval '20 hours' END,
                 CASE WHEN $5 THEN now() + interval '26 hours' END)
         RETURNING id`,
        [
          brandId,
          p.id,
          status,
          `${title.toLowerCase().replace(/\W+/g, '-')}-${randomUUID().slice(0, 4)}`,
          open,
        ],
      )
    ).id;
  };
  /** A bid placed `minutesAgo`; `auth` set = a PayPal hold landed. */
  const bid = async (
    listingId: string,
    amountCents: number,
    status: string,
    minutesAgo: number,
    auth: string | null,
    voidReason: string | null = null,
  ) => {
    const shopper = await one<{ id: string }>(
      `INSERT INTO shoppers (email, display_name) VALUES ($1, 'Pat Secret') RETURNING id`,
      [`secret-${randomUUID()}@shopper.example`],
    );
    return (
      await one<{ id: string }>(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key,
                           paypal_authorization_id, authorized_amount_cents, authorized_at,
                           placed_at, void_reason)
         VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5,
                 CASE WHEN $5::text IS NOT NULL THEN $3::int END,
                 CASE WHEN $5::text IS NOT NULL THEN now() - make_interval(mins => $6) END,
                 now() - make_interval(mins => $6), $7)
         RETURNING id`,
        [listingId, shopper.id, amountCents, status, auth, minutesAgo, voidReason],
      )
    ).id;
  };
  const auditRow = (
    listingId: string,
    action: string,
    actorType: string,
    data: Record<string, unknown>,
  ) =>
    tdb.db.pool.query(
      `INSERT INTO audit_events (actor_type, actor_id, brand_id, listing_id, entity, entity_id,
                                 action, paypal_id, request_id, data)
       SELECT $2, 'shopper-actor-' || gen_random_uuid(), brand_id, id, 'bid', gen_random_uuid(),
              $3, $4, 'void-request-id-x', $5
         FROM listings WHERE id = $1`,
      [listingId, actorType, action, PAYER_ID, JSON.stringify(data)],
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
    });
    const client = new FakePayPal().client();

    // Brand A, listing 1: cleared and settled. Winner 3 is a SIM bid (never recovered money).
    cleared = await seedClearedListing(tdb.db, client, { winners: 3, reserve: 1, belowFloor: 1 });
    brandA = (
      await one<{ brand_id: string }>(`SELECT brand_id FROM listings WHERE id = $1`, [
        cleared.listingId,
      ])
    ).brand_id;
    await tdb.db.pool.query(`UPDATE bids SET source = 'SIM' WHERE id = $1`, [
      cleared.winners[2]!.bidId,
    ]);
    await tdb.db.pool.query(
      `UPDATE shoppers SET email = 'secret-' || id || '@shopper.example'
        WHERE id IN (SELECT shopper_id FROM bids WHERE listing_id = $1)`,
      [cleared.listingId],
    );
    const settled = await settleListing(
      {
        db: tdb.db,
        paypal: client,
        sleep: async () => {},
        allowMockDecline: true,
        pollMs: 20,
        retryDelaySeconds: 0,
        payoutBrand: makePayoutBrand({ db: tdb.db, paypal: client }),
      },
      cleared.listingId,
    );
    expect(settled.outcome).toBe('SETTLED');

    // Brand A, listing 2: OPEN. Two live holds, one never approved, one released by price watch.
    openA = await listing(brandA, 'OPEN', 'Aurel A9');
    await bid(openA, 22_900, 'HELD', 150, `AUTH-A1-${randomUUID()}`);
    await bid(openA, 21_000, 'HELD', 30, `AUTH-A2-${randomUUID()}`);
    await bid(openA, 30_000, 'PENDING_APPROVAL', 20, null);
    await bid(openA, 25_000, 'VOIDED', 100, `AUTH-A4-${randomUUID()}`, 'PRICE_DROP');
    // Brand A, listing 3: a draft (newest).
    draftA = await listing(brandA, 'DRAFT', 'Aurel A11');

    // Audit rows with PII planted in every column a careless projection could copy.
    await auditRow(openA, 'BID_HELD', 'SHOPPER', {
      amountCents: 22_900,
      email: 'pat@shopper.example',
      payerId: PAYER_ID,
    });
    await auditRow(openA, 'BID_HELD', 'BUYER_AGENT', { amountCents: 21_000 });
    await auditRow(openA, 'BID_VOID_REQUESTED', 'WATCHER', { reason: 'PRICE_DROP' });

    // Brand B: its own live listing and audit trail.
    const brandB = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('Other Co', 'p@other.example') RETURNING id`,
      )
    ).id;
    openB = await listing(brandB, 'OPEN', 'Other Speaker');
    await bid(openB, 99_900, 'HELD', 60, `AUTH-B1-${randomUUID()}`);
    await auditRow(openB, 'BID_HELD', 'SHOPPER', { amountCents: 99_900 });

    ownerA = await user(brandA, 'OWNER');
    viewerA = await user(brandA, 'VIEWER');
    ownerB = await user(brandB, 'OWNER');
    const brandC = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('New Brand', 'p@new.example') RETURNING id`,
      )
    ).id;
    ownerC = await user(brandC, 'OWNER');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('needs a brand session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brands/me/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('KPIs: real completed captures this month, live holds, fees and the pending payout', async () => {
    const { body } = await overview(ownerA);
    const real = cleared.winners[0]!.amountCents + cleared.winners[1]!.amountCents;
    const payout = await one<{ status: string; net_cents: number }>(
      `SELECT status, net_cents FROM payouts WHERE listing_id = $1 ORDER BY attempt DESC LIMIT 1`,
      [cleared.listingId],
    );
    expect(payout.status).not.toBe('SUCCESS');
    expect(body.kpis).toEqual({
      recoveredThisMonthCents: real,
      heldNowCents: 22_900 + 21_000,
      feesThisMonthCents: feeCents(real, 900),
      payoutPendingCents: payout.net_cents,
      liveListings: 1,
    });
    expect(payout.net_cents).toBe(netCents(real, 900));
  });

  it('one card per listing, newest first, with phase, held $ and a sparkline', async () => {
    const { body } = await overview(ownerA);
    expect(body.brand).toMatchObject({ id: brandA, verificationStatus: 'PENDING' });
    expect(body.listings.map((l) => l.listingId)).toEqual([draftA, openA, cleared.listingId]);

    const [draft, open, done] = body.listings;
    expect(draft).toMatchObject({ status: 'DRAFT', phase: 'DRAFT', heldCents: 0, liveBids: 0 });
    expect(draft!.sparkline).toEqual({ startAt: null, points: [] });

    expect(open).toMatchObject({
      status: 'OPEN',
      phase: 'BIDDING',
      title: 'Aurel A9',
      liveBids: 2,
      heldCents: 43_900,
      capturedCents: 0,
    });
    expect(open!.oldestHoldAuthorizedAt).not.toBeNull();
    // Opened 3 h ago: 4 hourly points, ending at the held total; the released bid never counts.
    const pts = open!.sparkline.points;
    expect(pts.length).toBeGreaterThanOrEqual(4);
    expect(pts.at(-1)).toBe(43_900);
    expect(pts.every((v, i) => i === 0 || v >= pts[i - 1]!)).toBe(true);

    expect(done).toMatchObject({ status: 'SETTLED', phase: 'SETTLED', heldCents: 0, liveBids: 0 });
    expect(done!.capturedCents).toBe(
      cleared.winners[0]!.amountCents + cleared.winners[1]!.amountCents,
    );
    // After Clear the sparkline keeps every bid that held (winners, reserve, below floor).
    const everHeld = [...cleared.winners, ...cleared.reserve, ...cleared.belowFloor].reduce(
      (s, b) => s + b.amountCents,
      0,
    );
    expect(done!.sparkline.points.at(-1)).toBe(everHeld);
  });

  it('activity: allowlisted actions only, agent bids labelled, no shopper emails or PayPal ids', async () => {
    const { body, raw } = await overview(ownerA);
    const actions = new Set(body.activity.map((a) => a.action));
    expect(actions.has('BID_VOID_REQUESTED')).toBe(false);
    expect(body.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'BID', action: 'BID_HELD', amountCents: 22_900 }),
        expect.objectContaining({ kind: 'AGENT', action: 'BID_HELD', amountCents: 21_000 }),
      ]),
    );
    expect(body.activity.find((a) => a.listingId === openA)?.listingTitle).toBe('Aurel A9');

    const paypalIds = (
      await tdb.db.pool.query<{ id: string }>(
        `SELECT paypal_authorization_id AS id FROM bids WHERE paypal_authorization_id IS NOT NULL
         UNION SELECT paypal_order_id FROM bids WHERE paypal_order_id IS NOT NULL
         UNION SELECT paypal_id FROM settlements WHERE paypal_id IS NOT NULL
         UNION SELECT paypal_id FROM audit_events WHERE paypal_id IS NOT NULL
         UNION SELECT paypal_batch_id FROM payouts WHERE paypal_batch_id IS NOT NULL`,
      )
    ).rows.map((r) => r.id);
    expect(paypalIds.length).toBeGreaterThan(5);
    for (const id of [...paypalIds, PAYER_ID]) expect(raw).not.toContain(id);
    // No email of any kind: shopper, brand user or payout receiver.
    expect(raw).not.toContain('@');
    expect(raw).not.toMatch(/shopper-actor-|void-request-id|Pat Secret/);
  });

  it('never shows another brand’s listings, money or audit events', async () => {
    const a = await overview(ownerA);
    expect(a.raw).not.toContain(openB);
    expect(a.body.activity.some((x) => x.amountCents === 99_900)).toBe(false);

    const b = await overview(ownerB);
    expect(b.body.listings.map((l) => l.listingId)).toEqual([openB]);
    expect(b.body.kpis).toMatchObject({ heldNowCents: 99_900, recoveredThisMonthCents: 0 });
    expect(b.body.activity.every((x) => x.listingId === openB)).toBe(true);
    for (const id of [cleared.listingId, openA, draftA, brandA]) expect(b.raw).not.toContain(id);
  });

  it('a VIEWER reads the same overview', async () => {
    const v = await overview(viewerA);
    const o = await overview(ownerA);
    expect(v.body.listings.map((l) => l.listingId)).toEqual(
      o.body.listings.map((l) => l.listingId),
    );
  });

  it('an unverified brand starts empty and can still create a draft', async () => {
    const empty = await overview(ownerC);
    expect(empty.body.brand.verificationStatus).toBe('PENDING');
    expect(empty.body.listings).toEqual([]);
    expect(empty.body.kpis).toEqual({
      recoveredThisMonthCents: 0,
      heldNowCents: 0,
      feesThisMonthCents: 0,
      payoutPendingCents: 0,
      liveListings: 0,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/listings',
      headers: { cookie: cookie(ownerC), 'idempotency-key': randomUUID() },
      payload: {
        title: 'New Brand Speaker',
        gtin: '0012345678905',
        quantity: 50,
        floorCents: 9_900,
        liquidationQuoteCents: 2_000,
        windowHours: 48,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ status: 'DRAFT' });

    const after = await overview(ownerC);
    expect(after.body.listings).toHaveLength(1);
    expect(after.body.listings[0]).toMatchObject({ status: 'DRAFT', phase: 'DRAFT' });
  });
});
