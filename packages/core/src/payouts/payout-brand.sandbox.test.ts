/**
 * HF-032 `payoutBrand` against the real PayPal sandbox (ticket test plan: the S4 pattern after a
 * capture batch, through the HF-030a in-process runner, then the poll until the item is SUCCESS).
 * Manual only:
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… \
 *     npx vitest run --maxWorkers=2 packages/core/src/payouts/payout-brand.sandbox.test.ts
 * Default: 5 winners (≈ $1k net). `PAYOUT_FULL=1`: the acceptance run, 240 winners at an average
 * of $226 → ≈ $49.4k net in one payout to `PAYPAL_BRAND_EMAIL`, funded by those captures.
 * Reads credentials and the brand email from `.env`; never prints them. Refuses a non-sandbox
 * base. Every hold it makes is captured or voided before it ends.
 */
import { feeCents } from '@holdfast/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSandboxPayPalBase } from '../config.js';
import type { Db } from '../db.js';
import { loadDotenv } from '../env.js';
import { voidKey } from '../money/void.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { PayPalRestClient } from '../paypal/client.js';
import { inProcessSettlementRunner, runLimited } from '../settlement/settle-listing.js';
import { seedClearedListing, testPromoteWithin } from '../settlement/test-fixtures.js';
import { makePayoutBrand, pollPayouts, type PayoutDeps, type PayoutRow } from './payout-brand.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;
const FULL = process.env.PAYOUT_FULL === '1';

describe.skipIf(!enabled)('HF-032 payoutBrand: PayPal sandbox', () => {
  let t: TestDatabase;
  let db: Db;
  let client: PayPalRestClient;

  beforeAll(async () => {
    loadDotenv();
    if (!process.env.PAYPAL_BRAND_EMAIL) throw new Error('PAYPAL_BRAND_EMAIL is not set');
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
    FULL
      ? '240 captures at an average of $226 → one ≈ $49.4k payout reaches SUCCESS'
      : '5 captures → one payout of the net reaches SUCCESS',
    { timeout: 15 * 60_000 },
    async () => {
      const winners = FULL ? 240 : 5;
      // Alternating $226.50 / $225.50: an average of exactly $226 for an even count.
      const winnerCents = (rank: number) => (rank % 2 === 1 ? 22_650 : 22_550);
      const s = await seedClearedListing(db, client, {
        winners,
        reserve: 0,
        belowFloor: 1,
        holdConcurrency: 20,
        winnerCents,
        description: 'Holdfast HF-032 sandbox payout test',
      });
      await db.pool.query(`UPDATE listings SET payout_email_snapshot = $2 WHERE id = $1`, [
        s.listingId,
        process.env.PAYPAL_BRAND_EMAIL,
      ]);
      const payouts: PayoutDeps = { db, paypal: client };
      const runner = inProcessSettlementRunner({
        db,
        paypal: client,
        promoteWithin: testPromoteWithin,
        payoutBrand: makePayoutBrand(payouts),
      });
      const res = await runner.settle(s.listingId);
      expect(res.outcome).toBe('SETTLED');

      const gross = s.winners.reduce((sum, w) => sum + w.amountCents, 0);
      const rows = (
        await db.pool.query(`SELECT * FROM payouts WHERE listing_id = $1`, [s.listingId])
      ).rows as PayoutRow[];
      expect(rows).toHaveLength(1);
      const p = rows[0]!;
      expect(p).toMatchObject({
        attempt: 1,
        gross_real_cents: gross,
        fee_cents: feeCents(gross, 900),
        net_cents: gross - feeCents(gross, 900),
      });
      console.info(
        `[HF-032 sandbox] ${winners} captures, gross ${gross}¢, net ${p.net_cents}¢, ` +
          `payout ${p.status} ${p.error_code ?? ''} batch ${p.paypal_batch_id ?? '–'}`,
      );
      expect(p.status).toBe('PENDING');
      expect(p.paypal_batch_id).toBeTruthy();

      // The cron's poll, every 10 s, until the item resolves (S7: SUCCESS in ≈ 20–30 s).
      let status = 'SETTLED';
      for (let i = 0; i < 60 && status === 'SETTLED'; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        await pollPayouts(payouts);
        status = (
          (await db.pool.query(`SELECT status FROM listings WHERE id = $1`, [s.listingId]))
            .rows[0] as { status: string }
        ).status;
      }
      const done = (
        await db.pool.query(
          `SELECT status, item_status, paypal_batch_status, error_code FROM payouts WHERE id = $1`,
          [p.id],
        )
      ).rows[0] as Pick<PayoutRow, 'status' | 'item_status' | 'paypal_batch_status' | 'error_code'>;
      console.info(`[HF-032 sandbox] listing ${status}, payout ${JSON.stringify(done)}`);
      expect(status).toBe('PAID_OUT');
      expect(done).toMatchObject({ status: 'SUCCESS', item_status: 'SUCCESS' });
    },
  );
});
