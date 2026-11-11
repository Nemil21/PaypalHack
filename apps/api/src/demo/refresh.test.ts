/**
 * HF-048b `demo:refresh` against Postgres and the FakePayPal stub: two manual runs in a row each
 * leave a fresh OPEN judge listing and no authorization from the previous book still CREATED; a
 * second refresh while one runs is skipped; a busy reset is retried; a failed verify stops at
 * once; and a judge's hold racing the refresh never survives it.
 * Needs TEST_DATABASE_URL:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/demo/refresh
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Channel3FixtureClient,
  FakePayPal,
  auditHook,
  placeBid,
  type Db,
  type PayPalClient,
} from '@holdfast/core';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { ensureDemoShopper } from '../auth/store.js';
import { JUDGE_BOOK, bookSize } from './bid-table.js';
import { REFRESH_LOCK, demoRefresh, type DemoRefreshResult } from './refresh.js';
import { DemoResetRefusedError, DemoResetVerifyError } from './reset.js';
import { SEED_TEST_CARDS } from './seed.js';

const PAYOUT = 'aurel-brand@business.example.com';
const noSleep = async () => {};

describe.skipIf(!TEST_DATABASE_URL)(
  'HF-048b demo:refresh on the stub',
  { timeout: 120_000 },
  () => {
    let t: TestDatabase;
    let db: Db;
    let fake: FakePayPal;
    let paypal: PayPalClient;
    let shopperId: string;

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await db.pool.query(sql, params)).rows as T[];

    const refresh = (extra: { sleep?: (ms: number) => Promise<void>; maxAttempts?: number } = {}) =>
      demoRefresh(
        {
          db,
          paypal,
          adminDb: db,
          channel3: new Channel3FixtureClient(),
          sleep: extra.sleep ?? noSleep,
        },
        { payoutEmail: PAYOUT, maxAttempts: extra.maxAttempts, lockWaitMs: 2_000 },
      );

    const refreshed = (r: DemoRefreshResult) => {
      if (r.status !== 'REFRESHED') throw new Error(`expected REFRESHED, got ${r.status}`);
      return r;
    };

    /** Authorization ids the database knows (bids). */
    const dbAuthIds = async () =>
      new Set(
        (
          await q<{ id: string }>(
            `SELECT paypal_authorization_id AS id FROM bids WHERE paypal_authorization_id IS NOT NULL`,
          )
        ).map((r) => r.id),
      );
    /** The invariant: every hold still CREATED at PayPal belongs to a bid of the current book. */
    async function expectNoStrayHolds() {
      const known = await dbAuthIds();
      const stray = fake
        .authorizations()
        .filter((a) => a.status === 'CREATED' && !known.has(a.id))
        .map((a) => a.id);
      expect(stray).toEqual([]);
    }

    beforeAll(async () => {
      t = await createTestDatabase();
      db = t.db;
      // One FakePayPal for the file: like the sandbox, it outlives every refresh.
      fake = new FakePayPal();
      paypal = fake.client();
      shopperId = (await ensureDemoShopper(db.pool)).id;
    }, 60_000);

    afterAll(async () => {
      await t?.close();
    });

    it('two manual runs: each leaves a fresh OPEN judge listing and zero holds from the last book', async () => {
      const first = refreshed(await refresh());
      expect(first.seed.book.name).toBe('judge');
      expect(first.seed.stats.held).toBe(bookSize(JUDGE_BOOK));
      expect(bookSize(JUDGE_BOOK)).toBe(60);
      expect(first.check).toMatchObject({ status: 'OPEN', leftoverBids: 0 });
      const a7 = first.seed.listings.find((l) => l.key === 'A7')!;
      expect(a7.quantity).toBe(JUDGE_BOOK.a7ListingQuantity);
      // Open for longer than a day, so one missed cron run still leaves the market open.
      expect(first.check.windowClosesAt.getTime() - Date.now()).toBeGreaterThan(24 * 3_600_000);
      // The judge listing clears with winners and losers: cutoff $219 at the printed quantity.
      expect(first.seed.numbers.current.cutoffCents).toBe(21_900);
      expect(first.seed.matchesTable).toBe(true);
      const firstBook = await dbAuthIds();
      expect(firstBook.size).toBe(bookSize(JUDGE_BOOK));

      // A judge bids on the first book; the next refresh must release that hold too.
      const judge = await placeBid(
        { db, paypal, audit: auditHook, allowTestCard: true, testCard: SEED_TEST_CARDS[0] },
        {
          shopperId,
          listingId: first.check.listingId,
          amountCents: 23_000,
          paymentMethod: 'TEST_CARD',
          source: 'OFFER_PAGE',
          idempotencyKey: 'judge-1',
        },
      );
      expect(judge.ok).toBe(true);
      if (judge.ok) firstBook.add(judge.bid.paypal_authorization_id!);

      const second = refreshed(await refresh());
      expect(second.check.listingId).not.toBe(first.check.listingId);
      expect(second.seed.runId).not.toBe(first.seed.runId);
      expect(second.check).toMatchObject({ status: 'OPEN', leftoverBids: 0 });
      expect(second.reset.verify.checked).toBeGreaterThanOrEqual(firstBook.size);
      // Zero leftover sandbox authorizations from the previous book.
      for (const id of firstBook) expect(fake.authorization(id)?.status).not.toBe('CREATED');
      const listings = await q<{ demo_run_id: string; status: string }>(
        `SELECT demo_run_id, status FROM listings`,
      );
      expect(listings.every((l) => l.demo_run_id === second.seed.runId)).toBe(true);
      // The foreground demo shopper survives (judges sign in as them).
      expect(await q(`SELECT 1 FROM shoppers WHERE id = $1`, [shopperId])).toHaveLength(1);
      await expectNoStrayHolds();
    });

    it('a refresh while another holds the lock is SKIPPED and changes nothing', async () => {
      const before = await q<{ id: string }>(`SELECT id FROM listings ORDER BY id`);
      const client = await db.pool.connect();
      try {
        await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [REFRESH_LOCK]);
        expect(await refresh()).toEqual({ status: 'SKIPPED', reason: 'ALREADY_RUNNING' });
        await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [REFRESH_LOCK]);
      } finally {
        client.release();
      }
      expect(await q<{ id: string }>(`SELECT id FROM listings ORDER BY id`)).toEqual(before);
    });

    it('race: two refreshes at once → exactly one runs, and no hold is left behind', async () => {
      const results = await Promise.all([refresh(), refresh()]);
      expect(results.map((r) => r.status).sort()).toEqual(['REFRESHED', 'SKIPPED']);
      const listings = await q<{ status: string }>(`SELECT status FROM listings`);
      expect(listings).toHaveLength(2);
      expect(listings.every((l) => l.status === 'OPEN')).toBe(true);
      await expectNoStrayHolds();
    });

    it('retries a busy reset (e.g. a manual demo:reset running) and then refreshes', async () => {
      const client = await db.pool.connect();
      const sleeps: number[] = [];
      try {
        await client.query(`SELECT pg_advisory_lock(hashtextextended('holdfast:demo-reset', 0))`);
        const r = refreshed(
          await refresh({
            // The "other reset" finishes while the refresh waits.
            sleep: async (ms) => {
              sleeps.push(ms);
              await client.query(
                `SELECT pg_advisory_unlock(hashtextextended('holdfast:demo-reset', 0))`,
              );
            },
          }),
        );
        expect(r.attempts).toBe(2);
        expect(sleeps).toEqual([120_000]);
        expect(r.check.status).toBe('OPEN');
      } finally {
        client.release();
      }
      await expectNoStrayHolds();
    });

    it('gives up after maxAttempts when the reset stays refused', async () => {
      const client = await db.pool.connect();
      try {
        await client.query(`SELECT pg_advisory_lock(hashtextextended('holdfast:demo-reset', 0))`);
        await expect(refresh({ maxAttempts: 2 })).rejects.toBeInstanceOf(DemoResetRefusedError);
        await client.query(`SELECT pg_advisory_unlock(hashtextextended('holdfast:demo-reset', 0))`);
      } finally {
        client.release();
      }
      // The previous judge book is untouched and still open.
      const open = await q(`SELECT 1 FROM listings WHERE status = 'OPEN'`);
      expect(open).toHaveLength(2);
    });

    it('a failed verify stops at once (no retry) and deletes nothing', async () => {
      const bidsBefore = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM bids`))[0]!.n;
      let sleeps = 0;
      // Every authorization GET fails: the reset cannot prove the holds are gone.
      fake.failNext('get_authorization', { kind: 'status', http: 500 }, 10_000);
      try {
        await expect(
          refresh({
            sleep: async () => {
              sleeps++;
            },
          }),
        ).rejects.toBeInstanceOf(DemoResetVerifyError);
      } finally {
        fake.clearFaults();
      }
      expect(sleeps).toBe(0);
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM bids`))[0]!.n).toBe(
        bidsBefore,
      );
      // Recovers on the next run.
      refreshed(await refresh());
      await expectNoStrayHolds();
    });

    it('race: a judge hold landing during the refresh never survives it', async () => {
      const current = await q<{ id: string }>(
        `SELECT id FROM listings WHERE status = 'OPEN' AND slug = 'aurel-a7'`,
      );
      const listingId = current[0]!.id;
      const bids = Array.from({ length: 6 }, (_, i) =>
        placeBid(
          { db, paypal, audit: auditHook, allowTestCard: true, testCard: SEED_TEST_CARDS[i % 4] },
          {
            shopperId,
            listingId,
            amountCents: 22_000 + i * 100,
            paymentMethod: 'TEST_CARD',
            source: 'OFFER_PAGE',
            idempotencyKey: `judge-race-${i}`,
          },
        ).catch((e: unknown) => e),
      );
      const r = refreshed(await refresh({ maxAttempts: 6 }));
      await Promise.all(bids);
      expect(r.check.leftoverBids).toBe(0);
      // Whatever the interleaving, a hold from the old book is released or the refresh retried.
      await expectNoStrayHolds();
      const old = await q(`SELECT 1 FROM listings WHERE id = $1`, [listingId]);
      expect(old).toHaveLength(0);
    });
  },
);
