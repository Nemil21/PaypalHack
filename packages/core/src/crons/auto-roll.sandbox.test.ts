/**
 * HF-053 against the real PayPal sandbox (manual / nightly): a lost bid rolls into the next window
 * as a merchant-initiated hold from the shopper's card vault, with no shopper present (S2).
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… \
 *     npx vitest run --maxWorkers=2 packages/core/src/crons/auto-roll.sandbox.test.ts
 * Reads credentials from `.env` and never prints them; refuses a non-sandbox base. Every hold it
 * makes is voided at the end (`void-<bidId>`).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { SANDBOX_TEST_CARD, type PlaceBidDeps } from '../bids.js';
import { isSandboxPayPalBase } from '../config.js';
import { loadDotenv } from '../env.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../money/test-harness.js';
import { voidBid, voidKey } from '../money/void.js';
import { PayPalRestClient } from '../paypal/client.js';
import { orderRequestId } from '../paypal/ids.js';
import { autoRollBids } from './auto-roll.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;

describe.runIf(enabled)('HF-053 auto-roll (PayPal sandbox)', () => {
  let t: TestDatabase;
  let fx: Fixtures;
  let client: PayPalRestClient;
  let deps: PlaceBidDeps;
  let vaultId: string;
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
    deps = { db: t.db, paypal: client, audit: auditHook };

    // Vault a card the way S2 did (first hold ON_SUCCESS); that hold is released at the end.
    const setupId = randomUUID();
    const first = await client.createAuthOrder({
      requestId: orderRequestId(setupId),
      amountCents: 100,
      paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD, vault: true },
    });
    if (first.kind !== 'held' || !first.vault?.id) throw new Error('no vault');
    stray.push({ authorizationId: first.authorizationId, bidId: setupId });
    vaultId = first.vault.id;
  }, 90_000);

  afterAll(async () => {
    for (const id of bids) {
      await voidBid(deps, id, 'CANCELLED', { type: 'SYSTEM' }, { from: ['HELD'], resume: true });
    }
    for (const h of stray) await client.void(h.authorizationId, voidKey(h.bidId));
    await t?.close();
  }, 120_000);

  it('rolls a lost bid into window 2 as a real MIT vault hold', { timeout: 120_000 }, async () => {
    const q = async (sql: string, params: unknown[] = []) =>
      (await t.db.pool.query(sql, params)).rows;
    const s = await fx.shopper();
    await q(`UPDATE shoppers SET paypal_vault_id = $2 WHERE id = $1`, [s.id, vaultId]);
    const [brand] = await q(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
    );
    const [product] = await q(`INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`);
    const [window1] = await q(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, 'SETTLED', 5, 1000, now() - interval '30 hours', now() - interval '6 hours')
       RETURNING id`,
      [brand.id, product.id],
    );
    const [window2] = await q(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, 'OPEN', 5, 1000, now() - interval '1 hour', now() + interval '24 hours')
       RETURNING id`,
      [brand.id, product.id],
    );
    const m = await fx.mandate(s.id, { maxPriceCents: 2_100, capCents: 2_100 });
    const [lost] = await q(
      `INSERT INTO bids (listing_id, shopper_id, mandate_id, amount_cents, status, void_reason,
                         voided_at, payment_method, source, idempotency_key)
       VALUES ($1, $2, $3, 2100, 'VOIDED', 'LOST', now(), 'VAULT', 'BUYER_AGENT',
               gen_random_uuid()::text)
       RETURNING id`,
      [window1.id, s.id, m.id],
    );

    const r = await autoRollBids(deps);
    const [roll] = await q(`SELECT * FROM bids WHERE replaces_bid_id = $1`, [lost.id]);
    if (roll) bids.push(roll.id);
    expect(r.rolled, JSON.stringify(r)).toBe(1);
    expect(roll).toMatchObject({
      status: 'HELD',
      listing_id: window2.id,
      payment_method: 'VAULT',
      source: 'BUYER_AGENT',
      idempotency_key: `roll:${lost.id}`,
    });
    const auth = await client.getAuthorization(roll.paypal_authorization_id);
    expect(auth.status).toBe('CREATED');

    // A second run does not hold again.
    expect((await autoRollBids(deps)).rolled).toBe(0);
    expect(await q(`SELECT 1 FROM bids WHERE replaces_bid_id = $1`, [lost.id])).toHaveLength(1);
  });
});
