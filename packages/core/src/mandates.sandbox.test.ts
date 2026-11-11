/**
 * HF-017a against the real PayPal sandbox (manual / nightly): pausing a mandate voids its real
 * holds.
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… npx vitest run packages/core/src/mandates.sandbox.test.ts
 * Reads credentials from `.env` and never prints them; refuses a non-sandbox base. Any hold left
 * live at the end is voided (`void-<bidId>`).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import { placeBid, type PlaceBidDeps } from './bids.js';
import { isSandboxPayPalBase } from './config.js';
import { loadDotenv } from './env.js';
import { pauseMandate } from './mandates.js';
import { voidBid } from './money/void.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { PayPalRestClient } from './paypal/client.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;

describe.runIf(enabled)('HF-017a mandates (PayPal sandbox)', () => {
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
    // Backstop: release anything the test left HELD or VOIDING.
    for (const id of bids) {
      await voidBid(deps, id, 'CANCELLED', { type: 'SYSTEM' }, { from: ['HELD'], resume: true });
    }
    await t?.close();
  }, 120_000);

  it('pause voids every real HELD hold under the mandate', { timeout: 180_000 }, async () => {
    const s = await fx.shopper();
    const m = await fx.mandate(s.id, { maxPriceCents: 5_000, capCents: 10_000 });
    for (let i = 0; i < 2; i++) {
      const l = await fx.listing();
      const r = await placeBid(deps, {
        shopperId: s.id,
        listingId: l.id,
        amountCents: 2_500,
        paymentMethod: 'TEST_CARD',
        source: 'SIM',
        mandateId: m.id,
        idempotencyKey: randomUUID(),
      });
      expect(r.ok, JSON.stringify(r.ok ? null : r.error)).toBe(true);
      if (!r.ok) return;
      bids.push(r.bid.id);
      expect(r.bid).toMatchObject({ status: 'HELD', mandate_id: m.id });
    }

    const started = Date.now();
    const paused = await pauseMandate(deps, m.id, { actor: { type: 'SHOPPER', id: s.id } });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(paused).toMatchObject({ ok: true, release: { leftVoiding: [] } });

    for (const id of bids) {
      const row = await fx.bid(id);
      expect(row).toMatchObject({ status: 'VOIDED', void_reason: 'MANDATE_PAUSED' });
      const auth = await client.getAuthorization(row.paypal_authorization_id as string);
      expect(auth.status).toBe('VOIDED');
    }
  });
});
