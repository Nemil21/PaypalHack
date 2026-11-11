/**
 * HF-012b `cancelListing` against the real PayPal sandbox (ticket test plan: cancel with 2 holds
 * created directly with the HF-004 client, the S1 pattern). Manual only:
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… \
 *     npx vitest run --maxWorkers=2 packages/core/src/listings/cancel-quantity.sandbox.test.ts
 * Reads credentials from `.env`; never prints them. Refuses a non-sandbox base. Every hold it makes
 * is voided before it ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { isSandboxPayPalBase } from '../config.js';
import { loadDotenv } from '../env.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../money/test-harness.js';
import { voidKey } from '../money/void.js';
import { PayPalRestClient } from '../paypal/client.js';
import { orderRequestId } from '../paypal/ids.js';
import { SETTLE_TEST_CARD } from '../settlement/test-fixtures.js';
import { cancelListing, type CancelListingDeps } from './cancel-quantity.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;

describe.runIf(enabled)('HF-012b cancelListing (PayPal sandbox)', () => {
  let t: TestDatabase;
  let fx: Fixtures;
  let client: PayPalRestClient;
  let deps: CancelListingDeps;
  const auths: Array<{ bidId: string; authorizationId: string }> = [];

  beforeAll(async () => {
    loadDotenv();
    const base = process.env.PAYPAL_API_BASE ?? '';
    if (!isSandboxPayPalBase(base)) throw new Error('runs only against a PayPal sandbox base');
    client = new PayPalRestClient({
      baseUrl: base,
      clientId: process.env.PAYPAL_CLIENT_ID ?? '',
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
      allowRawCard: true,
      timeoutMs: 30_000,
    });
    t = await createTestDatabase();
    fx = new Fixtures(t.db);
    deps = { db: t.db, paypal: client, audit: auditHook };
  }, 60_000);

  afterAll(async () => {
    // Safety net: release anything a failed assertion left held.
    for (const a of auths) await client.void(a.authorizationId, voidKey(a.bidId)).catch(() => {});
    await t?.close();
  }, 120_000);

  it(
    'cancel with 2 sandbox holds: 202 at once, both authorizations VOIDED',
    { timeout: 120_000 },
    async () => {
      const l = await fx.listing();
      const brandId = (
        await t.db.pool.query<{ brand_id: string }>(`SELECT brand_id FROM listings WHERE id = $1`, [
          l.id,
        ])
      ).rows[0]!.brand_id;

      for (const amountCents of [21_900, 23_400]) {
        const s = await fx.shopper();
        const bid = await fx.pendingBid(l.id, s.id, { amountCents });
        const hold = await client.createAuthOrder({
          requestId: orderRequestId(bid.id),
          amountCents,
          paymentSource: { kind: 'test_card', card: SETTLE_TEST_CARD },
          description: 'Holdfast HF-012b listing cancel test',
        });
        if (hold.kind !== 'held') throw new Error(`no hold: ${hold.kind}`);
        auths.push({ bidId: bid.id, authorizationId: hold.authorizationId });
        await t.db.pool.query(
          `UPDATE bids SET status = 'HELD', paypal_order_id = $2, paypal_authorization_id = $3,
                authorized_amount_cents = amount_cents, authorized_at = now()
          WHERE id = $1`,
          [bid.id, hold.orderId, hold.authorizationId],
        );
        expect((await client.getAuthorization(hold.authorizationId)).status).toBe('CREATED');
      }

      const r = await cancelListing(deps, {
        listingId: l.id,
        brandId,
        actor: { type: 'BRAND_USER', id: null },
      });
      expect(r).toMatchObject({ ok: true, response: { status: 'CANCELLED', voiding: 2 } });
      if (!r.ok) return;
      const released = await r.released;
      expect(released.leftVoiding).toEqual([]);
      for (const a of auths) {
        expect(await fx.bid(a.bidId)).toMatchObject({
          status: 'VOIDED',
          void_request_id: voidKey(a.bidId),
        });
        expect((await client.getAuthorization(a.authorizationId)).status).toBe('VOIDED');
      }
    },
  );
});

describe.skipIf(enabled)('HF-012b cancelListing (PayPal sandbox)', () => {
  it.skip('set PAYPAL_CONTRACT=sandbox and TEST_DATABASE_URL to run against the sandbox', () => {});
});
