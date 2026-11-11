import { describe, expect, it } from 'vitest';
import { isReleased, voidKey } from '../money/void.js';
import { FAKE_VALID_WEBHOOK_SIGNATURE, FakePayPal } from './fake.js';
import { authorizeRequestId, captureRequestId, orderRequestId, payoutRequestId } from './ids.js';
import type { PayPalClient, TestCard } from './types.js';

/** Races and fault cases on `FakePayPal` with latency and jitter, so concurrent calls overlap. */

const CARD: TestCard = {
  number: '4111111111111111',
  expiry: '2030-12',
  security_code: '123',
  name: 'Race Buyer',
};
let n = 0;
const uid = (p: string) => `${p}-${++n}`;

async function hold(client: PayPalClient, opts: { vault?: boolean } = {}) {
  const bidId = uid('bid');
  const r = await client.createAuthOrder({
    requestId: orderRequestId(bidId),
    amountCents: 22900,
    paymentSource: { kind: 'test_card', card: CARD, vault: opts.vault ?? false },
  });
  if (r.kind !== 'held') throw new Error(`no hold: ${JSON.stringify(r)}`);
  return { ...r, bidId };
}

function racing() {
  const fake = new FakePayPal({ latencyMs: 2, jitterMs: 8 });
  return { fake, client: fake.client({ timeoutMs: 1_000 }) };
}

describe('capture / void races (FakePayPal)', () => {
  it('10 concurrent captures with one settlement id → one capture, same id everywhere', async () => {
    const { fake, client } = racing();
    const h = await hold(client);
    const requestId = captureRequestId(uid('settlement'));
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        client.capture({ authorizationId: h.authorizationId, requestId, amountCents: 22900 }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.ok && r.captureId)).size).toBe(1);
    expect(fake.capturesOf(h.authorizationId)).toHaveLength(1);
  });

  it('two workers capturing with different ids (lease takeover) → one capture, both SUCCEEDED (B4)', async () => {
    const { fake, client } = racing();
    for (let i = 0; i < 10; i++) {
      const h = await hold(client);
      const [a, b] = await Promise.all([
        client.capture({
          authorizationId: h.authorizationId,
          requestId: captureRequestId(uid('s')),
          amountCents: 22900,
        }),
        client.capture({
          authorizationId: h.authorizationId,
          requestId: captureRequestId(uid('s')),
          amountCents: 22900,
        }),
      ]);
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(a.captureId).toBe(b.captureId);
        expect([a.reconciled, b.reconciled].sort()).toEqual([false, true]);
      }
      expect(fake.capturesOf(h.authorizationId)).toHaveLength(1);
    }
  });

  it('capture racing void → exactly one wins; the loser reports it with an alert', async () => {
    const { fake, client } = racing();
    const winners = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const h = await hold(client);
      const [cap, voided] = await Promise.all([
        client.capture({
          authorizationId: h.authorizationId,
          requestId: captureRequestId(uid('s')),
          amountCents: 22900,
        }),
        client.void(h.authorizationId, voidKey(h.bidId)),
      ]);
      const state = fake.authorization(h.authorizationId)!.status;
      if (state === 'CAPTURED') {
        winners.add('capture');
        expect(cap.ok).toBe(true);
        expect(voided).toMatchObject({
          ok: false,
          errorClass: 'RECONCILE',
          authorizationStatus: 'CAPTURED',
          alert: true,
        });
        expect(isReleased(voided)).toBe(false);
      } else {
        winners.add('void');
        expect(state).toBe('VOIDED');
        expect(voided.ok).toBe(true);
        expect(cap).toMatchObject({
          ok: false,
          errorClass: 'TERMINAL',
          code: 'AUTHORIZATION_VOIDED',
          alert: true,
        });
        expect(fake.capturesOf(h.authorizationId)).toHaveLength(0);
      }
    }
    // With jitter, both orders should have happened at least once.
    expect(winners.size).toBe(2);
  });

  it('every void path racing with void-<bidId> → all SUCCEEDED, released once', async () => {
    const { client } = racing();
    const h = await hold(client);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => client.void(h.authorizationId, voidKey(h.bidId))),
    );
    expect(results.every((r) => r.ok && isReleased(r))).toBe(true);
  });

  it('void on an expired authorization → TERMINAL AUTHORIZATION_EXPIRED, counted as released', async () => {
    const { fake, client } = racing();
    const h = await hold(client);
    fake.expire(h.authorizationId);
    const v = await client.void(h.authorizationId, voidKey(h.bidId));
    expect(v).toMatchObject({ ok: false, errorClass: 'TERMINAL', code: 'AUTHORIZATION_EXPIRED' });
    expect(isReleased(v)).toBe(true);
    const c = await client.capture({
      authorizationId: h.authorizationId,
      requestId: captureRequestId(uid('s')),
      amountCents: 22900,
    });
    expect(c).toMatchObject({ ok: false, errorClass: 'TERMINAL', code: 'AUTHORIZATION_EXPIRED' });
  });

  it('a capture whose response is lost → TRANSIENT; the replay returns the same capture', async () => {
    const { fake, client } = racing();
    const h = await hold(client);
    const quick = fake.client({ timeoutMs: 50 });
    const requestId = captureRequestId(uid('s'));
    fake.failNext('capture', { kind: 'drop_response' });
    const lost = await quick.capture({
      authorizationId: h.authorizationId,
      requestId,
      amountCents: 22900,
    });
    expect(lost).toMatchObject({ ok: false, errorClass: 'TRANSIENT', http: 0 });
    const again = await quick.capture({
      authorizationId: h.authorizationId,
      requestId,
      amountCents: 22900,
    });
    expect(again).toMatchObject({ ok: true, reconciled: false });
    expect(fake.capturesOf(h.authorizationId)).toHaveLength(1);
  });

  it('decline on capture (403, empty body) → TERMINAL after a GET shows CREATED', async () => {
    const { fake, client } = racing();
    const h = await hold(client);
    fake.failNext('capture', { kind: 'decline' });
    const r = await client.capture({
      authorizationId: h.authorizationId,
      requestId: captureRequestId(uid('s')),
      amountCents: 22900,
    });
    expect(r).toMatchObject({
      ok: false,
      errorClass: 'TERMINAL',
      http: 403,
      authorizationStatus: 'CREATED',
    });
    expect(fake.calls.some((c) => c.op === 'get_authorization')).toBe(true);
  });

  it('a failed RECONCILE GET is TRANSIENT, never a release', async () => {
    const { fake, client } = racing();
    const h = await hold(client);
    await client.void(h.authorizationId, voidKey(h.bidId));
    fake.failNext('get_authorization', { kind: 'status', http: 503 });
    const r = await client.void(h.authorizationId, voidKey(`${h.bidId}-x`));
    expect(r).toMatchObject({ ok: false, errorClass: 'TRANSIENT' });
    expect(isReleased(r)).toBe(false);
  });
});

describe('create / authorize timeouts (M6)', () => {
  it('create answered after a lost response → retried in-call with the same id → held, one order', async () => {
    const fake = new FakePayPal();
    const client = fake.client({ timeoutMs: 50 });
    const first = await hold(client, { vault: true });
    const bidId = uid('bid');
    fake.failNext('order_create', { kind: 'drop_response' });
    const r = await client.createAuthOrder({
      requestId: orderRequestId(bidId),
      amountCents: 19900,
      paymentSource: { kind: 'card_vault', vaultId: first.vault!.id!, initiator: 'MERCHANT' },
    });
    expect(r.kind).toBe('held');
    const creates = fake.calls.filter((c) => c.op === 'order_create' && c.requestId === bidId);
    expect(creates).toHaveLength(2);
    expect(fake.authorizations().filter((a) => a.amountCents === 19900)).toHaveLength(1);
  });

  it('raw card: a lost create response replays as TRANSACTION_REFUSED → unknown (needs_reconcile)', async () => {
    const fake = new FakePayPal();
    const client = fake.client({ timeoutMs: 50 });
    fake.failNext('order_create', { kind: 'drop_response' });
    const r = await client.createAuthOrder({
      requestId: orderRequestId(uid('bid')),
      amountCents: 22900,
      paymentSource: { kind: 'test_card', card: CARD },
    });
    expect(r).toEqual({
      kind: 'unknown',
      orderId: null,
      code: 'TRANSACTION_REFUSED',
      errorClass: 'RECONCILE',
    });
  });

  it('still no answer after 3 retries → unknown (TRANSIENT), 4 calls with one id', async () => {
    const fake = new FakePayPal();
    const client = fake.client({ timeoutMs: 20 });
    const bidId = uid('bid');
    fake.failNext('order_create', { kind: 'timeout' }, 4);
    const r = await client.createAuthOrder({
      requestId: orderRequestId(bidId),
      amountCents: 22900,
      paymentSource: { kind: 'test_card', card: CARD },
    });
    expect(r).toMatchObject({ kind: 'unknown', errorClass: 'TRANSIENT', code: 'TIMEOUT' });
    expect(fake.calls.filter((c) => c.op === 'order_create').map((c) => c.requestId)).toEqual([
      bidId,
      bidId,
      bidId,
      bidId,
    ]);
  });

  it('a 5xx on create is retried with the same id', async () => {
    const fake = new FakePayPal();
    const client = fake.client();
    fake.failNext('order_create', { kind: 'status', http: 503 }, 2);
    expect((await hold(client)).kind).toBe('held');
  });

  it('decline at create → denied (TERMINAL)', async () => {
    const fake = new FakePayPal();
    const client = fake.client();
    fake.failNext('order_create', { kind: 'decline' });
    const r = await client.createAuthOrder({
      requestId: orderRequestId(uid('bid')),
      amountCents: 22900,
      paymentSource: { kind: 'test_card', card: CARD },
    });
    expect(r).toMatchObject({
      kind: 'denied',
      code: 'INSTRUMENT_DECLINED',
      errorClass: 'TERMINAL',
    });
  });

  it('authorize: same-id replay → same authorization; new id → ORDER_ALREADY_AUTHORIZED → GET order (M2)', async () => {
    const { fake, client } = racing();
    const bidId = uid('bid');
    const order = await client.createAuthOrder({
      requestId: orderRequestId(bidId),
      amountCents: 22900,
      paymentSource: {
        kind: 'card_fields',
        returnUrl: 'https://h.example/r',
        cancelUrl: 'https://h.example/c',
      },
    });
    expect(order).toMatchObject({ kind: 'needs_approval', status: 'CREATED' });
    if (order.kind !== 'needs_approval') return;
    expect(await client.authorizeOrder(order.orderId, authorizeRequestId(bidId))).toMatchObject({
      kind: 'needs_approval',
    });
    fake.approve(order.orderId);
    // A double return / refresh: two concurrent authorizes with the same id.
    const [a, b] = await Promise.all([
      client.authorizeOrder(order.orderId, authorizeRequestId(bidId)),
      client.authorizeOrder(order.orderId, authorizeRequestId(bidId)),
    ]);
    expect(a.kind).toBe('held');
    expect(b).toEqual(a);
    const c = await client.authorizeOrder(order.orderId, authorizeRequestId(`${bidId}-2`));
    expect(c).toEqual(a);
    expect(a.kind === 'held' && a.vault?.status).toBe('VAULTED');
    expect(fake.authorizations().filter((x) => x.orderId === order.orderId)).toHaveLength(1);
  });

  it('wallet: approve → authorize → held with a vault; MIT from the wallet vault is held', async () => {
    const { fake, client } = racing();
    const bidId = uid('bid');
    const order = await client.createAuthOrder({
      requestId: orderRequestId(bidId),
      amountCents: 22900,
      paymentSource: {
        kind: 'wallet',
        returnUrl: 'https://h.example/r',
        cancelUrl: 'https://h.example/c',
      },
    });
    if (order.kind !== 'needs_approval') throw new Error('expected needs_approval');
    expect(order.approveUrl).toContain(order.orderId);
    fake.approve(order.orderId);
    const held = await client.authorizeOrder(order.orderId, authorizeRequestId(bidId));
    if (held.kind !== 'held') throw new Error('expected held');
    const mit = await client.createAuthOrder({
      requestId: orderRequestId(uid('bid')),
      amountCents: 23900,
      paymentSource: { kind: 'wallet_vault', vaultId: held.vault!.id! },
    });
    expect(mit.kind).toBe('held');
  });
});

describe('payouts (FakePayPal)', () => {
  it('INSUFFICIENT_FUNDS → TRANSIENT, retry under a new attempt id, alert (S7)', async () => {
    const fake = new FakePayPal({ payoutBalanceCents: 100_000 });
    const client = fake.client();
    const r = await client.payout({
      attemptId: payoutRequestId(uid('a')),
      email: 'brand@example.com',
      amountCents: 5_000_000,
      note: 'n',
    });
    expect(r).toEqual({
      ok: false,
      errorClass: 'TRANSIENT',
      code: 'INSUFFICIENT_FUNDS',
      http: 422,
      retryWithNewAttempt: true,
      alert: true,
    });
  });

  it('a replayed attempt id returns the same batch; the item settles to SUCCESS', async () => {
    const fake = new FakePayPal();
    const client = fake.client();
    const attemptId = payoutRequestId(uid('a'));
    const input = { attemptId, email: 'brand@example.com', amountCents: 100_000, note: 'n' };
    const [a, b] = await Promise.all([client.payout(input), client.payout(input)]);
    expect(a.ok && b.ok && a.batchId === b.batchId).toBe(true);
    if (!a.ok) return;
    const pending = await client.getPayoutBatch(a.batchId);
    expect(pending).toMatchObject({
      batchStatus: 'PENDING',
      senderBatchId: attemptId,
      amountCents: 100_000,
    });
    const done = await client.getPayoutBatch(a.batchId);
    expect(done.batchStatus).toBe('SUCCESS');
    expect(await client.getPayoutItem(done.items[0]!.itemId)).toMatchObject({
      outcome: 'SUCCESS',
      feeCents: 25,
    });
  });

  it('paying the merchant itself → item FAILED SELF_PAY_NOT_ALLOWED (S7)', async () => {
    const fake = new FakePayPal({ merchantEmail: 'merchant@example.com' });
    const client = fake.client();
    const r = await client.payout({
      attemptId: payoutRequestId(uid('a')),
      email: 'merchant@example.com',
      amountCents: 1_000,
      note: 'n',
    });
    if (!r.ok) throw new Error('expected a batch');
    const batch = await client.getPayoutBatch(r.batchId);
    expect(batch.batchStatus).toBe('DENIED');
    expect(batch.items[0]).toMatchObject({ outcome: 'FAILED', errorName: 'SELF_PAY_NOT_ALLOWED' });
  });
});

describe('verifyWebhook', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
    'paypal-transmission-id': 't1',
    'paypal-transmission-sig': FAKE_VALID_WEBHOOK_SIGNATURE,
    'paypal-transmission-time': '2026-11-11T00:00:00Z',
  };
  const body = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' });

  it('accepts a valid signature and rejects bad or missing ones', async () => {
    const client = new FakePayPal().client();
    expect(await client.verifyWebhook(headers, body)).toBe(true);
    expect(
      await client.verifyWebhook({ ...headers, 'paypal-transmission-sig': 'forged' }, body),
    ).toBe(false);
    expect(await client.verifyWebhook({ ...headers, 'paypal-cert-url': undefined }, body)).toBe(
      false,
    );
    expect(await client.verifyWebhook(headers, '{not json')).toBe(false);
  });

  it('is injectable', async () => {
    const client = new FakePayPal().client({ verifyWebhook: async () => true });
    expect(await client.verifyWebhook({}, '')).toBe(true);
  });

  it('needs PAYPAL_WEBHOOK_ID', async () => {
    const client = new FakePayPal().client({ webhookId: undefined });
    await expect(client.verifyWebhook(headers, body)).rejects.toThrow(/PAYPAL_WEBHOOK_ID/);
  });
});
