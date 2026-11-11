import { paypalAmount } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { PayPalVoidPort } from '../money/deps.js';
import { voidKey } from '../money/void.js';
import { PayPalRestClient, redact, type PayPalLogEntry } from './client.js';
import { FAKE_CLIENT_SECRET, FakePayPal } from './fake.js';
import { authorizeRequestId, captureRequestId, orderRequestId, payoutRequestId } from './ids.js';
import { createPayPalClient } from './index.js';
import { captureInputFor, judgeHold } from './orders.js';
import { payoutAmount } from './payouts.js';
import type { PayPalClient, TestCard } from './types.js';

const CARD: TestCard = {
  number: '4111111111111111',
  expiry: '2030-12',
  security_code: '123',
  name: 'Unit Buyer',
};
let n = 0;
const uid = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

async function cardHold(client: PayPalClient, amountCents = 22900, vault = false) {
  const bidId = uid('bid');
  const r = await client.createAuthOrder({
    requestId: orderRequestId(bidId),
    amountCents,
    paymentSource: { kind: 'test_card', card: CARD, vault },
  });
  if (r.kind !== 'held') throw new Error(`expected held, got ${JSON.stringify(r)}`);
  return { ...r, bidId };
}

describe('amount conversion', () => {
  it('formats order and payout amounts from integer cents', () => {
    expect(paypalAmount(22900)).toEqual({ currency_code: 'USD', value: '229.00' });
    expect(paypalAmount(5)).toEqual({ currency_code: 'USD', value: '0.05' });
    expect(payoutAmount(5_000_000)).toEqual({ value: '50000.00', currency: 'USD' });
    expect(payoutAmount(100_025)).toEqual({ value: '1000.25', currency: 'USD' });
  });

  it('reads authorization amounts back into cents and rejects bad amounts', async () => {
    const fake = new FakePayPal();
    const client = fake.client();
    const held = await cardHold(client, 21950);
    expect(held.amountCents).toBe(21950);
    await expect(
      client.createAuthOrder({
        requestId: orderRequestId(uid('bid')),
        amountCents: 229.5,
        paymentSource: { kind: 'test_card', card: CARD },
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.capture({
        authorizationId: held.authorizationId,
        requestId: captureRequestId(uid('s')),
        amountCents: 0,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('judges a hold by the body status, not the HTTP code', () => {
    const order = (status: string) => ({
      id: 'O1',
      status: 'COMPLETED',
      purchase_units: [
        {
          payments: {
            authorizations: [
              {
                id: 'A1',
                status,
                amount: { value: '229.00' },
                create_time: '2026-11-11T00:00:00Z',
              },
            ],
          },
        },
      ],
    });
    expect(judgeHold(order('CREATED')).kind).toBe('held');
    expect(judgeHold(order('PENDING')).kind).toBe('pending');
    expect(judgeHold(order('DENIED'))).toMatchObject({
      kind: 'denied',
      code: 'AUTHORIZATION_DENIED',
    });
    expect(
      judgeHold({
        id: 'O2',
        status: 'PAYER_ACTION_REQUIRED',
        links: [{ rel: 'payer-action', href: 'https://x/approve' }],
      }),
    ).toEqual({
      kind: 'needs_approval',
      orderId: 'O2',
      approveUrl: 'https://x/approve',
      status: 'PAYER_ACTION_REQUIRED',
    });
    expect(
      judgeHold({ id: 'O3', status: 'CREATED', links: [{ rel: 'approve', href: 'https://x/a' }] }),
    ).toMatchObject({ kind: 'needs_approval', approveUrl: 'https://x/a' });
  });
});

describe('token cache and 401 refresh', () => {
  it('caches the token until expires_in − 60 s', async () => {
    const fake = new FakePayPal({ tokenTtlSeconds: 120 });
    let now = 1_000_000;
    const client = fake.client({ now: () => now });
    await client.getOrder((await cardHold(client)).orderId);
    expect(fake.tokensIssued).toBe(1);
    now += 59_000;
    await cardHold(client);
    expect(fake.tokensIssued).toBe(1);
    now += 2_000; // 61 s after issue: inside the 60 s skew → refresh
    await cardHold(client);
    expect(fake.tokensIssued).toBe(2);
  });

  it('shares one token fetch between concurrent first calls', async () => {
    const fake = new FakePayPal({ latencyMs: 5 });
    const client = fake.client();
    await Promise.all(Array.from({ length: 8 }, () => cardHold(client)));
    expect(fake.tokensIssued).toBe(1);
  });

  it('refreshes once on a mid-call 401 and retries with the same request id', async () => {
    const fake = new FakePayPal();
    const client = fake.client();
    const held = await cardHold(client);
    fake.revokeTokens();
    const requestId = captureRequestId(uid('settlement'));
    const res = await client.capture({
      authorizationId: held.authorizationId,
      requestId,
      amountCents: 22900,
    });
    expect(res).toMatchObject({ ok: true, status: 'COMPLETED', reconciled: false });
    const captures = fake.calls.filter((c) => c.op === 'capture');
    expect(captures.map((c) => [c.http, c.requestId])).toEqual([
      [401, requestId],
      [201, requestId],
    ]);
    expect(fake.tokensIssued).toBe(2);
  });

  it('gives up after one refresh when PayPal keeps answering 401', async () => {
    const fake = new FakePayPal();
    let posts = 0;
    const always401: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/v1/oauth2/token')) return fake.fetch(input, init);
      posts++;
      return new Response(JSON.stringify({ name: 'AUTHENTICATION_FAILURE' }), { status: 401 });
    };
    const client = fake.client({ fetch: always401 });
    const res = await client.void('AUTH1', voidKey('bid-x'));
    expect(res).toMatchObject({
      ok: false,
      errorClass: 'TERMINAL',
      code: 'AUTHENTICATION_FAILURE',
    });
    expect(posts).toBe(2);
  });
});

describe('PayPal-Request-Id on every mutating call (D5, INV-4)', () => {
  it('sends the fixed id per call type, with Prefer: return=representation', async () => {
    const fake = new FakePayPal();
    const client = fake.client();
    const bidId = uid('bid');
    const wallet = await client.createAuthOrder({
      requestId: orderRequestId(bidId),
      amountCents: 22900,
      paymentSource: {
        kind: 'wallet',
        returnUrl: 'https://h.example/r',
        cancelUrl: 'https://h.example/c',
      },
    });
    expect(wallet.kind).toBe('needs_approval');
    if (wallet.kind !== 'needs_approval') return;
    fake.approve(wallet.orderId);
    const held = await client.authorizeOrder(wallet.orderId, authorizeRequestId(bidId));
    expect(held.kind).toBe('held');
    if (held.kind !== 'held') return;
    const settlementId = uid('settlement');
    await client.capture({
      authorizationId: held.authorizationId,
      requestId: captureRequestId(settlementId),
      amountCents: 22900,
    });
    const other = await cardHold(client);
    await client.void(other.authorizationId, voidKey(other.bidId));
    const attemptId = uid('attempt');
    await client.payout({
      attemptId: payoutRequestId(attemptId),
      email: 'brand@example.com',
      amountCents: 100_000,
      note: 'n',
    });

    const posts = fake.calls.filter((c) => c.method === 'POST' && c.op !== 'token');
    for (const c of posts) {
      expect(c.requestId, `${c.op} ${c.path}`).toBeTruthy();
      expect(c.prefer).toBe('return=representation');
    }
    const ids = posts.map((c) => [c.op, c.requestId]);
    expect(ids).toContainEqual(['order_create', bidId]);
    expect(ids).toContainEqual(['authorize', `authz-${bidId}`]);
    expect(ids).toContainEqual(['capture', settlementId]);
    expect(ids).toContainEqual(['void', `void-${other.bidId}`]);
    expect(ids).toContainEqual(['payout', attemptId]);
  });

  it('refuses plain strings and missing ids at compile time', () => {
    const client = new FakePayPal().client();
    // These lines exist for `tsc`: each must be a type error. They are never called.
    const typeChecks = () => {
      void client.createAuthOrder({
        // @ts-expect-error a plain string is not an OrderRequestId
        requestId: 'bid-1',
        amountCents: 1,
        paymentSource: { kind: 'wallet_vault', vaultId: 'v' },
      });
      // @ts-expect-error requestId is required
      void client.createAuthOrder({
        amountCents: 1,
        paymentSource: { kind: 'wallet_vault', vaultId: 'v' },
      });
      // @ts-expect-error authorize needs authz-<bidId>
      void client.authorizeOrder('O1', 'authz-1');
      // @ts-expect-error authorize needs a request id
      void client.authorizeOrder('O1');
      // @ts-expect-error capture needs the settlement id
      void client.capture({ authorizationId: 'A', amountCents: 1 });
      // @ts-expect-error a capture id is not a void id
      void client.void('A', captureRequestId('s1'));
      // @ts-expect-error void needs void-<bidId>
      void client.void('A');
      // @ts-expect-error payout needs the attempt id
      void client.payout({ attemptId: 'a1', email: 'e', amountCents: 1, note: 'n' });
    };
    expect(typeof typeChecks).toBe('function');
  });

  it('satisfies the money primitives void port (HF-003a)', () => {
    const port: PayPalVoidPort = new FakePayPal().client();
    expect(typeof port.void).toBe('function');
  });
});

describe('secrets and logs', () => {
  it('never logs tokens, the client secret or bodies', async () => {
    const fake = new FakePayPal();
    const entries: PayPalLogEntry[] = [];
    const client = fake.client({ logger: (e) => entries.push(e) });
    const held = await cardHold(client);
    await client.capture({
      authorizationId: held.authorizationId,
      requestId: captureRequestId(uid('s')),
      amountCents: 22900,
    });
    const text = JSON.stringify(entries);
    expect(entries.length).toBeGreaterThan(2);
    expect(text).not.toContain('fake-token-');
    expect(text).not.toContain(FAKE_CLIENT_SECRET);
    expect(text).not.toContain(
      Buffer.from(`fake-client-id:${FAKE_CLIENT_SECRET}`).toString('base64'),
    );
    expect(text).not.toContain('4111111111111111');
    expect(entries.find((e) => e.call === 'capture')).toMatchObject({
      http: 201,
      requestId: expect.any(String),
    });
  });

  it('redacts credentials in error text', () => {
    expect(redact('Authorization: Bearer A21AAabc.def-ghi')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redact('Basic Zm9vOmJhcg==')).toBe('Basic [redacted]');
    expect(redact('{"access_token":"A21AAxyz","x":1}')).toBe('{"access_token":"[redacted]","x":1}');
    expect(redact('client_secret=shh&grant_type=x')).toBe('client_secret=[redacted]&grant_type=x');
  });

  it('keeps the client secret off the client object', () => {
    const client = new PayPalRestClient({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      clientId: 'id',
      clientSecret: 'super-secret-value',
    });
    expect(JSON.stringify(client)).not.toContain('super-secret-value');
    expect(JSON.stringify(client.http)).not.toContain('super-secret-value');
  });
});

describe('mock responses and raw cards are gated', () => {
  it('sends PayPal-Mock-Response only when allowed', async () => {
    const fake = new FakePayPal();
    const off = fake.client({ allowMockResponse: false });
    const held = await cardHold(off);
    const res = await off.capture({
      authorizationId: held.authorizationId,
      requestId: captureRequestId(uid('s')),
      amountCents: 22900,
      mockResponse: 'INSTRUMENT_DECLINED',
    });
    expect(res.ok).toBe(true);
    expect(fake.calls.filter((c) => c.op === 'capture').every((c) => c.mockResponse === null)).toBe(
      true,
    );
  });

  it('refuses raw card sources unless allowed', async () => {
    const client = new FakePayPal().client({ allowRawCard: false });
    await expect(cardHold(client)).rejects.toThrow(/raw card/);
  });

  it('createPayPalClient: stub mode uses FakePayPal; mock declines need DEMO_MODE + ALLOW_MOCK_DECLINE', async () => {
    const base = {
      DATABASE_URL: 'postgres://x/y',
      SESSION_SECRET: 'x'.repeat(32),
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
      PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
      PAYPAL_MODE: 'stub',
    };
    for (const [flags, sent] of [
      [{ ALLOW_MOCK_DECLINE: 'true' }, false],
      [{ ALLOW_MOCK_DECLINE: 'true', DEMO_MODE: 'true' }, true],
    ] as const) {
      const fake = new FakePayPal();
      const client = createPayPalClient(loadConfig({ ...base, ...flags }), { fake });
      const held = await cardHold(client);
      const res = await client.capture({
        authorizationId: held.authorizationId,
        requestId: captureRequestId(uid('s')),
        amountCents: 22900,
        mockResponse: 'INSTRUMENT_DECLINED',
      });
      expect(res.ok).toBe(!sent);
    }
  });
});

describe('captureInputFor (INV-5)', () => {
  const bid = {
    id: 'b1',
    amount_cents: 22900,
    authorized_amount_cents: 22900,
    paypal_authorization_id: 'A1',
  };
  const settlement = {
    id: 's1',
    bid_id: 'b1',
    action: 'CAPTURE',
    amount_cents: 22900,
    mock_response: null,
  };

  it('takes the amount from the bid row and the request id from the settlement', () => {
    expect(captureInputFor(settlement, bid)).toEqual({
      authorizationId: 'A1',
      requestId: 's1',
      amountCents: 22900,
      mockResponse: null,
    });
    expect(
      captureInputFor({ ...settlement, mock_response: 'INSTRUMENT_DECLINED' }, bid).mockResponse,
    ).toBe('INSTRUMENT_DECLINED');
  });

  it('refuses mismatched amounts, wrong bids and unknown mock codes', () => {
    expect(() => captureInputFor({ ...settlement, amount_cents: 21900 }, bid)).toThrow(/INV-5/);
    expect(() => captureInputFor(settlement, { ...bid, authorized_amount_cents: 23900 })).toThrow(
      /INV-5/,
    );
    expect(() => captureInputFor({ ...settlement, bid_id: 'b2' }, bid)).toThrow();
    expect(() => captureInputFor({ ...settlement, action: 'VOID' }, bid)).toThrow();
    expect(() => captureInputFor({ ...settlement, mock_response: 'SOMETHING' }, bid)).toThrow();
  });
});
