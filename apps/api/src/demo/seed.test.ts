/**
 * HF-045 `seed:demo` against Postgres and the FakePayPal stub (`PAYPAL_MODE=stub`): two seeds give
 * the same book and numbers, a rerun is refused, everything is labelled SIM, round agents are
 * vaulted with ACTIVE mandates, and rate limits fall back to `SIM · no hold` (aborting above 10%).
 * Needs TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Channel3FixtureClient, FakePayPal, loadBook, type PayPalClient } from '@holdfast/core';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { DEMO_ACCOUNTS } from '../auth/store.js';
import { AUREL_BRAND } from './aurel-fixture.js';
import { DEFAULT_SEED, expectedTableNumbers } from './bid-table.js';
import {
  DemoDataExistsError,
  NO_HOLD_ERROR_CODE,
  SeedAbortedError,
  seedDemo,
  type SeedDemoResult,
} from './seed.js';

const HOUR = 3_600_000;
const PAYOUT = 'aurel-brand@business.example.com';
const REAL_BRANDS = /\b(sony|bose|apple|beats|sennheiser|jbl|samsung)\b/i;

/** Rate-limit the `which`-th raw-card bid holds (not vault set-ups), through the real client path. */
function rateLimiting(fake: FakePayPal, which: (n: number) => boolean): PayPalClient {
  const inner = fake.client();
  let n = 0;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'createAuthOrder') {
        return (input: Parameters<PayPalClient['createAuthOrder']>[0]) => {
          const src = input.paymentSource;
          if (src.kind === 'test_card' && !src.vault && which(++n)) {
            // 1 call + 3 same-id retries, all 429: the client gives up with `unknown`.
            fake.failNext(
              'order_create',
              { kind: 'status', http: 429, issue: 'RATE_LIMIT_REACHED' },
              4,
            );
          }
          return target.createAuthOrder(input);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Decline (422 INSTRUMENT_DECLINED) the `which`-th raw-card bid holds, once each. */
function declining(fake: FakePayPal, which: (n: number) => boolean): PayPalClient {
  const inner = fake.client();
  let n = 0;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'createAuthOrder') {
        return (input: Parameters<PayPalClient['createAuthOrder']>[0]) => {
          const src = input.paymentSource;
          if (src.kind === 'test_card' && !src.vault && which(++n)) {
            fake.failNext('order_create', { kind: 'decline' });
          }
          return target.createAuthOrder(input);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe.skipIf(!TEST_DATABASE_URL)('HF-045 seed:demo on the stub', () => {
  const dbs: TestDatabase[] = [];
  const fresh = async () => {
    const t = await createTestDatabase();
    dbs.push(t);
    return t;
  };
  const seedOn = (
    t: TestDatabase,
    paypal: PayPalClient,
    extra: Partial<Parameters<typeof seedDemo>[1]> = {},
  ) =>
    seedDemo(
      { db: t.db, paypal, channel3: new Channel3FixtureClient() },
      { seed: DEFAULT_SEED, windowLeftMs: 4 * HOUR, concurrency: 5, payoutEmail: PAYOUT, ...extra },
    );

  let a: TestDatabase;
  let first: SeedDemoResult;
  let firstMs: number;

  beforeAll(async () => {
    a = await fresh();
    const started = Date.now();
    first = await seedOn(a, new FakePayPal({ latencyMs: 2 }).client());
    firstMs = Date.now() - started;
  }, 60_000);

  afterAll(async () => {
    for (const t of dbs) await t.close();
  });

  const q = async <T>(sql: string, params: unknown[] = []) =>
    (await a.db.pool.query(sql, params)).rows as T[];

  it('seeds every hold in < 30 s and the numbers match the bid table', () => {
    expect(firstMs).toBeLessThan(30_000);
    expect(first.stats).toMatchObject({
      planned: 288,
      held: 288,
      fallback: 0,
      failed: 0,
      rateLimited: 0,
    });
    expect(first.matchesTable).toBe(true);
    expect(first.numbers).toEqual(
      expect.objectContaining({
        voidedByDrop: expectedTableNumbers().voidedByDrop,
        raisers: expectedTableNumbers().raisers,
      }),
    );
    // The API path agrees with the projection.
    expect(first.simulate240.cutoffCents).toBe(21_900);
    expect(first.simulate240.grossCents).toBe(first.numbers.current.grossCents);
    expect(first.simulate240.winners).toBe(240);
  });

  it('two runs with the same seed give the same book and the same printed numbers', async () => {
    const b = await fresh();
    const second = await seedOn(b, new FakePayPal({ latencyMs: 2 }).client());
    const strip = (r: SeedDemoResult) =>
      [r.numbers.current, r.numbers.postDrop, r.numbers.postRounds].map((s) => ({
        cutoff: s.cutoffCents,
        gross: s.grossCents,
        winners: s.winners,
        avg: s.averageWinningCents,
        net: s.netCents,
      }));
    expect(strip(second)).toEqual(strip(first));
    const book = async (t: TestDatabase) =>
      (
        await t.db.pool.query(
          `SELECT l.slug, b.amount_cents, b.release_if_cheaper, b.payment_method,
                  (b.mandate_id IS NOT NULL) AS agent
             FROM bids b JOIN listings l ON l.id = b.listing_id
            ORDER BY 1, 2, 3, 4, 5`,
        )
      ).rows;
    expect(await book(b)).toEqual(await book(a));
  }, 60_000);

  it('a rerun is refused while demo data exists (keyed by demo_run_id)', async () => {
    await expect(seedOn(a, new FakePayPal().client())).rejects.toBeInstanceOf(DemoDataExistsError);
    const runs = await q<{ demo_run_id: string }>(`SELECT DISTINCT demo_run_id FROM listings`);
    expect(runs).toEqual([{ demo_run_id: first.runId }]);
  });

  it('brand: Aurel Audio (demo), VERIFIED, allowlist, 22% max discount, payout receiver, logins', async () => {
    const [brand] = await q<Record<string, unknown>>(`SELECT * FROM brands`);
    expect(brand).toMatchObject({
      name: AUREL_BRAND.name,
      verification_status: 'VERIFIED',
      max_discount_bps: 2200,
      payout_email: PAYOUT,
      authorized_domains: [...AUREL_BRAND.authorizedDomains],
    });
    const users = await q<{ email: string; role: string }>(
      `SELECT email, role FROM brand_users ORDER BY role`,
    );
    expect(users).toEqual([
      { email: DEMO_ACCOUNTS.ownerEmail, role: 'OWNER' },
      { email: DEMO_ACCOUNTS.viewerEmail, role: 'VIEWER' },
    ]);
  });

  it('listings OPEN through transition(), clock: closes in 4 h, window reads 48 h', async () => {
    const rows = await q<{
      slug: string;
      status: string;
      quantity: number;
      floor_cents: number;
      liquidation_quote_cents: number;
      left_ms: number;
      window_h: number;
    }>(
      `SELECT slug, status, quantity, floor_cents, liquidation_quote_cents,
              extract(epoch FROM window_closes_at - now()) * 1000 AS left_ms,
              extract(epoch FROM window_closes_at - window_opens_at) / 3600 AS window_h
         FROM listings ORDER BY slug`,
    );
    expect(
      rows.map((r) => [r.slug, r.status, r.quantity, r.floor_cents, r.liquidation_quote_cents]),
    ).toEqual([
      ['aurel-a5', 'OPEN', 40, 8_900, 1_800],
      ['aurel-a7', 'OPEN', 300, 19_900, 3_800],
    ]);
    for (const r of rows) {
      expect(Number(r.window_h)).toBe(48);
      expect(Number(r.left_ms)).toBeGreaterThan(3.5 * HOUR);
      expect(Number(r.left_ms)).toBeLessThanOrEqual(4 * HOUR);
    }
    const audits = await q(`SELECT 1 FROM audit_events WHERE action = 'LISTING_PUBLISHED'`);
    expect(audits).toHaveLength(2);
    expect(first.listings.every((l) => l.priceWatch)).toBe(true);
  });

  it('every bidder is SIM; placed_at is backdated into the window, authorized_at is real (D6)', async () => {
    const rows = await q<{
      simulated: boolean;
      source: string;
      in_window: boolean;
      real_auth: boolean;
    }>(
      `SELECT s.is_simulated AS simulated, b.source,
              b.placed_at BETWEEN l.window_opens_at AND now() AS in_window,
              b.authorized_at > now() - interval '10 minutes' AS real_auth
         FROM bids b JOIN shoppers s ON s.id = b.shopper_id JOIN listings l ON l.id = b.listing_id
        WHERE b.status = 'HELD'`,
    );
    expect(rows).toHaveLength(288);
    expect(rows.every((r) => r.simulated && r.source === 'SIM' && r.in_window && r.real_auth)).toBe(
      true,
    );
    const old = await q(
      `SELECT 1 FROM bids WHERE placed_at < now() - interval '24 hours' AND status = 'HELD'`,
    );
    expect(old.length).toBeGreaterThan(50);
  });

  it('no real brand anywhere in the seeded data', async () => {
    const text = await q<{ t: string }>(
      `SELECT name AS t FROM brands UNION ALL SELECT coalesce(title, '') || ' ' || coalesce(brand_name, '')
         || ' ' || coalesce(best_public_merchant, '') FROM products
       UNION ALL SELECT coalesce(display_name, '') FROM shoppers`,
    );
    expect(text.length).toBeGreaterThan(0);
    for (const r of text) expect(r.t).not.toMatch(REAL_BRANDS);
  });

  it('20 round agents: vaulted, ACTIVE mandates on the A7 only, VAULT bids under them', async () => {
    const rows = await q<{
      vault: string | null;
      status: string;
      max: number;
      amount: number;
      method: string;
    }>(
      `SELECT s.paypal_vault_id AS vault, m.status, m.max_price_cents AS max, b.amount_cents AS amount,
              b.payment_method AS method
         FROM mandates m JOIN shoppers s ON s.id = m.shopper_id
         JOIN bids b ON b.mandate_id = m.id AND b.status = 'HELD'`,
    );
    expect(rows).toHaveLength(20);
    expect(
      rows.every(
        (r) => r.vault && r.status === 'ACTIVE' && r.method === 'VAULT' && r.max > r.amount,
      ),
    ).toBe(true);
    // About half can afford cutoff + 1% ($221.19).
    const raisers = rows.filter((r) => r.max >= 22_119).length;
    expect(raisers).toBe(10);
    const vaulted = await q(`SELECT 1 FROM audit_events WHERE action = 'DEMO_AGENT_VAULTED'`);
    expect(vaulted).toHaveLength(20);
  });

  it('rate-limited holds fall back to SIM · no hold, logged, and never reach the book (D8)', async () => {
    const t = await fresh();
    const fake = new FakePayPal({ latencyMs: 1 });
    const lines: string[] = [];
    const r = await seedDemo(
      {
        db: t.db,
        paypal: rateLimiting(fake, (n) => n % 20 === 0),
        channel3: null,
        log: (l) => lines.push(l),
      },
      { seed: DEFAULT_SEED, windowLeftMs: 4 * HOUR, concurrency: 1, payoutEmail: PAYOUT },
    );
    // 268 raw-card holds; every 20th is rate limited → 13 fallbacks (< 10% of 288).
    expect(r.stats).toMatchObject({ fallback: 13, rateLimited: 13, held: 275, failed: 0 });
    expect(lines.filter((l) => l.includes('SIM · no hold'))).toHaveLength(13);
    const noHold = (
      await t.db.pool.query(
        `SELECT b.id, b.status, b.paypal_authorization_id, b.error_code, s.is_simulated
           FROM bids b JOIN shoppers s ON s.id = b.shopper_id WHERE b.error_code = $1`,
        [NO_HOLD_ERROR_CODE],
      )
    ).rows;
    expect(noHold).toHaveLength(13);
    expect(
      noHold.every(
        (b) => b.status === 'HELD' && b.paypal_authorization_id === null && b.is_simulated,
      ),
    ).toBe(true);
    const attempts = (
      await t.db.pool.query(
        `SELECT count(*)::int AS n FROM bids WHERE status = 'HOLD_FAILED' AND error_code = 'RATE_LIMIT_REACHED'`,
      )
    ).rows[0].n;
    expect(attempts).toBe(13);
    const a7 = r.listings.find((l) => l.key === 'A7')!;
    const book = await loadBook(t.db, r.brandId, a7.id);
    expect(book.stats.liveBids).toBe(a7.held);
    expect(book.stats.simulatedNoHoldBids).toBe(a7.noHold);
    expect(a7.noHold).toBeGreaterThan(0);
    const noHoldIds = new Set(noHold.map((b) => b.id as string));
    expect(book.bids.filter((b) => noHoldIds.has(b.id))).toEqual([]);
    expect(book.pending.filter((b) => noHoldIds.has(b.id))).toEqual([]);
    expect(r.numbers.current.winners + r.numbers.current.losers).toBe(a7.held);
  }, 60_000);

  it('a stray refusal is retried once with another card, so the numbers still match the table', async () => {
    const t = await fresh();
    const r = await seedDemo(
      {
        db: t.db,
        paypal: declining(new FakePayPal({ latencyMs: 1 }), (n) => n === 7 || n === 100),
        channel3: null,
      },
      { seed: DEFAULT_SEED, windowLeftMs: 4 * HOUR, concurrency: 1, payoutEmail: PAYOUT },
    );
    expect(r.stats).toMatchObject({ held: 288, retried: 2, failed: 0, fallback: 0 });
    expect(r.matchesTable).toBe(true);
    const failed = (
      await t.db.pool.query(`SELECT count(*)::int AS n FROM bids WHERE status = 'HOLD_FAILED'`)
    ).rows[0].n;
    expect(failed).toBe(2);
  }, 60_000);

  it('more than 10% fallbacks abort the seed early', async () => {
    const t = await fresh();
    const fake = new FakePayPal({ latencyMs: 1 });
    const err = await seedDemo(
      { db: t.db, paypal: rateLimiting(fake, () => true), channel3: null },
      { seed: DEFAULT_SEED, windowLeftMs: 4 * HOUR, concurrency: 1, payoutEmail: PAYOUT },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedAbortedError);
    const stats = (err as SeedAbortedError).stats;
    expect(stats.fallback).toBe(Math.floor(288 * 0.1) + 1);
    expect(stats.attempted).toBeLessThan(stats.planned);
  }, 60_000);
});
