/**
 * HF-029 `settleBid` against the real PayPal sandbox (ticket test plan: capture, void, mock
 * decline, idempotent replay with the S7 issue codes). Manual only:
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… \
 *     npx vitest run packages/core/src/settlement/settle-bid.sandbox.test.ts
 * Reads credentials from `.env`; never prints them. Refuses a non-sandbox base. Every hold it
 * makes is captured or voided before it ends.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSandboxPayPalBase } from '../config.js';
import type { Db } from '../db.js';
import { loadDotenv } from '../env.js';
import { voidKey } from '../money/void.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { PayPalRestClient } from '../paypal/client.js';
import { captureRequestId } from '../paypal/ids.js';
import type { PromoteWithin } from './promote.js';
import { promoteWithin } from './promote.js';
import { settleBid, type SettleBidDeps } from './settle-bid.js';
import { seedSettlement, type SeededSettlement, type SeedOptions } from './test-fixtures.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;
const opts = { timeout: 120_000 };

describe.skipIf(!enabled)('HF-029 settleBid: PayPal sandbox', () => {
  let t: TestDatabase;
  let db: Db;
  let client: PayPalRestClient;
  const seeded: SeededSettlement[] = [];
  const promotions: string[] = [];

  const promote: PromoteWithin = async (tx, bidId) => {
    promotions.push(bidId);
    return promoteWithin(tx, bidId);
  };
  const deps = (): SettleBidDeps => ({
    db,
    paypal: client,
    promoteWithin: promote,
    allowMockDecline: true,
  });
  const seed = async (cols: SeedOptions = {}) => {
    const s = await seedSettlement(db, client, cols);
    seeded.push(s);
    return s;
  };
  const row = async (id: string) =>
    (await db.pool.query(`SELECT * FROM settlements WHERE id = $1`, [id])).rows[0] as Record<
      string,
      unknown
    >;
  const bidStatus = async (id: string) =>
    (
      (await db.pool.query(`SELECT status FROM bids WHERE id = $1`, [id])).rows[0] as {
        status: string;
      }
    ).status;

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
    // Nothing left CREATED (S7 final check).
    for (const s of seeded) {
      const auth = await client.getAuthorization(s.authorizationId);
      if (auth.status === 'CREATED') await client.void(s.authorizationId, voidKey(s.bidId));
    }
    await t?.close();
  }, 120_000);

  it(
    'CAPTURE → COMPLETED at the bid amount; a takeover replays the same capture id (S3)',
    opts,
    async () => {
      const s = await seed({ amountCents: 21_900 });
      const first = await settleBid(deps(), s.settlementId);
      expect(first).toMatchObject({ outcome: 'SUCCEEDED', paypalStatus: 'COMPLETED' });
      const captureId = first.outcome === 'SUCCEEDED' ? first.paypalId : null;
      expect(captureId).toBeTruthy();
      expect((await client.getAuthorization(s.authorizationId)).status).toBe('CAPTURED');

      // Re-running SUCCEEDED is a no-op.
      expect(await settleBid(deps(), s.settlementId)).toEqual({
        outcome: 'SKIPPED',
        status: 'SUCCEEDED',
      });

      // Simulate a dropped DB write + expired lease: the next worker replays the same request id.
      await db.pool.query(
        `UPDATE settlements SET status = 'RUNNING', lease_until = now() - interval '1 second',
              paypal_id = NULL WHERE id = $1`,
        [s.settlementId],
      );
      await db.pool.query(`UPDATE bids SET status = 'WON' WHERE id = $1`, [s.bidId]);
      const replay = await settleBid(deps(), s.settlementId);
      expect(replay).toMatchObject({
        outcome: 'SUCCEEDED',
        reconciled: false,
        paypalId: captureId,
      });
    },
  );

  it(
    'capture already captured under another id → 422 → RECONCILE → SUCCEEDED, no promotion',
    opts,
    async () => {
      const s = await seed();
      const other = await client.capture({
        authorizationId: s.authorizationId,
        requestId: captureRequestId(randomUUID()),
        amountCents: 21_900,
      });
      expect(other.ok).toBe(true);
      const res = await settleBid(deps(), s.settlementId);
      expect(res).toMatchObject({ outcome: 'SUCCEEDED', reconciled: true });
      if (other.ok && res.outcome === 'SUCCEEDED') expect(res.paypalId).toBe(other.captureId);
      expect(promotions).toEqual([]);
      expect(await bidStatus(s.bidId)).toBe('CAPTURED');
    },
  );

  it('VOID → VOIDED with void-<bidId>', opts, async () => {
    const s = await seed({ action: 'VOID' });
    expect(await settleBid(deps(), s.settlementId)).toMatchObject({ outcome: 'SUCCEEDED' });
    expect((await client.getAuthorization(s.authorizationId)).status).toBe('VOIDED');
    expect(await bidStatus(s.bidId)).toBe('VOIDED');
  });

  it('mock INSTRUMENT_DECLINED → FAILED TERMINAL, one promotion, hold voided', opts, async () => {
    const s = await seed({ mock: 'INSTRUMENT_DECLINED' });
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({ outcome: 'FAILED', errorClass: 'TERMINAL', void: 'VOIDED' });
    expect(await row(s.settlementId)).toMatchObject({ status: 'FAILED', error_class: 'TERMINAL' });
    expect(promotions).toEqual([s.bidId]);
    expect((await client.getAuthorization(s.authorizationId)).status).toBe('VOIDED');
  });

  it('mock AUTHORIZATION_EXPIRED → FAILED TERMINAL, hold voided (S7 step 5)', opts, async () => {
    const s = await seed({ mock: 'AUTHORIZATION_EXPIRED' });
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({ outcome: 'FAILED', code: 'AUTHORIZATION_EXPIRED', void: 'VOIDED' });
    expect((await client.getAuthorization(s.authorizationId)).status).toBe('VOIDED');
  });
});
