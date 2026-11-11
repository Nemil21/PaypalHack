/**
 * HF-016 against the real PayPal sandbox (manual / nightly): hold → cancel → VOIDED, double void.
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… npx vitest run packages/core/src/bid-cancel.sandbox.test.ts
 * Reads credentials from `.env` and never prints them; refuses a non-sandbox base. Every hold it
 * creates is voided (`void-<bidId>`).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import { cancelBid } from './bid-cancel.js';
import { placeBid, type PlaceBidDeps } from './bids.js';
import { isSandboxPayPalBase } from './config.js';
import { loadDotenv } from './env.js';
import { isReleased, voidBid, voidKey } from './money/void.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { PayPalRestClient } from './paypal/client.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;

describe.runIf(enabled)('HF-016 cancelBid (PayPal sandbox)', () => {
  let t: TestDatabase;
  let fx: Fixtures;
  let client: PayPalRestClient;
  let deps: PlaceBidDeps;
  const bids: string[] = [];

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
    deps = { db: t.db, paypal: client, audit: auditHook, allowTestCard: true };
  }, 60_000);

  afterAll(async () => {
    // Safety net: anything a failed assertion left HELD is released.
    for (const id of bids) await voidBid(deps, id, 'CANCELLED', { type: 'SYSTEM' });
    await t?.close();
  }, 120_000);

  it(
    'hold → cancel → VOIDED; voiding again (same id, then a new id) is success',
    { timeout: 120_000 },
    async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const placed = await placeBid(deps, {
        shopperId: s.id,
        listingId: l.id,
        amountCents: 22_900,
        paymentMethod: 'TEST_CARD',
        source: 'OFFER_PAGE',
        idempotencyKey: randomUUID(),
      });
      expect(placed.ok, JSON.stringify(placed.ok ? null : placed.error)).toBe(true);
      if (!placed.ok) return;
      const bid = placed.bid;
      bids.push(bid.id);
      const authId = bid.paypal_authorization_id!;
      expect((await client.getAuthorization(authId)).status).toBe('CREATED');

      const r = await cancelBid(deps, { bidId: bid.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: true, outcome: 'VOIDED', bid: { status: 'VOIDED' } });
      expect((await client.getAuthorization(authId)).status).toBe('VOIDED');
      const audit = await t.db.pool.query(
        `SELECT paypal_id FROM audit_events WHERE entity_id = $1 AND action = 'BID_VOIDED'`,
        [bid.id],
      );
      expect(audit.rows[0]?.paypal_id).toBe(authId);

      // Same PayPal-Request-Id → the same VOIDED answer; another id → PREVIOUSLY_VOIDED = success.
      expect(isReleased(await client.void(authId, voidKey(bid.id)))).toBe(true);
      expect(isReleased(await client.void(authId, `${voidKey(bid.id)}-again` as never))).toBe(true);

      // A second cancel is a no-op.
      const again = await cancelBid(deps, { bidId: bid.id, shopperId: s.id });
      expect(again).toMatchObject({ ok: true, outcome: 'UNCHANGED' });
    },
  );
});

describe.skipIf(enabled)('HF-016 cancelBid (PayPal sandbox)', () => {
  it.skip('set PAYPAL_CONTRACT=sandbox and TEST_DATABASE_URL to run against the sandbox', () => {});
});
