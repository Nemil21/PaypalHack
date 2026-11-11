import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { isReleased } from '../money/void.js';
import { voidKey } from '../money/void.js';
import { captureRequestId, orderRequestId, payoutRequestId } from './ids.js';
import type { PayPalClient, TestCard } from './types.js';

/**
 * The PayPal contract suite (HF-004): the same assertions against `FakePayPal` (CI) and the
 * sandbox (manual / nightly, `PAYPAL_CONTRACT=sandbox`). Each case cleans up its own holds.
 */
export interface ContractEnv {
  client: PayPalClient;
  /** Make the next call to `op` answer 503 (injected at the transport, before PayPal sees it). */
  fail503(op: 'capture' | 'void'): void;
  /** Mock declines reach PayPal (sandbox + ALLOW_MOCK_DECLINE, or the fake). */
  mockResponses: boolean;
  /** Brand email for the payout case, or undefined to skip it. */
  payoutEmail?: string;
  /** Per-case timeout. */
  timeoutMs: number;
}

// PayPal's published sandbox test cards (S7 step 6); not real cards.
export const CONTRACT_CARDS: TestCard[] = [
  { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Contract Visa' },
  { number: '4012888888881881', expiry: '2030-11', security_code: '123', name: 'Contract Visa B' },
  {
    number: '5555555555554444',
    expiry: '2030-10',
    security_code: '123',
    name: 'Contract Mastercard',
  },
];

/**
 * A `fetch` wrapper that answers 503 for the next matching call without sending it. Lets the
 * sandbox run the TRANSIENT case without needing PayPal to fail.
 */
export function faultyFetch(inner: typeof fetch): {
  fetch: typeof fetch;
  fail503(op: 'capture' | 'void'): void;
} {
  const pending: string[] = [];
  return {
    fetch: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const i = pending.findIndex((op) => url.endsWith(`/${op}`));
      if (i >= 0) {
        pending.splice(i, 1);
        return new Response(JSON.stringify({ name: 'SERVICE_UNAVAILABLE' }), { status: 503 });
      }
      return inner(input, init);
    },
    fail503: (op) => {
      pending.push(op);
    },
  };
}

export function paypalContract(name: string, setup: () => ContractEnv): void {
  describe(`PayPal contract: ${name}`, () => {
    const env = setup();
    const { client } = env;
    const opts = { timeout: env.timeoutMs };
    const open: { authorizationId: string; bidId: string }[] = [];
    let card = 0;

    async function hold(amountCents = 22900, vault = false) {
      const bidId = randomUUID();
      const res = await client.createAuthOrder({
        requestId: orderRequestId(bidId),
        amountCents,
        paymentSource: {
          kind: 'test_card',
          card: CONTRACT_CARDS[card++ % CONTRACT_CARDS.length]!,
          vault,
        },
        description: 'Holdfast HF-004 contract test',
      });
      expect(res.kind, JSON.stringify(res)).toBe('held');
      if (res.kind !== 'held') throw new Error('no hold');
      open.push({ authorizationId: res.authorizationId, bidId });
      return { ...res, bidId };
    }

    afterAll(async () => {
      // Nothing left CREATED (S7 final check).
      for (const h of open) {
        const auth = await client.getAuthorization(h.authorizationId);
        if (auth.status === 'CREATED') await client.void(h.authorizationId, voidKey(h.bidId));
      }
    }, 120_000);

    it('card hold → capture own amount → COMPLETED; hold → void (S1)', opts, async () => {
      const a = await hold(22900);
      expect(a.authorizedAt).toMatch(/^\d{4}-/);
      const cap = await client.capture({
        authorizationId: a.authorizationId,
        requestId: captureRequestId(randomUUID()),
        amountCents: 22900,
      });
      expect(cap).toMatchObject({
        ok: true,
        status: 'COMPLETED',
        amountCents: 22900,
        reconciled: false,
      });
      expect((await client.getAuthorization(a.authorizationId)).status).toBe('CAPTURED');

      const b = await hold(21900);
      const v = await client.void(b.authorizationId, voidKey(b.bidId));
      expect(v).toEqual({ ok: true, status: 'VOIDED', reconciled: false });
      expect((await client.getAuthorization(b.authorizationId)).status).toBe('VOIDED');
    });

    it('vaulted MIT and CIT holds from vault_id are held (S2, S7 step 4)', opts, async () => {
      const first = await hold(22900, true);
      expect(first.vault).toMatchObject({ status: 'VAULTED', id: expect.any(String) });
      const vaultId = first.vault!.id!;
      for (const initiator of ['MERCHANT', 'CUSTOMER'] as const) {
        const bidId = randomUUID();
        const r = await client.createAuthOrder({
          requestId: orderRequestId(bidId),
          amountCents: 19900,
          paymentSource: { kind: 'card_vault', vaultId, initiator },
        });
        expect(r.kind, `${initiator} ${JSON.stringify(r)}`).toBe('held');
        if (r.kind === 'held') open.push({ authorizationId: r.authorizationId, bidId });
        if (initiator === 'MERCHANT' && r.kind === 'held') {
          // Same request id on a vault_id create replays the same order (S7).
          const again = await client.createAuthOrder({
            requestId: orderRequestId(bidId),
            amountCents: 19900,
            paymentSource: { kind: 'card_vault', vaultId, initiator },
          });
          expect(again).toMatchObject({
            kind: 'held',
            orderId: r.orderId,
            authorizationId: r.authorizationId,
          });
        }
      }
    });

    it('same request id on capture twice → same capture id (S3)', opts, async () => {
      const a = await hold();
      const requestId = captureRequestId(randomUUID());
      const one = await client.capture({
        authorizationId: a.authorizationId,
        requestId,
        amountCents: 22900,
      });
      const two = await client.capture({
        authorizationId: a.authorizationId,
        requestId,
        amountCents: 22900,
      });
      expect(one.ok && two.ok).toBe(true);
      if (one.ok && two.ok) {
        expect(two.captureId).toBe(one.captureId);
        expect(two.reconciled).toBe(false);
      }
    });

    it(
      'capture 422 "already captured" → RECONCILE → SUCCEEDED with the original capture id (B4)',
      opts,
      async () => {
        const a = await hold();
        const one = await client.capture({
          authorizationId: a.authorizationId,
          requestId: captureRequestId(randomUUID()),
          amountCents: 22900,
        });
        const two = await client.capture({
          authorizationId: a.authorizationId,
          requestId: captureRequestId(randomUUID()),
          amountCents: 22900,
        });
        expect(one.ok).toBe(true);
        expect(two).toMatchObject({ ok: true, reconciled: true });
        if (one.ok && two.ok) expect(two.captureId).toBe(one.captureId);
      },
    );

    it(
      'void twice with void-<bidId> → both SUCCEEDED; a different id → RECONCILE → SUCCEEDED',
      opts,
      async () => {
        const a = await hold();
        const key = voidKey(a.bidId);
        expect(await client.void(a.authorizationId, key)).toMatchObject({ ok: true });
        const replay = await client.void(a.authorizationId, key);
        expect(replay).toMatchObject({ ok: true, status: 'VOIDED' });
        const other = await client.void(a.authorizationId, voidKey(`${a.bidId}-retry`));
        expect(other).toEqual({ ok: true, status: 'VOIDED', reconciled: true });
        expect(isReleased(other)).toBe(true);
      },
    );

    it(
      'capture after void → TERMINAL + alert; void after capture → RECONCILE + alert',
      opts,
      async () => {
        const a = await hold();
        await client.void(a.authorizationId, voidKey(a.bidId));
        const cap = await client.capture({
          authorizationId: a.authorizationId,
          requestId: captureRequestId(randomUUID()),
          amountCents: 22900,
        });
        expect(cap).toMatchObject({
          ok: false,
          errorClass: 'TERMINAL',
          code: 'AUTHORIZATION_VOIDED',
          authorizationStatus: 'VOIDED',
          alert: true,
        });

        const b = await hold();
        await client.capture({
          authorizationId: b.authorizationId,
          requestId: captureRequestId(randomUUID()),
          amountCents: 22900,
        });
        const v = await client.void(b.authorizationId, voidKey(b.bidId));
        expect(v).toMatchObject({
          ok: false,
          errorClass: 'RECONCILE',
          authorizationStatus: 'CAPTURED',
          alert: true,
        });
        expect(isReleased(v)).toBe(false);
      },
    );

    it.runIf(env.mockResponses)(
      'mock decline and mock expiry on capture are TERMINAL; the hold stays CREATED (S7 step 5)',
      opts,
      async () => {
        const a = await hold();
        const declined = await client.capture({
          authorizationId: a.authorizationId,
          requestId: captureRequestId(randomUUID()),
          amountCents: 22900,
          mockResponse: 'INSTRUMENT_DECLINED',
        });
        expect(declined).toMatchObject({
          ok: false,
          errorClass: 'TERMINAL',
          authorizationStatus: 'CREATED',
        });

        const expired = await client.capture({
          authorizationId: a.authorizationId,
          requestId: captureRequestId(randomUUID()),
          amountCents: 22900,
          mockResponse: 'AUTHORIZATION_EXPIRED',
        });
        expect(expired).toMatchObject({
          ok: false,
          errorClass: 'TERMINAL',
          code: 'AUTHORIZATION_EXPIRED',
          authorizationStatus: 'CREATED',
        });
        // The caller voids it.
        expect(await client.void(a.authorizationId, voidKey(a.bidId))).toMatchObject({ ok: true });
      },
    );

    it('a 503 is TRANSIENT; the retry with the same id succeeds', opts, async () => {
      const a = await hold();
      const requestId = captureRequestId(randomUUID());
      env.fail503('capture');
      const first = await client.capture({
        authorizationId: a.authorizationId,
        requestId,
        amountCents: 22900,
      });
      expect(first).toMatchObject({ ok: false, errorClass: 'TRANSIENT', http: 503 });
      const retry = await client.capture({
        authorizationId: a.authorizationId,
        requestId,
        amountCents: 22900,
      });
      expect(retry).toMatchObject({ ok: true, status: 'COMPLETED' });

      const b = await hold();
      env.fail503('void');
      expect(await client.void(b.authorizationId, voidKey(b.bidId))).toMatchObject({
        ok: false,
        errorClass: 'TRANSIENT',
      });
      expect(await client.void(b.authorizationId, voidKey(b.bidId))).toMatchObject({ ok: true });
    });

    it(
      'raw-card create replay is refused → unknown (RECONCILE), never a decline (S7)',
      opts,
      async () => {
        const a = await hold();
        const again = await client.createAuthOrder({
          requestId: orderRequestId(a.bidId),
          amountCents: 22900,
          paymentSource: { kind: 'test_card', card: CONTRACT_CARDS[0]! },
        });
        expect(again).toMatchObject({ kind: 'unknown', errorClass: 'RECONCILE' });
      },
    );

    it('wallet order → needs_approval with the payer-action link', opts, async () => {
      const r = await client.createAuthOrder({
        requestId: orderRequestId(randomUUID()),
        amountCents: 22900,
        paymentSource: {
          kind: 'wallet',
          returnUrl: 'https://example.com/return',
          cancelUrl: 'https://example.com/cancel',
          brandName: 'Holdfast',
        },
      });
      expect(r).toMatchObject({
        kind: 'needs_approval',
        status: 'PAYER_ACTION_REQUIRED',
        approveUrl: expect.stringMatching(/^https:\/\//),
      });
    });

    it('getOrder and getAuthorization read the hold back', opts, async () => {
      const a = await hold(20900);
      const auth = await client.getAuthorization(a.authorizationId);
      expect(auth).toMatchObject({
        id: a.authorizationId,
        status: 'CREATED',
        amountCents: 20900,
        orderId: a.orderId,
      });
      const order = await client.getOrder(a.orderId);
      expect(order.authorizations[0]?.id).toBe(a.authorizationId);
    });

    it.runIf(!!env.payoutEmail)(
      'payout with sender_batch_id = attempt id, then GET batch and item',
      opts,
      async () => {
        const attemptId = randomUUID();
        const res = await client.payout({
          attemptId: payoutRequestId(attemptId),
          email: env.payoutEmail!,
          amountCents: 100,
          note: 'Holdfast HF-004 contract payout',
        });
        expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
        if (!res.ok) return;
        const batch = await client.getPayoutBatch(res.batchId);
        expect(batch.batchId).toBe(res.batchId);
        expect(batch.senderBatchId).toBe(attemptId);
        expect(batch.items[0]?.itemId).toBeTruthy();
        const item = await client.getPayoutItem(batch.items[0]!.itemId);
        expect(['SUCCESS', 'PENDING']).toContain(item.outcome);
      },
    );
  });
}
