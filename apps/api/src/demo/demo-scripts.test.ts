/**
 * HF-046 demo scripts against Postgres and the FakePayPal stub. The ticket's stub test plan
 * (seed → clear with decline → reset, twice), the reset's guards (refused while settling, fails
 * loudly with a dangling hold, keeps the foreground actors), `sim:stream`'s bounds, `demo:decline`'s
 * rank checks, the audit completeness check, and races with Clear / late holds.
 * Needs TEST_DATABASE_URL:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/demo/demo-scripts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Channel3FixtureClient,
  FakePayPal,
  auditHook,
  clearListing,
  createMandate,
  createMcpClient,
  payoutBrand,
  placeBid,
  pollPayouts,
  promoteWithin,
  settleListing,
  simulateListing,
  verifyMcpToken,
  type Db,
  type PayPalClient,
} from '@holdfast/core';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { ensureDemoShopper } from '../auth/store.js';
import { resolveSimListing } from '../dev/sim-bids.js';
import { AUREL_A7 } from './aurel-fixture.js';
import { checkAuditAgainstCallLog, checkAuditAgainstPayPal } from './audit-check.js';
import { DEFAULT_SEED, DEMO_QUANTITY } from './bid-table.js';
import { ranksNearest, setDemoDeclineRank } from './decline.js';
import { DemoResetRefusedError, DemoResetVerifyError, demoReset } from './reset.js';
import { SEED_TEST_CARDS, seedDemo, type SeedDemoResult } from './seed.js';
import { streamSimBids } from './sim-stream.js';

const HOUR = 3_600_000;
const PAYOUT = 'aurel-brand@business.example.com';
const noSleep = async () => {};

describe('ranksNearest', () => {
  it('walks outwards from the requested rank inside [1, max]', () => {
    expect(ranksNearest(3, 5)).toEqual([3, 4, 2, 5, 1]);
    expect(ranksNearest(1, 3)).toEqual([1, 2, 3]);
    expect(ranksNearest(5, 5)).toEqual([5, 4, 3, 2, 1]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('HF-046 demo scripts on the stub', { timeout: 120_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fake: FakePayPal;
  let paypal: PayPalClient;
  let foreground: { shopperId: string; mandateId: string; token: string; mcpClientId: string };

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  const seed = () =>
    seedDemo(
      { db, paypal, channel3: new Channel3FixtureClient() },
      { seed: DEFAULT_SEED, windowLeftMs: 4 * HOUR, concurrency: 5, payoutEmail: PAYOUT },
    );
  const reset = () => demoReset({ db, paypal, adminDb: db, channel3: null });
  const a7Of = (s: SeedDemoResult) => s.listings.find((l) => l.key === 'A7')!;

  /** Clear the A7 at Q = 240 with DEMO_MODE on (the decline rank is copied onto the winner). */
  async function clearA7(s: SeedDemoResult) {
    const a7 = a7Of(s);
    const sim = await simulateListing(db, s.brandId, a7.id, DEMO_QUANTITY);
    const out = await clearListing(
      { db, paypal, audit: auditHook, demoMode: true },
      {
        listingId: a7.id,
        brandId: s.brandId,
        quantity: DEMO_QUANTITY,
        expectedGrossCents: sim.grossCents,
        actor: { type: 'BRAND_USER', id: 'demo-owner' },
      },
    );
    if (!out.ok) throw new Error(`clear refused: ${JSON.stringify(out)}`);
    await out.released;
    return a7.id;
  }

  /** The coordinator with HF-031's promotion and HF-032's payout; records what payout saw. */
  async function settle(listingId: string) {
    const seen: Array<{ status: string; promotedCaptured: boolean }> = [];
    const r = await settleListing(
      {
        db,
        paypal,
        sleep: noSleep,
        allowMockDecline: true,
        promoteWithin,
        pollMs: 20,
        retryDelaySeconds: 0,
        payoutBrand: async (id) => {
          const l = await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
            id,
          ]);
          const p = await one<{ n: number }>(
            `SELECT count(*)::int AS n FROM bids
              WHERE listing_id = $1 AND status = 'CAPTURED' AND unit_root_bid_id <> id`,
            [id],
          );
          seen.push({ status: l.status, promotedCaptured: p.n === 1 });
          return payoutBrand({ db, paypal }, id);
        },
      },
      listingId,
    );
    // The payout poll (HF-032) until the batch resolves (the fake settles after a GET).
    for (let i = 0; i < 5; i++) {
      const l = await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
        listingId,
      ]);
      if (l.status !== 'SETTLED') break;
      await pollPayouts({ db, paypal });
    }
    return { r, seen };
  }

  const createdAtPayPal = () => fake.authorizations().filter((a) => a.status === 'CREATED');

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    // One FakePayPal for the whole file: it outlives resets like the sandbox does.
    fake = new FakePayPal();
    paypal = fake.client();
    const shopper = await ensureDemoShopper(db.pool);
    await db.pool.query(`UPDATE shoppers SET paypal_vault_id = 'FG-VAULT-1' WHERE id = $1`, [
      shopper.id,
    ]);
    const mandate = await createMandate(db.pool, {
      shopperId: shopper.id,
      maxPriceCents: 26_000,
      totalHoldCapCents: 60_000,
    });
    const mcp = await createMcpClient(db, {
      shopperId: shopper.id,
      name: 'Claude Desktop',
      scopes: ['read', 'bid'],
    });
    foreground = {
      shopperId: shopper.id,
      mandateId: mandate.id,
      token: mcp.token,
      mcpClientId: mcp.client.id,
    };
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  for (const cycle of [1, 2]) {
    it(`cycle ${cycle}: seed → stream → decline → clear → settle → audit check → reset`, async () => {
      const callsBefore = fake.calls.length;
      const s = await seed();
      const a7 = a7Of(s);
      expect(s.stats.held).toBe(288);

      // A foreground bid (the offer-page shopper) that the reset must release and delete.
      const fg = await placeBid(
        { db, paypal, audit: auditHook, allowTestCard: true, testCard: SEED_TEST_CARDS[0] },
        {
          shopperId: foreground.shopperId,
          listingId: a7.id,
          amountCents: 24_900,
          paymentMethod: 'TEST_CARD',
          source: 'OFFER_PAGE',
          idempotencyKey: `fg-${cycle}`,
        },
      );
      expect(fg.ok).toBe(true);

      // sim:stream: bounded, SIM, release_if_cheaper = false.
      const listing = (await resolveSimListing(db, a7.id))!;
      const stream = await streamSimBids(
        { db, paypal, sleep: noSleep },
        { listing, count: 4, runId: `c${cycle}`, seed: cycle },
      );
      expect(stream).toMatchObject({ stoppedBy: 'COUNT', held: 4, refused: 0 });
      const streamed = await q<{ release_if_cheaper: boolean; source: string; sim: boolean }>(
        `SELECT b.release_if_cheaper, b.source, s.is_simulated AS sim
           FROM bids b JOIN shoppers s ON s.id = b.shopper_id WHERE b.idempotency_key LIKE $1`,
        [`sim-stream:c${cycle}:%`],
      );
      expect(streamed).toHaveLength(4);
      expect(streamed.every((b) => !b.release_if_cheaper && b.source === 'SIM' && b.sim)).toBe(
        true,
      );

      // demo:decline at rank 120.
      const d = await setDemoDeclineRank(db, {
        listingId: a7.id,
        rank: 120,
        quantity: DEMO_QUANTITY,
      });
      if (!d.ok) throw new Error(JSON.stringify(d.error));
      expect(d.set.rank).toBe(120);

      const listingId = await clearA7(s);
      const declined = await one<{ id: string; paypal_authorization_id: string }>(
        `SELECT id, paypal_authorization_id FROM bids WHERE listing_id = $1 AND test_decline`,
        [listingId],
      );
      expect(declined.id).toBe(d.set.declined.bidId);

      const { r, seen } = await settle(listingId);
      expect(r.outcome).toBe('SETTLED');

      // Exactly one promotion, of the expected reserve bid, at its own bid; nothing unfilled.
      const promoted = await q<{ entity_id: string; data: { promotedBidId?: string } }>(
        `SELECT entity_id, data FROM audit_events WHERE listing_id = $1 AND action = 'PROMOTED'`,
        [listingId],
      );
      expect(promoted).toHaveLength(1);
      const promotedBid = await one<{ id: string; status: string; amount_cents: number }>(
        `SELECT id, status, amount_cents FROM bids
          WHERE listing_id = $1 AND unit_root_bid_id = $2 AND id <> $2`,
        [listingId, declined.id],
      );
      expect(promotedBid).toMatchObject({
        id: d.set.promoted.bidId,
        status: 'CAPTURED',
        amount_cents: d.set.promoted.amountCents,
      });
      expect(
        await q(`SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = 'UNFILLED_UNIT'`, [
          listingId,
        ]),
      ).toHaveLength(0);
      // The decline reached PayPal as the mock header, once, on the declined authorization only.
      const mocked = fake.calls
        .slice(callsBefore)
        .filter((c) => c.op === 'capture' && c.mockResponse);
      expect(mocked.filter((c) => c.path.includes(declined.paypal_authorization_id))).toHaveLength(
        mocked.length,
      );
      // The declined authorization is voided.
      expect(fake.authorization(declined.paypal_authorization_id)?.status).toBe('VOIDED');
      // SETTLED and the payout waited for the promoted capture.
      expect(seen).toEqual([{ status: 'SETTLED', promotedCaptured: true }]);
      const captured = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM bids WHERE listing_id = $1 AND status = 'CAPTURED'`,
        [listingId],
      );
      expect(captured.n).toBe(DEMO_QUANTITY);
      expect(
        (await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [listingId]))
          .status,
      ).toBe('PAID_OUT');

      // Audit completeness on the stub run: every *_SUCCEEDED row matches the call log.
      const audit = await checkAuditAgainstCallLog(db, fake.calls, { listingIds: [listingId] });
      expect(audit.mismatches).toEqual([]);
      expect(audit.succeeded).toBeGreaterThan(DEMO_QUANTITY);
      const viaGet = await checkAuditAgainstPayPal(db, paypal, { listingIds: [listingId] });
      expect(viaGet.mismatches).toEqual([]);

      // The price-drop beat moved the public anchor; the reset restores it.
      await db.pool.query(
        `UPDATE products SET best_public_price_cents = 24_500 WHERE channel3_id = $1`,
        [AUREL_A7.channel3Id],
      );
      const productBefore = await one<{ id: string }>(
        `SELECT id FROM products WHERE channel3_id = $1`,
        [AUREL_A7.channel3Id],
      );
      await db.pool.query(`UPDATE mandates SET allowed_product_ids = $2 WHERE id = $1`, [
        foreground.mandateId,
        [productBefore.id],
      ]);

      const authIds = (
        await q<{ id: string }>(
          `SELECT paypal_authorization_id AS id FROM bids WHERE paypal_authorization_id IS NOT NULL`,
        )
      ).map((r) => r.id);
      const res = await reset();

      // No dangling hold, proven by GET on every authorization id the DB had.
      expect(res.verify.created).toEqual([]);
      expect(res.verify.errors).toEqual([]);
      expect(res.verify.checked).toBeGreaterThanOrEqual(authIds.length);
      for (const id of authIds) expect(fake.authorization(id)?.status).not.toBe('CREATED');
      expect(createdAtPayPal()).toEqual([]);
      expect(res.closedListings).toBe(1); // the A5 was still OPEN

      // Truncated, foreground kept.
      expect(await q(`SELECT 1 FROM bids`)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM listings`)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM shoppers WHERE NOT is_demo_foreground`)).toHaveLength(0);
      const fgRow = await one<{ paypal_vault_id: string }>(
        `SELECT paypal_vault_id FROM shoppers WHERE id = $1`,
        [foreground.shopperId],
      );
      expect(fgRow.paypal_vault_id).toBe('FG-VAULT-1');
      const mandate = await one<{ status: string; allowed_product_ids: string[] }>(
        `SELECT status, allowed_product_ids FROM mandates WHERE id = $1`,
        [foreground.mandateId],
      );
      expect(mandate.status).toBe('ACTIVE');
      // Claude Desktop still works: the same token resolves to the same shopper.
      expect(await verifyMcpToken(db.pool, foreground.token)).toMatchObject({
        clientId: foreground.mcpClientId,
        shopperId: foreground.shopperId,
      });
      // Public anchor restored; the product id (in the mandate) survives the reseed.
      const product = await one<{ id: string; best_public_price_cents: number }>(
        `SELECT id, best_public_price_cents FROM products WHERE channel3_id = $1`,
        [AUREL_A7.channel3Id],
      );
      expect(product).toEqual({
        id: productBefore.id,
        best_public_price_cents: AUREL_A7.publicPriceCents,
      });
      // The audit log starts over with the reset's own row.
      const audits = await q<{ action: string }>(`SELECT action FROM audit_events`);
      expect(audits).toEqual([{ action: 'DEMO_RESET' }]);
    });
  }

  it('the reseed after a reset keeps the foreground mandate on the same product', async () => {
    const s = await seed();
    const product = await one<{ id: string }>(
      `SELECT product_id AS id FROM listings WHERE id = $1`,
      [a7Of(s).id],
    );
    const mandate = await one<{ allowed_product_ids: string[] }>(
      `SELECT allowed_product_ids FROM mandates WHERE id = $1`,
      [foreground.mandateId],
    );
    expect(mandate.allowed_product_ids).toEqual([product.id]);
  });

  it('demo:decline refuses without a reserve and skips a foreground winner', async () => {
    const a7 = (await one<{ id: string; quantity: number }>(
      `SELECT id, quantity FROM listings WHERE slug = 'aurel-a7'`,
    ))!;
    const eligible = (await one<{ n: number }>(
      `SELECT count(DISTINCT shopper_id)::int AS n FROM bids
        WHERE listing_id = $1 AND status = 'HELD' AND paypal_authorization_id IS NOT NULL
          AND amount_cents >= 19_900`,
      [a7.id],
    ))!.n;
    const noReserve = await setDemoDeclineRank(db, {
      listingId: a7.id,
      rank: 1,
      quantity: Math.min(a7.quantity, eligible),
    });
    expect(noReserve).toMatchObject({ ok: false, error: { code: 'NO_RESERVE' } });

    // The foreground shopper bids high enough to be rank 1: rank 1 moves to rank 2.
    const fg = await placeBid(
      { db, paypal, audit: auditHook, allowTestCard: true },
      {
        shopperId: foreground.shopperId,
        listingId: a7.id,
        amountCents: 27_000,
        paymentMethod: 'TEST_CARD',
        source: 'OFFER_PAGE',
        idempotencyKey: 'fg-top',
      },
    );
    expect(fg.ok).toBe(true);
    const moved = await setDemoDeclineRank(db, { listingId: a7.id, rank: 1, quantity: 240 });
    expect(moved).toMatchObject({ ok: true, set: { requestedRank: 1, rank: 2 } });
    if (moved.ok) expect(moved.set.declined.bidId).not.toBe(fg.ok ? fg.bid.id : '');
    const flag = await one<{ demo_decline_rank: number }>(
      `SELECT demo_decline_rank FROM listings WHERE id = $1`,
      [a7.id],
    );
    expect(flag.demo_decline_rank).toBe(2);
    expect(
      await setDemoDeclineRank(db, { listingId: a7.id, rank: 241, quantity: 240 }),
    ).toMatchObject({ ok: false, error: { code: 'RANK_OUT_OF_RANGE' } });
  });

  it('race: sim:stream stops as soon as Clear moves the listing out of OPEN', async () => {
    const a7 = await one<{ id: string; brand_id: string }>(
      `SELECT id, brand_id FROM listings WHERE slug = 'aurel-a7'`,
    );
    const listing = (await resolveSimListing(db, a7.id))!;
    let bids = 0;
    let cleared: Promise<unknown> | null = null;
    const stream = await streamSimBids(
      {
        db,
        paypal,
        sleep: async () => {
          // After the second bid, Clear lands between the stream's gap and its next check.
          if (++bids === 3 && !cleared) {
            const sim = await simulateListing(db, a7.brand_id, a7.id, DEMO_QUANTITY);
            cleared = clearListing(
              { db, paypal, audit: auditHook, demoMode: true },
              {
                listingId: a7.id,
                brandId: a7.brand_id,
                quantity: DEMO_QUANTITY,
                expectedGrossCents: sim.grossCents,
                actor: { type: 'BRAND_USER', id: 'demo-owner' },
              },
            );
            await cleared;
          }
        },
      },
      { listing, count: 20, runId: 'race', seed: 3 },
    );
    expect(stream).toMatchObject({ stoppedBy: 'LISTING_NOT_OPEN', listingStatus: 'CLEARING' });
    expect(stream.held).toBe(2);
  });

  it('reset refuses while the listing is CLEARING with open settlements, then works', async () => {
    const a7 = await one<{ id: string; status: string }>(
      `SELECT id, status FROM listings WHERE slug = 'aurel-a7'`,
    );
    expect(a7.status).toBe('CLEARING');
    const err = await reset().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DemoResetRefusedError);
    expect((err as DemoResetRefusedError).reason).toBe('SETTLING');
    // Nothing was touched: the A5 is still OPEN and bids are still there.
    expect(
      (await one<{ status: string }>(`SELECT status FROM listings WHERE slug = 'aurel-a5'`)).status,
    ).toBe('OPEN');

    const { r } = await settle(a7.id);
    expect(r.outcome).toBe('SETTLED');
    // The decline rank set in the previous test (rank 2) promoted exactly one reserve bid.
    expect(
      await q(`SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = 'PROMOTED'`, [a7.id]),
    ).toHaveLength(1);
  });

  it('reset fails loudly, deleting nothing, while PayPal will not release a hold', async () => {
    // Every void fails (a PayPal outage): the A5's holds stay CREATED.
    fake.failNext('void', { kind: 'status', http: 503 }, 10_000);
    const resets = async () =>
      (await q(`SELECT 1 FROM audit_events WHERE action = 'DEMO_RESET'`)).length;
    const resetsBefore = await resets();
    try {
      const err = await reset().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DemoResetVerifyError);
      expect((err as DemoResetVerifyError).verify.created.length).toBeGreaterThan(0);
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM bids`)).n).toBeGreaterThan(
        0,
      );
      expect(await resets()).toBe(resetsBefore);
    } finally {
      fake.clearFaults();
    }
    // Once PayPal answers again the same reset completes (the sweeper resumes VOIDING rows).
    const ok = await reset();
    expect(ok.verify.created).toEqual([]);
    expect(createdAtPayPal()).toEqual([]);
    expect(await q(`SELECT 1 FROM bids`)).toHaveLength(0);
  });

  it('race: a hold landing on a listing the reset closed is released, never left behind', async () => {
    const s = await seed();
    const a7 = a7Of(s);
    // A SIM bid in flight while the reset runs: placeBid either lands before the close (and is
    // released by the sweep) or is refused by landHold on the CANCELLED listing (and voided).
    const shopper = await one<{ id: string }>(
      `INSERT INTO shoppers (display_name, is_simulated) VALUES ('SIM late', true) RETURNING id`,
    );
    const [late, res] = await Promise.all([
      placeBid(
        { db, paypal, audit: auditHook, allowTestCard: true },
        {
          shopperId: shopper.id,
          listingId: a7.id,
          amountCents: 22_000,
          paymentMethod: 'TEST_CARD',
          source: 'SIM',
          idempotencyKey: 'late-1',
        },
      ).catch((e: unknown) => e),
      reset().catch((e: unknown) => e),
    ]);
    expect(late).toBeDefined();
    if (res instanceof Error) {
      // The only acceptable refusal: the late hold moved after verification; nothing deleted.
      expect(res).toBeInstanceOf(DemoResetRefusedError);
      expect((res as DemoResetRefusedError).reason).toMatch(/CHANGED_DURING_RESET|PENDING_HOLDS/);
      await reset();
    }
    expect(createdAtPayPal()).toEqual([]);
    expect(await q(`SELECT 1 FROM bids`)).toHaveLength(0);
  });
});
