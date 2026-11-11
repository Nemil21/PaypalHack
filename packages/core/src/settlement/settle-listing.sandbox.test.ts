/**
 * HF-030a `settleListing` against the real PayPal sandbox (ticket test plan: 50 bids, 1 decline,
 * the S3 pattern, through the in-process runner; acceptance: 300 bids settle in < 2 min).
 * Manual only:
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… \
 *     npx vitest run --maxWorkers=2 packages/core/src/settlement/settle-listing.sandbox.test.ts
 * Add `SETTLE_300=1` for the 300-bid timing run (≈ 300 sandbox holds). Reads credentials from
 * `.env`; never prints them. Refuses a non-sandbox base. Every hold it makes is captured or
 * voided before it ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSandboxPayPalBase } from '../config.js';
import type { Db } from '../db.js';
import { loadDotenv } from '../env.js';
import { voidKey } from '../money/void.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { PayPalRestClient } from '../paypal/client.js';
import { inProcessSettlementRunner, runLimited, type SettleListingDeps } from './settle-listing.js';
import { seedClearedListing, testPromoteWithin, type ClearedListing } from './test-fixtures.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;

describe.skipIf(!enabled)('HF-030a settleListing: PayPal sandbox', () => {
  let t: TestDatabase;
  let db: Db;
  let client: PayPalRestClient;
  const seeded: ClearedListing[] = [];
  const payouts: string[] = [];

  const deps = (): SettleListingDeps => ({
    db,
    paypal: client,
    promoteWithin: testPromoteWithin,
    allowMockDecline: true,
    payoutBrand: async (listingId) => {
      payouts.push(listingId);
    },
  });

  async function settle(opts: { winners: number; reserve: number; belowFloor: number }) {
    const s = await seedClearedListing(db, client, {
      ...opts,
      declineWinners: [3],
      holdConcurrency: 20,
      description: 'Holdfast HF-030a sandbox settlement test',
    });
    seeded.push(s);
    const runner = inProcessSettlementRunner(deps());
    const t0 = Date.now();
    const res = await runner.settle(s.listingId);
    return { s, res, ms: Date.now() - t0 };
  }

  async function expectSettled(s: ClearedListing) {
    const bids = (
      await db.pool.query(
        `SELECT b.id, b.status, b.amount_cents, b.unit_root_bid_id, s.paypal_id, s.paypal_status
           FROM bids b LEFT JOIN settlements s ON s.bid_id = b.id AND s.action = 'CAPTURE'
          WHERE b.listing_id = $1`,
        [s.listingId],
      )
    ).rows as Array<{
      id: string;
      status: string;
      amount_cents: number;
      unit_root_bid_id: string | null;
      paypal_id: string | null;
      paypal_status: string | null;
    }>;
    const captured = bids.filter((b) => b.status === 'CAPTURED');
    expect(captured).toHaveLength(s.winners.length);
    expect(captured.every((b) => b.paypal_id && b.paypal_status === 'COMPLETED')).toBe(true);
    expect(new Set(captured.map((b) => b.paypal_id)).size).toBe(captured.length);
    expect(bids.filter((b) => b.status !== 'CAPTURED').every((b) => b.status === 'VOIDED')).toBe(
      true,
    );
    // The declined winner's unit was filled by the best reserve bid at its own amount.
    const promoted = bids.find((b) => b.id === s.reserve[0]!.bidId)!;
    expect(promoted).toMatchObject({
      status: 'CAPTURED',
      unit_root_bid_id: s.winners[2]!.bidId,
      amount_cents: s.reserve[0]!.amountCents,
    });
    const listing = (
      await db.pool.query(`SELECT status FROM listings WHERE id = $1`, [s.listingId])
    ).rows[0] as { status: string };
    expect(listing.status).toBe('SETTLED');
    expect(payouts.filter((p) => p === s.listingId)).toHaveLength(1);
  }

  beforeAll(async () => {
    loadDotenv();
    const base = process.env.PAYPAL_API_BASE ?? '';
    if (!isSandboxPayPalBase(base)) throw new Error('runs only against a PayPal sandbox base');
    client = new PayPalRestClient({
      baseUrl: base,
      clientId: process.env.PAYPAL_CLIENT_ID ?? '',
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
      allowRawCard: true,
      allowMockResponse: true,
      timeoutMs: 30_000,
    });
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    // Leave nothing CREATED: void every hold that is neither captured nor voided.
    if (db) {
      const left = (
        await db.pool.query(
          `SELECT id, paypal_authorization_id FROM bids
            WHERE paypal_authorization_id IS NOT NULL AND status NOT IN ('CAPTURED', 'VOIDED')`,
        )
      ).rows as Array<{ id: string; paypal_authorization_id: string }>;
      await runLimited(left, 10, (b) =>
        client.void(b.paypal_authorization_id, voidKey(b.id)).catch(() => undefined),
      );
    }
    await t?.close();
  }, 300_000);

  it(
    '50 bids, 1 mock decline: one promotion, every winner captured once, SETTLED, one payout',
    {
      timeout: 300_000,
    },
    async () => {
      const { s, res, ms } = await settle({ winners: 20, reserve: 25, belowFloor: 5 });
      expect(res).toMatchObject({ outcome: 'SETTLED' });
      await expectSettled(s);
      console.info(`[HF-030a sandbox] 50 bids settled in ${ms} ms`);
    },
  );

  it.runIf(process.env.SETTLE_300 === '1')(
    '300 bids settle in < 2 min',
    { timeout: 600_000 },
    async () => {
      const { s, res, ms } = await settle({ winners: 240, reserve: 50, belowFloor: 10 });
      expect(res).toMatchObject({ outcome: 'SETTLED' });
      await expectSettled(s);
      console.info(`[HF-030a sandbox] 300 bids settled in ${ms} ms`);
      expect(ms).toBeLessThan(120_000);
    },
  );
});
