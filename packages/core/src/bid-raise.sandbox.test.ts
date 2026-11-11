/**
 * HF-018 against the real PayPal sandbox (manual / nightly): a vaulted raise swaps holds, and a
 * declined raise (sandbox negative testing, `PayPal-Mock-Response`) leaves the old hold standing.
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… npx vitest run packages/core/src/bid-raise.sandbox.test.ts
 * Reads credentials from `.env` and never prints them; refuses a non-sandbox base. Every hold it
 * creates is voided at the end.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import { raiseBid, raiseBidResponse } from './bid-raise.js';
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

describe.runIf(enabled)('HF-018 raiseBid (PayPal sandbox)', () => {
  let t: TestDatabase;
  let fx: Fixtures;
  let client: PayPalRestClient;
  let deps: PlaceBidDeps;
  let vaultId: string;
  /** Test-only: the next order create carries a sandbox mock decline. */
  let declineNextCreate = false;
  const bids: string[] = [];
  const stray: { authorizationId: string; bidId: string }[] = [];

  const mockingFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (declineNextCreate && init?.method === 'POST' && /\/v2\/checkout\/orders$/.test(url)) {
      declineNextCreate = false;
      const headers = new Headers(init.headers);
      headers.set(
        'PayPal-Mock-Response',
        JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' }),
      );
      return fetch(input, { ...init, headers });
    }
    return fetch(input, init);
  };

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
      fetch: mockingFetch,
    });
    t = await createTestDatabase();
    fx = new Fixtures(t.db);
    deps = { db: t.db, paypal: client, audit: auditHook, allowTestCard: true };

    // Vault a card the way S2 did (first hold ON_SUCCESS); that first hold is released at the end.
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
    for (const id of bids) await voidBid(deps, id, 'CANCELLED', { type: 'SYSTEM' });
    for (const h of stray) await client.void(h.authorizationId, voidKey(h.bidId));
    await t?.close();
  }, 120_000);

  async function heldBid(): Promise<{ id: string; shopperId: string; authId: string }> {
    const l = await fx.listing();
    const s = await fx.shopper();
    await t.db.pool.query(`UPDATE shoppers SET paypal_vault_id = $2 WHERE id = $1`, [
      s.id,
      vaultId,
    ]);
    const r = await placeBid(deps, {
      shopperId: s.id,
      listingId: l.id,
      amountCents: 22_900,
      paymentMethod: 'VAULT',
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
    });
    expect(r.ok, JSON.stringify(r.ok ? null : r.error)).toBe(true);
    if (!r.ok) throw new Error('no hold');
    bids.push(r.bid.id);
    return { id: r.bid.id, shopperId: s.id, authId: r.bid.paypal_authorization_id! };
  }

  it(
    'raise: new hold HELD (CREATED at PayPal), old hold VOIDED with REPLACED',
    { timeout: 120_000 },
    async () => {
      const old = await heldBid();
      const r = await raiseBid(deps, {
        bidId: old.id,
        amountCents: 23_900,
        shopperId: old.shopperId,
        idempotencyKey: randomUUID(),
      });
      expect(r.ok, JSON.stringify(r.ok ? null : r.error)).toBe(true);
      if (!r.ok) return;
      bids.push(r.bid.id);
      expect(r.bid).toMatchObject({ status: 'HELD', authorized_amount_cents: 23_900 });
      expect(r.oldBid).toMatchObject({ status: 'VOIDED', void_reason: 'REPLACED' });
      expect((await client.getAuthorization(r.bid.paypal_authorization_id!)).status).toBe(
        'CREATED',
      );
      expect((await client.getAuthorization(old.authId)).status).toBe('VOIDED');
    },
  );

  it(
    'raise with a mock decline: 422 HOLD_FAILED, the old hold stays CREATED',
    { timeout: 120_000 },
    async () => {
      const old = await heldBid();
      declineNextCreate = true;
      const r = await raiseBid(deps, {
        bidId: old.id,
        amountCents: 23_900,
        shopperId: old.shopperId,
        idempotencyKey: randomUUID(),
      });
      declineNextCreate = false;
      if (r.ok) bids.push(r.bid.id);
      expect(r).toMatchObject({ ok: false, error: { code: 'HOLD_FAILED' } });
      expect(raiseBidResponse(r).body).toMatchObject({
        error: { message: "Couldn't raise. Your $229 bid still stands." },
      });
      expect(
        (await t.db.pool.query(`SELECT status FROM bids WHERE id = $1`, [old.id])).rows[0].status,
      ).toBe('HELD');
      expect((await client.getAuthorization(old.authId)).status).toBe('CREATED');
    },
  );
});

describe.skipIf(enabled)('HF-018 raiseBid (PayPal sandbox)', () => {
  it.skip('set PAYPAL_CONTRACT=sandbox and TEST_DATABASE_URL to run against the sandbox', () => {});
});
