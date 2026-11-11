/**
 * HF-034 `reconcile:holds` against the real PayPal sandbox (ticket test plan: after a seeded run;
 * acceptance: finds and voids a live sandbox authorization whose DB row says VOIDED). Manual only:
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… \
 *     npx vitest run --maxWorkers=2 packages/core/src/crons/reconcile-holds.sandbox.test.ts
 * Reads credentials from `.env`; never prints them. Refuses a non-sandbox base. Every hold it makes
 * is captured or voided before it ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { isSandboxPayPalBase } from '../config.js';
import type { Db } from '../db.js';
import { loadDotenv } from '../env.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { voidKey } from '../money/void.js';
import { PayPalRestClient } from '../paypal/client.js';
import { orderRequestId } from '../paypal/ids.js';
import { inProcessSettlementRunner } from '../settlement/settle-listing.js';
import {
  SETTLE_TEST_CARD,
  seedClearedListing,
  type ClearedListing,
} from '../settlement/test-fixtures.js';
import { reconcileHolds } from './reconcile-holds.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;

describe.skipIf(!enabled)('HF-034 reconcile:holds: PayPal sandbox', { timeout: 180_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let client: PayPalRestClient;
  const authIds: string[] = [];

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
  });

  afterAll(async () => {
    // Never leave a sandbox hold behind, whatever failed above.
    for (const id of authIds) {
      try {
        const a = await client.getAuthorization(id);
        if (a.status === 'CREATED') await client.void(id, `void-cleanup-${id}` as never);
      } catch {
        // best effort
      }
    }
    await t?.close();
  });

  it('after a settled run, voids a live authorization whose row says VOIDED; nothing is left CREATED', async () => {
    const s: ClearedListing = await seedClearedListing(db, client, {
      winners: 2,
      reserve: 1,
      belowFloor: 1,
      description: 'Holdfast HF-034 reconcile:holds sandbox test',
    });
    for (const b of [...s.winners, ...s.reserve, ...s.belowFloor]) authIds.push(b.authorizationId);
    const runner = inProcessSettlementRunner({ db, paypal: client, payoutBrand: async () => {} });
    expect((await runner.settle(s.listingId)).outcome).toBe('SETTLED');

    // Plant the D19 case: a loser whose row says VOIDED while PayPal still holds the money.
    const shopper = (await db.pool.query(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`))
      .rows[0] as {
      id: string;
    };
    const lying = (
      await db.pool.query(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, void_reason, idempotency_key)
         VALUES ($1, $2, 12300, 'VOIDED', 'LOST', gen_random_uuid()::text) RETURNING id`,
        [s.listingId, shopper.id],
      )
    ).rows[0] as { id: string };
    const hold = await client.createAuthOrder({
      requestId: orderRequestId(lying.id),
      amountCents: 12_300,
      paymentSource: { kind: 'test_card', card: SETTLE_TEST_CARD },
      description: 'Holdfast HF-034 reconcile:holds sandbox test',
    });
    if (hold.kind !== 'held') throw new Error(`no hold: ${hold.kind}`);
    authIds.push(hold.authorizationId);
    await db.pool.query(
      `UPDATE bids SET paypal_order_id = $2, paypal_authorization_id = $3,
              authorized_amount_cents = amount_cents, authorized_at = now()
        WHERE id = $1`,
      [lying.id, hold.orderId, hold.authorizationId],
    );

    const res = await reconcileHolds(
      { db, paypal: client, audit: auditHook },
      { listingIds: [s.listingId] },
    );
    expect(res).toMatchObject({ created: 1, live: 0, voided: 1, failed: 0, stillCreated: [] });
    expect((await client.getAuthorization(hold.authorizationId)).status).toBe('VOIDED');
    const audited = (
      await db.pool.query(
        `SELECT paypal_id, request_id FROM audit_events WHERE entity_id = $1 AND action = 'HOLD_RECONCILED'`,
        [lying.id],
      )
    ).rows;
    expect(audited).toEqual([{ paypal_id: hold.authorizationId, request_id: voidKey(lying.id) }]);

    // A second pass finds nothing CREATED (the demo:reset "verify none left" check).
    const again = await reconcileHolds(
      { db, paypal: client, audit: auditHook },
      { listingIds: [s.listingId] },
    );
    expect(again).toMatchObject({ created: 0, voided: 0, failed: 0, stillCreated: [] });
    for (const id of authIds) {
      expect(['VOIDED', 'CAPTURED']).toContain((await client.getAuthorization(id)).status);
    }
  });
});
