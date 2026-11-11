/**
 * HF-035 (W08) reads over HTTP after a full settlement run on `FakePayPal` with one injected
 * decline: the SettlementView counts match its rows, the promoted row links to the failed winner
 * at the promoted bidder's own amount, the payout shows up and changes on a later read, and the
 * drawer's brand-scoped bid view carries no shopper PII. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/settlement-view
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadConfig,
  makePayoutBrand,
  pollPayouts,
  settleListing,
  type PayPalClient,
} from '@holdfast/core';
import {
  BRAND_BID_FORBIDDEN_KEYS,
  brandBidViewSchema,
  settlementViewSchema,
  type SettlementCounts,
  type SettlementRow,
  type SettlementView,
} from '@holdfast/shared';
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

const SECRET = 'd'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  ADMIN_EMAILS: 'ops@holdfast.example',
};

/** The counts W08 shows, re-derived from the rows alone (must equal the server's `counts`). */
function countsFromRows(rows: SettlementRow[]): SettlementCounts {
  const n = (f: (r: SettlementRow) => boolean) => rows.filter(f).length;
  const ok = (r: SettlementRow) => r.status === 'SUCCEEDED';
  return {
    total: rows.length,
    queued: n((r) => r.status === 'QUEUED'),
    running: n((r) => r.status === 'RUNNING' || r.status === 'RETRY'),
    captured: n((r) => r.action === 'CAPTURE' && ok(r) && r.paypalStatus !== 'PENDING'),
    capturePending: n((r) => r.action === 'CAPTURE' && ok(r) && r.paypalStatus === 'PENDING'),
    released: n((r) => r.action === 'VOID' && ok(r)),
    failed: n((r) => r.status === 'FAILED'),
    promoted: n((r) => r.action === 'CAPTURE' && r.unitRootBidId !== r.bidId),
    cancelled: n((r) => r.status === 'CANCELLED'),
  };
}

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe.skipIf(!TEST_DATABASE_URL)('HF-035 W08 reads', { timeout: 60_000 }, () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let fake: FakePayPal;
  let client: PayPalClient;
  let seeded: ClearedListing;
  let owner: string;
  let otherBrandUser: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const cookie = (userId: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`;
  const get = (userId: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: cookie(userId) } });
  const view = async () =>
    settlementViewSchema.parse(
      (await get(owner, `/api/listings/${seeded.listingId}/settlement`)).json(),
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
    });
    fake = new FakePayPal();
    client = fake.client();
    seeded = await seedClearedListing(tdb.db, client, {
      winners: 6,
      reserve: 3,
      belowFloor: 2,
      declineWinners: [2],
    });
    const { brand_id } = await one<{ brand_id: string }>(
      `SELECT brand_id FROM listings WHERE id = $1`,
      [seeded.listingId],
    );
    owner = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
        [brand_id, `${randomUUID()}@aurel.example`],
      )
    ).id;
    const other = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Other', 'p@other.example') RETURNING id`,
    );
    otherBrandUser = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
        [other.id, `${randomUUID()}@other.example`],
      )
    ).id;
    // Shopper PII that must never reach the brand.
    await tdb.db.pool.query(
      `UPDATE shoppers SET email = 'secret-' || id || '@shopper.example', display_name = 'Pat Secret'
        WHERE id IN (SELECT shopper_id FROM bids WHERE listing_id = $1)`,
      [seeded.listingId],
    );

    const res = await settleListing(
      {
        db: tdb.db,
        paypal: client,
        sleep: async () => {},
        allowMockDecline: true,
        pollMs: 20,
        retryDelaySeconds: 0,
        payoutBrand: makePayoutBrand({ db: tdb.db, paypal: client }),
      },
      seeded.listingId,
    );
    expect(res.outcome).toBe('SETTLED');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  let end: SettlementView;

  it('counts match the settlement rows at the end of a run', async () => {
    end = await view();
    expect(end.counts).toEqual(countsFromRows(end.rows));
    expect(end.counts).toMatchObject({
      total: 6 + 3 + 2 + 1, // + the promoted CAPTURE
      captured: 6,
      failed: 1,
      promoted: 1,
      cancelled: 1, // the promoted bid's reserve VOID
      queued: 0,
      running: 0,
    });
    expect(end.unfilledUnits).toBe(0);
    expect(end.capturedCents).toBe(
      end.rows
        .filter((r) => r.action === 'CAPTURE' && r.status === 'SUCCEEDED')
        .reduce((s, r) => s + r.amountCents, 0),
    );
  });

  it('the promoted row links to the failed winner and carries its own bid amount', () => {
    const failed = seeded.winners[1]!;
    const promoted = seeded.reserve[0]!;
    const row = end.rows.find((r) => r.bidId === promoted.bidId && r.action === 'CAPTURE')!;
    expect(row).toMatchObject({
      status: 'SUCCEEDED',
      unitRootBidId: failed.bidId,
      promotedFromBidId: failed.bidId,
      amountCents: promoted.amountCents,
    });
    expect(row.amountCents).not.toBe(failed.amountCents);
  });

  it('the payout appears and its status changes on the next read (no reload state)', async () => {
    expect(end.payout).toMatchObject({ status: 'PENDING', grossCents: end.capturedCents });
    const batch = end.payout!.paypalBatchId!;
    fake.settlePayout(batch, 'SUCCESS');
    await pollPayouts({ db: tdb.db, paypal: client }, { resendAfterSeconds: 0 });
    const after = await view();
    expect(after.payout).toMatchObject({ status: 'SUCCESS', itemStatus: 'SUCCESS' });
    expect(after.listingStatus).toBe('PAID_OUT');
  });

  it('drawer: brand-scoped bid view, promotion links both ways, no shopper PII', async () => {
    const failed = seeded.winners[1]!;
    const promoted = seeded.reserve[0]!;
    const url = (bidId: string) => `/api/listings/${seeded.listingId}/bids/${bidId}`;

    const p = await get(owner, url(promoted.bidId));
    expect(p.statusCode).toBe(200);
    const pv = brandBidViewSchema.parse(p.json());
    expect(pv).toMatchObject({ status: 'CAPTURED', amountCents: promoted.amountCents });
    expect(pv.promotedFrom?.bidId).toBe(failed.bidId);
    expect(pv.settlements.map((s) => `${s.action}:${s.status}`).sort()).toEqual([
      'CAPTURE:SUCCEEDED',
      'VOID:CANCELLED',
    ]);
    expect(pv.timeline.some((e) => e.action === 'PROMOTED')).toBe(true);

    const f = brandBidViewSchema.parse((await get(owner, url(failed.bidId))).json());
    expect(f.promotedTo).toMatchObject({
      bidId: promoted.bidId,
      amountCents: promoted.amountCents,
    });

    for (const body of [p.body, (await get(owner, url(failed.bidId))).body]) {
      expect(body).not.toMatch(/@shopper\.example|Pat Secret/);
      const keys = keysDeep(JSON.parse(body));
      for (const k of BRAND_BID_FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
    }
  });

  it('drawer: another brand, a bid of another listing or a bad id are all 404', async () => {
    const bid = seeded.winners[0]!.bidId;
    expect(
      (await get(otherBrandUser, `/api/listings/${seeded.listingId}/bids/${bid}`)).statusCode,
    ).toBe(404);
    expect((await get(owner, `/api/listings/${randomUUID()}/bids/${bid}`)).statusCode).toBe(404);
    expect((await get(owner, `/api/listings/${seeded.listingId}/bids/nope`)).statusCode).toBe(404);
  });
});
