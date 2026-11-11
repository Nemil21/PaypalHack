/**
 * HF-014a against the real PayPal sandbox (manual / nightly): `placeBid` lands real holds.
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… npx vitest run packages/core/src/bids.sandbox.test.ts
 * Reads credentials from `.env` and never prints them; refuses a non-sandbox base. Every hold it
 * creates is voided at the end (`void-<bidId>`).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import { placeBid, SANDBOX_TEST_CARD, type PlaceBidDeps } from './bids.js';
import { isSandboxPayPalBase } from './config.js';
import { loadDotenv } from './env.js';
import { voidBid, voidKey } from './money/void.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { PayPalRestClient } from './paypal/client.js';
import { orderRequestId } from './paypal/ids.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;

describe.runIf(enabled)('HF-014a placeBid (PayPal sandbox)', () => {
  let t: TestDatabase;
  let fx: Fixtures;
  let client: PayPalRestClient;
  let deps: PlaceBidDeps;
  const bids: string[] = [];
  const stray: { authorizationId: string; bidId: string }[] = [];

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
    for (const id of bids) await voidBid(deps, id, 'CANCELLED', { type: 'SYSTEM' });
    for (const h of stray) await client.void(h.authorizationId, voidKey(h.bidId));
    await t?.close();
  }, 120_000);

  it('seed path: server-side test card hold lands HELD (S1)', { timeout: 90_000 }, async () => {
    const l = await fx.listing();
    const s = await fx.shopper();
    const r = await placeBid(deps, {
      shopperId: s.id,
      listingId: l.id,
      amountCents: 22_900,
      paymentMethod: 'TEST_CARD',
      source: 'SIM',
      idempotencyKey: randomUUID(),
    });
    expect(r.ok, JSON.stringify(r.ok ? null : r.error)).toBe(true);
    if (!r.ok) return;
    bids.push(r.bid.id);
    expect(r.bid).toMatchObject({ status: 'HELD', authorized_amount_cents: 22_900 });
    expect((await client.getAuthorization(r.bid.paypal_authorization_id!)).status).toBe('CREATED');
  });

  it(
    'vaulted MIT hold with no shopper present lands HELD; same-id create replays the same order (S2, S7)',
    { timeout: 120_000 },
    async () => {
      // Vault a card the way S2 did (first hold ON_SUCCESS), then release that first hold.
      const setupId = randomUUID();
      const first = await client.createAuthOrder({
        requestId: orderRequestId(setupId),
        amountCents: 100,
        paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD, vault: true },
      });
      expect(first.kind).toBe('held');
      if (first.kind !== 'held' || !first.vault?.id) throw new Error('no vault');
      stray.push({ authorizationId: first.authorizationId, bidId: setupId });

      const l = await fx.listing();
      const s = await fx.shopper();
      await t.db.pool.query(`UPDATE shoppers SET paypal_vault_id = $2 WHERE id = $1`, [
        s.id,
        first.vault.id,
      ]);
      const r = await placeBid(deps, {
        shopperId: s.id,
        listingId: l.id,
        amountCents: 21_900,
        paymentMethod: 'VAULT',
        initiator: 'MERCHANT',
        source: 'SIM',
        idempotencyKey: randomUUID(),
      });
      expect(r.ok, JSON.stringify(r.ok ? null : r.error)).toBe(true);
      if (!r.ok) return;
      bids.push(r.bid.id);
      expect(r.bid.status).toBe('HELD');
      expect(r.bid.authorized_amount_cents).toBe(21_900);
      const auth = await client.getAuthorization(r.bid.paypal_authorization_id!);
      expect(auth.status).toBe('CREATED');
      expect(new Date(auth.createTime!).getTime()).toBe(r.bid.authorized_at!.getTime());

      // Order-create replay with the same request id (bid.id) → the same order and authorization.
      const replay = await client.createAuthOrder({
        requestId: orderRequestId(r.bid.id),
        amountCents: 21_900,
        paymentSource: { kind: 'card_vault', vaultId: first.vault.id, initiator: 'MERCHANT' },
      });
      expect(replay).toMatchObject({
        kind: 'held',
        orderId: r.bid.paypal_order_id,
        authorizationId: r.bid.paypal_authorization_id,
      });
    },
  );
});

describe.skipIf(enabled)('HF-014a placeBid (PayPal sandbox)', () => {
  it.skip('set PAYPAL_CONTRACT=sandbox and TEST_DATABASE_URL to run against the sandbox', () => {});
});
