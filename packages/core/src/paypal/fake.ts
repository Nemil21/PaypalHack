import { centsToDecimal, decimalToCents } from '@holdfast/shared';
import { PayPalRestClient, type PayPalRestClientOptions } from './client.js';

/**
 * `FakePayPal` (M16): an in-memory PayPal REST API behind `PAYPAL_MODE=stub`, for race tests and
 * dev seeds. It answers HTTP like the sandbox did in S1–S4 and S7 (status codes, issue codes,
 * replay behaviour), and `fake.client()` is the real `PayPalRestClient` over it, so the stub and the
 * sandbox share the same client code and pass the same contract suite.
 *
 * Models the authorization state machine (CREATED → CAPTURED | VOIDED | EXPIRED; one capture,
 * one void), `PayPal-Request-Id` replay, `invoice_id` dedupe, vaulting, payouts and fault
 * injection (latency, 5xx, timeouts, 422, declines, a response lost after the work was done).
 */

export const FAKE_PAYPAL_BASE = 'https://fake.paypal.local';
export const FAKE_CLIENT_ID = 'fake-client-id';
export const FAKE_CLIENT_SECRET = 'fake-client-secret';
/** `paypal-transmission-sig` the default fake webhook verifier accepts. */
export const FAKE_VALID_WEBHOOK_SIGNATURE = 'fake-valid-signature';

export type FakeOp =
  | 'token'
  | 'order_create'
  | 'authorize'
  | 'capture'
  | 'void'
  | 'get_authorization'
  | 'get_order'
  | 'payout'
  | 'get_payout_batch'
  | 'get_payout_item'
  | 'verify_webhook';

export type FakeFault =
  /** Answer with this status and issue; no state changes. */
  | { kind: 'status'; http: number; issue?: string }
  /** Never answer (until the client's timeout aborts). No state changes. */
  | { kind: 'timeout' }
  /** Do the work, then lose the response (the client times out). The realistic M6 case. */
  | { kind: 'drop_response' }
  /** Instrument declined: capture → 403 with an empty body (S7); create / authorize → 422. */
  | { kind: 'decline' }
  /** Extra delay before this one call. */
  | { kind: 'latency'; ms: number };

export interface FakeCall {
  op: FakeOp;
  method: string;
  path: string;
  requestId: string | null;
  prefer: string | null;
  mockResponse: string | null;
  http: number;
}

interface FakeOrder {
  id: string;
  status: string;
  amountCents: number;
  invoiceId: string | null;
  customId: string | null;
  source: 'card' | 'paypal';
  rawCard: boolean;
  vaultRequested: boolean;
  vault: { id: string; status: string } | null;
  authorizationId: string | null;
}

interface FakeAuthorization {
  id: string;
  orderId: string;
  status: string;
  amountCents: number;
  createTime: string;
  expirationTime: string;
  captureId: string | null;
}

interface FakeCapture {
  id: string;
  authorizationId: string;
  amountCents: number;
  status: string;
  createTime: string;
}

interface FakePayoutBatch {
  id: string;
  senderBatchId: string;
  status: string;
  amountCents: number;
  item: { id: string; status: string; receiver: string; errorName: string | null };
  gets: number;
}

export interface FakePayPalOptions {
  /** Delay before every answer (so concurrent calls overlap). Default 0. */
  latencyMs?: number;
  /** Extra random delay in [0, jitterMs) per call, to vary race order. Default 0. */
  jitterMs?: number;
  /** Clock for create / expiry times. */
  now?: () => Date;
  /** OAuth `expires_in` in seconds. Default 32400 (PayPal's 9 h). */
  tokenTtlSeconds?: number;
  /** Payable balance for payouts; above it a payout is `422 INSUFFICIENT_FUNDS`. Default unlimited. */
  payoutBalanceCents?: number;
  /** Payouts to this email fail like S7 (`SELF_PAY_NOT_ALLOWED`). */
  merchantEmail?: string;
  /** Batch GETs before a PENDING payout settles to SUCCESS. Default 1. */
  payoutSettlesAfterGets?: number;
}

type Handled = { http: number; body?: unknown };

function err(http: number, issue: string): Handled {
  return {
    http,
    body: {
      name: http === 404 ? 'RESOURCE_NOT_FOUND' : 'UNPROCESSABLE_ENTITY',
      details: [{ issue }],
    },
  };
}

const amount = (cents: number) => ({ currency_code: 'USD', value: centsToDecimal(cents) });

export class FakePayPal {
  readonly calls: FakeCall[] = [];
  latencyMs: number;
  jitterMs: number;
  payoutBalanceCents: number;
  tokensIssued = 0;

  readonly #now: () => Date;
  readonly #tokenTtl: number;
  readonly #merchantEmail: string | undefined;
  readonly #payoutSettlesAfterGets: number;
  #seq = 0;
  readonly #validTokens = new Set<string>();
  readonly #orders = new Map<string, FakeOrder>();
  readonly #auths = new Map<string, FakeAuthorization>();
  readonly #captures = new Map<string, FakeCapture>();
  readonly #vaults = new Map<string, 'card' | 'paypal'>();
  readonly #invoiceIds = new Set<string>();
  readonly #replays = new Map<string, Handled>();
  readonly #batches = new Map<string, FakePayoutBatch>();
  readonly #items = new Map<string, string>();
  readonly #faults = new Map<FakeOp | 'any', FakeFault[]>();
  webhookVerifier: (fields: Record<string, unknown>) => boolean = (f) =>
    f.transmission_sig === FAKE_VALID_WEBHOOK_SIGNATURE;

  constructor(opts: FakePayPalOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
    this.jitterMs = opts.jitterMs ?? 0;
    this.#now = opts.now ?? (() => new Date());
    this.#tokenTtl = opts.tokenTtlSeconds ?? 32_400;
    this.payoutBalanceCents = opts.payoutBalanceCents ?? Number.MAX_SAFE_INTEGER;
    this.#merchantEmail = opts.merchantEmail?.toLowerCase();
    this.#payoutSettlesAfterGets = opts.payoutSettlesAfterGets ?? 1;
  }

  /** A `PayPalRestClient` wired to this fake (raw test cards and mock responses allowed). */
  client(opts: Partial<PayPalRestClientOptions> = {}): PayPalRestClient {
    return new PayPalRestClient({
      baseUrl: FAKE_PAYPAL_BASE,
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      fetch: this.fetch,
      allowRawCard: true,
      allowMockResponse: true,
      webhookId: 'FAKE-WEBHOOK-ID',
      sleep: async () => {},
      ...opts,
    });
  }

  // ------------------------------------------------------------------ controls

  /** Queue `fault` for the next `times` calls of `op` (or of any call). */
  failNext(op: FakeOp | 'any', fault: FakeFault, times = 1): this {
    const queue = this.#faults.get(op) ?? [];
    for (let i = 0; i < times; i++) queue.push(fault);
    this.#faults.set(op, queue);
    return this;
  }

  clearFaults(): void {
    this.#faults.clear();
  }

  /** Buyer approval (wallet return) or a successful card-fields submit. */
  approve(orderId: string): void {
    const order = this.#orders.get(orderId);
    if (!order) throw new Error(`fake: no order ${orderId}`);
    if (order.status === 'PAYER_ACTION_REQUIRED' || order.status === 'CREATED')
      order.status = 'APPROVED';
  }

  /** Let an authorization lapse (past PayPal's honor / expiry period). */
  expire(authorizationId: string): void {
    const auth = this.#auths.get(authorizationId);
    if (!auth) throw new Error(`fake: no authorization ${authorizationId}`);
    if (auth.status === 'CREATED') auth.status = 'EXPIRED';
  }

  /** Make every issued token invalid; the next call gets a 401. */
  revokeTokens(): void {
    this.#validTokens.clear();
  }

  /** Force a payout batch's final state. */
  settlePayout(
    batchId: string,
    itemStatus: 'SUCCESS' | 'FAILED' | 'UNCLAIMED',
    errorName?: string,
  ): void {
    const batch = this.#batches.get(batchId);
    if (!batch) throw new Error(`fake: no payout batch ${batchId}`);
    batch.item.status = itemStatus;
    batch.item.errorName = errorName ?? null;
    batch.status = itemStatus === 'SUCCESS' ? 'SUCCESS' : 'DENIED';
  }

  authorization(id: string): Readonly<FakeAuthorization> | undefined {
    const a = this.#auths.get(id);
    return a && { ...a };
  }

  /** Every authorization, for "nothing left CREATED" checks. */
  authorizations(): Readonly<FakeAuthorization>[] {
    return [...this.#auths.values()].map((a) => ({ ...a }));
  }

  capturesOf(authorizationId: string): Readonly<FakeCapture>[] {
    return [...this.#captures.values()].filter((c) => c.authorizationId === authorizationId);
  }

  // ------------------------------------------------------------------ HTTP

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? undefined;
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const route = this.#route(method, url.pathname);
    const call: FakeCall = {
      op: route?.op ?? 'get_order',
      method,
      path: url.pathname,
      requestId: headers.get('paypal-request-id'),
      prefer: headers.get('prefer'),
      mockResponse: headers.get('paypal-mock-response'),
      http: 0,
    };

    await this.#delay(this.latencyMs + Math.floor(Math.random() * this.jitterMs), signal);
    const fault = route ? this.#takeFault(route.op) : undefined;
    if (fault?.kind === 'latency') await this.#delay(fault.ms, signal);

    let result: Handled;
    if (!route) {
      result = err(404, 'RESOURCE_NOT_FOUND');
    } else if (route.op === 'token') {
      result = this.#token(headers.get('authorization'));
    } else if (!this.#authorized(headers.get('authorization'))) {
      result = {
        http: 401,
        body: { name: 'AUTHENTICATION_FAILURE', details: [{ issue: 'INVALID_TOKEN' }] },
      };
    } else if (fault?.kind === 'timeout') {
      this.calls.push(call);
      return this.#hang(signal);
    } else if (fault?.kind === 'status') {
      result = err(
        fault.http,
        fault.issue ?? (fault.http >= 500 ? 'INTERNAL_SERVER_ERROR' : 'UNPROCESSABLE_ENTITY'),
      );
    } else if (fault?.kind === 'decline' && route.op === 'capture') {
      result = { http: 403 };
    } else if (fault?.kind === 'decline') {
      result = err(422, 'INSTRUMENT_DECLINED');
    } else {
      let body: Record<string, unknown> = {};
      try {
        body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      result = this.#handle(route.op, route.id, body, call);
    }

    call.http = result.http;
    this.calls.push(call);
    if (fault?.kind === 'drop_response') return this.#hang(signal);
    if (result.body === undefined || result.http === 204)
      return new Response(null, { status: result.http });
    return new Response(JSON.stringify(result.body), {
      status: result.http,
      headers: { 'content-type': 'application/json', 'paypal-debug-id': `fake${++this.#seq}` },
    });
  };

  #route(method: string, path: string): { op: FakeOp; id: string } | null {
    const m = (re: RegExp) => re.exec(path)?.[1];
    let id: string | undefined;
    if (method === 'POST' && path === '/v1/oauth2/token') return { op: 'token', id: '' };
    if (method === 'POST' && path === '/v2/checkout/orders') return { op: 'order_create', id: '' };
    if (method === 'POST' && (id = m(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/)))
      return { op: 'authorize', id };
    if (method === 'GET' && (id = m(/^\/v2\/checkout\/orders\/([^/]+)$/)))
      return { op: 'get_order', id };
    if (method === 'POST' && (id = m(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/)))
      return { op: 'capture', id };
    if (method === 'POST' && (id = m(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/)))
      return { op: 'void', id };
    if (method === 'GET' && (id = m(/^\/v2\/payments\/authorizations\/([^/]+)$/)))
      return { op: 'get_authorization', id };
    if (method === 'POST' && path === '/v1/payments/payouts') return { op: 'payout', id: '' };
    if (method === 'GET' && (id = m(/^\/v1\/payments\/payouts\/([^/]+)$/)))
      return { op: 'get_payout_batch', id };
    if (method === 'GET' && (id = m(/^\/v1\/payments\/payouts-item\/([^/]+)$/)))
      return { op: 'get_payout_item', id };
    if (method === 'POST' && path === '/v1/notifications/verify-webhook-signature')
      return { op: 'verify_webhook', id: '' };
    return null;
  }

  #takeFault(op: FakeOp): FakeFault | undefined {
    return (
      this.#faults.get(op)?.shift() ??
      (op === 'token' ? undefined : this.#faults.get('any')?.shift())
    );
  }

  #delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }

  #hang(signal: AbortSignal | undefined): Promise<Response> {
    return new Promise((_, reject) => {
      const fail = () => reject(signal?.reason ?? new DOMException('timed out', 'TimeoutError'));
      if (signal?.aborted) return fail();
      if (signal) signal.addEventListener('abort', fail, { once: true });
      else setTimeout(fail, 60_000);
    });
  }

  #id(prefix: string): string {
    return `${prefix}${(++this.#seq).toString(36).toUpperCase().padStart(8, '0')}`;
  }

  #token(authorization: string | null): Handled {
    const expected = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')}`;
    if (authorization !== expected) return { http: 401, body: { error: 'invalid_client' } };
    const token = `fake-token-${++this.tokensIssued}`;
    this.#validTokens.add(token);
    return {
      http: 200,
      body: { access_token: token, token_type: 'Bearer', expires_in: this.#tokenTtl },
    };
  }

  #authorized(authorization: string | null): boolean {
    return !!authorization && this.#validTokens.has(authorization.replace(/^Bearer /, ''));
  }

  /** Same `PayPal-Request-Id` on the same endpoint → the stored answer (200 instead of 201). */
  #replayable(call: FakeCall, op: FakeOp, id: string, run: () => Handled): Handled {
    if (!call.requestId) return run();
    const key = `${op}:${id}:${call.requestId}`;
    const prior = this.#replays.get(key);
    if (prior) return prior.http === 201 ? { http: 200, body: prior.body } : prior;
    const result = run();
    if (result.http < 300) this.#replays.set(key, result);
    return result;
  }

  #handle(op: FakeOp, id: string, body: Record<string, unknown>, call: FakeCall): Handled {
    switch (op) {
      case 'order_create':
        return this.#createOrder(body, call);
      case 'authorize':
        return this.#replayable(call, op, id, () => this.#authorize(id));
      case 'capture':
        return this.#replayable(call, op, id, () => this.#capture(id, body, call.mockResponse));
      case 'void':
        return this.#replayable(call, op, id, () => this.#void(id));
      case 'get_authorization': {
        const auth = this.#auths.get(id);
        return auth ? { http: 200, body: this.#authBody(auth) } : err(404, 'INVALID_RESOURCE_ID');
      }
      case 'get_order': {
        const order = this.#orders.get(id);
        return order
          ? { http: 200, body: this.#orderBody(order) }
          : err(404, 'INVALID_RESOURCE_ID');
      }
      case 'payout':
        return this.#replayable(call, op, '', () => this.#payout(body));
      case 'get_payout_batch':
        return this.#getBatch(id);
      case 'get_payout_item': {
        const batch = this.#batches.get(this.#items.get(id) ?? '');
        return batch ? { http: 200, body: this.#itemBody(batch) } : err(404, 'INVALID_RESOURCE_ID');
      }
      case 'verify_webhook':
        return {
          http: 200,
          body: { verification_status: this.webhookVerifier(body) ? 'SUCCESS' : 'FAILURE' },
        };
      default:
        return err(404, 'RESOURCE_NOT_FOUND');
    }
  }

  // ------------------------------------------------------------------ orders

  #createOrder(body: Record<string, unknown>, call: FakeCall): Handled {
    const unit = ((body.purchase_units as unknown[]) ?? [])[0] as
      Record<string, unknown> | undefined;
    const value = (unit?.amount as { value?: string } | undefined)?.value;
    if (body.intent !== 'AUTHORIZE' || !unit || typeof value !== 'string')
      return err(400, 'INVALID_REQUEST');
    const source = (body.payment_source ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const card = source.card;
    const paypal = source.paypal;
    const rawCard = !!card && typeof card.number === 'string';

    if (call.requestId) {
      const prior = this.#replays.get(`order_create::${call.requestId}`);
      // S7: a raw-card create replay is refused; no-source and vault_id replays return the order.
      if (prior) return rawCard ? err(422, 'TRANSACTION_REFUSED') : { http: 200, body: prior.body };
    }
    const invoiceId = typeof unit.invoice_id === 'string' ? unit.invoice_id : null;
    if (invoiceId && this.#invoiceIds.has(invoiceId)) return err(422, 'DUPLICATE_INVOICE_ID');

    const vaultId = (card?.vault_id ?? paypal?.vault_id) as string | undefined;
    if (vaultId && !this.#vaults.has(vaultId)) return err(422, 'INVALID_RESOURCE_ID');
    const vaultAttr = ((card ?? paypal)?.attributes as { vault?: unknown } | undefined)?.vault;

    const order: FakeOrder = {
      id: this.#id('ORD'),
      status: 'CREATED',
      amountCents: decimalToCents(value),
      invoiceId,
      customId: typeof unit.custom_id === 'string' ? unit.custom_id : null,
      source: paypal ? 'paypal' : 'card',
      rawCard,
      vaultRequested: !!vaultAttr,
      vault: null,
      authorizationId: null,
    };
    this.#orders.set(order.id, order);
    if (invoiceId) this.#invoiceIds.add(invoiceId);

    if (rawCard || vaultId) {
      // Raw card and vaulted sources authorize at create (S1, S2, S7 step 4).
      this.#newAuthorization(order);
    } else if (paypal) {
      order.status = 'PAYER_ACTION_REQUIRED';
    }
    const result = { http: 201, body: this.#orderBody(order) };
    if (call.requestId) this.#replays.set(`order_create::${call.requestId}`, result);
    return result;
  }

  #newAuthorization(order: FakeOrder): FakeAuthorization {
    const now = this.#now();
    const auth: FakeAuthorization = {
      id: this.#id('AUTH'),
      orderId: order.id,
      status: 'CREATED',
      amountCents: order.amountCents,
      createTime: now.toISOString(),
      expirationTime: new Date(now.getTime() + 29 * 86_400_000).toISOString(),
      captureId: null,
    };
    this.#auths.set(auth.id, auth);
    order.authorizationId = auth.id;
    order.status = 'COMPLETED';
    if (order.vaultRequested) {
      const vaultId = this.#id('VAULT');
      this.#vaults.set(vaultId, order.source);
      order.vault = { id: vaultId, status: 'VAULTED' };
    }
    return auth;
  }

  #authorize(orderId: string): Handled {
    const order = this.#orders.get(orderId);
    if (!order) return err(404, 'INVALID_RESOURCE_ID');
    if (order.authorizationId) return err(422, 'ORDER_ALREADY_AUTHORIZED');
    if (order.status !== 'APPROVED') return err(422, 'ORDER_NOT_APPROVED');
    this.#newAuthorization(order);
    return { http: 201, body: this.#orderBody(order) };
  }

  #capture(authId: string, body: Record<string, unknown>, mock: string | null): Handled {
    const auth = this.#auths.get(authId);
    if (!auth) return err(404, 'INVALID_RESOURCE_ID');
    const code = mock
      ? (JSON.parse(mock) as { mock_application_codes?: string }).mock_application_codes
      : undefined;
    if (code === 'INSTRUMENT_DECLINED') return { http: 403 };
    if (code) return err(422, code);
    if (auth.status === 'CAPTURED') return err(422, 'AUTHORIZATION_ALREADY_CAPTURED');
    if (auth.status === 'VOIDED') return err(422, 'AUTHORIZATION_VOIDED');
    if (auth.status === 'EXPIRED') return err(422, 'AUTHORIZATION_EXPIRED');
    const value = (body.amount as { value?: string } | undefined)?.value;
    const cents = typeof value === 'string' ? decimalToCents(value) : auth.amountCents;
    if (cents > auth.amountCents) return err(422, 'CAPTURE_AMOUNT_EXCEEDED');
    const capture: FakeCapture = {
      id: this.#id('CAP'),
      authorizationId: auth.id,
      amountCents: cents,
      status: 'COMPLETED',
      createTime: this.#now().toISOString(),
    };
    this.#captures.set(capture.id, capture);
    auth.status = 'CAPTURED';
    auth.captureId = capture.id;
    return { http: 201, body: this.#captureBody(capture) };
  }

  #void(authId: string): Handled {
    const auth = this.#auths.get(authId);
    if (!auth) return err(404, 'INVALID_RESOURCE_ID');
    if (auth.status === 'VOIDED') return err(422, 'PREVIOUSLY_VOIDED');
    if (auth.status === 'CAPTURED') return err(422, 'PREVIOUSLY_CAPTURED');
    if (auth.status === 'EXPIRED') return err(422, 'AUTHORIZATION_EXPIRED');
    auth.status = 'VOIDED';
    return { http: 200, body: this.#authBody(auth) };
  }

  #authBody(a: FakeAuthorization) {
    const order = this.#orders.get(a.orderId);
    return {
      id: a.id,
      status: a.status,
      amount: amount(a.amountCents),
      // PayPal copies the purchase unit's ids onto the authorization.
      invoice_id: order?.invoiceId ?? undefined,
      custom_id: order?.customId ?? undefined,
      create_time: a.createTime,
      expiration_time: a.expirationTime,
      supplementary_data: { related_ids: { order_id: a.orderId } },
      links: [{ rel: 'self', href: `${FAKE_PAYPAL_BASE}/v2/payments/authorizations/${a.id}` }],
    };
  }

  #captureBody(c: FakeCapture) {
    return {
      id: c.id,
      status: c.status,
      amount: amount(c.amountCents),
      final_capture: true,
      create_time: c.createTime,
      links: [
        { rel: 'up', href: `${FAKE_PAYPAL_BASE}/v2/payments/authorizations/${c.authorizationId}` },
      ],
    };
  }

  #orderBody(o: FakeOrder) {
    const auth = o.authorizationId ? this.#auths.get(o.authorizationId) : undefined;
    const captures = auth
      ? [...this.#captures.values()].filter((c) => c.authorizationId === auth.id)
      : [];
    const vault = o.vault ? { attributes: { vault: o.vault } } : {};
    return {
      id: o.id,
      intent: 'AUTHORIZE',
      status: o.status,
      payment_source: { [o.source]: vault },
      purchase_units: [
        {
          invoice_id: o.invoiceId ?? undefined,
          custom_id: o.customId ?? undefined,
          amount: amount(o.amountCents),
          payments:
            auth || captures.length
              ? {
                  ...(auth ? { authorizations: [this.#authBody(auth)] } : {}),
                  ...(captures.length
                    ? { captures: captures.map((c) => this.#captureBody(c)) }
                    : {}),
                }
              : undefined,
        },
      ],
      links: [
        { rel: 'self', href: `${FAKE_PAYPAL_BASE}/v2/checkout/orders/${o.id}` },
        ...(o.status === 'PAYER_ACTION_REQUIRED'
          ? [{ rel: 'payer-action', href: `${FAKE_PAYPAL_BASE}/checkoutnow?token=${o.id}` }]
          : []),
      ],
    };
  }

  // ------------------------------------------------------------------ payouts

  #payout(body: Record<string, unknown>): Handled {
    const header = body.sender_batch_header as { sender_batch_id?: string } | undefined;
    const item = ((body.items as unknown[]) ?? [])[0] as
      { receiver?: string; amount?: { value?: string } } | undefined;
    if (!header?.sender_batch_id || !item?.receiver || typeof item.amount?.value !== 'string') {
      return err(400, 'VALIDATION_ERROR');
    }
    const cents = decimalToCents(item.amount.value);
    if (cents > this.payoutBalanceCents) return err(422, 'INSUFFICIENT_FUNDS');
    this.payoutBalanceCents -= cents;
    const self = this.#merchantEmail && item.receiver.toLowerCase() === this.#merchantEmail;
    const batch: FakePayoutBatch = {
      id: this.#id('BATCH'),
      senderBatchId: header.sender_batch_id,
      status: self ? 'DENIED' : 'PENDING',
      amountCents: cents,
      item: {
        id: this.#id('ITEM'),
        status: self ? 'FAILED' : 'PENDING',
        receiver: item.receiver,
        errorName: self ? 'SELF_PAY_NOT_ALLOWED' : null,
      },
      gets: 0,
    };
    this.#batches.set(batch.id, batch);
    this.#items.set(batch.item.id, batch.id);
    return {
      http: 201,
      body: {
        batch_header: {
          payout_batch_id: batch.id,
          batch_status: 'PENDING',
          sender_batch_header: { sender_batch_id: batch.senderBatchId },
        },
      },
    };
  }

  #getBatch(id: string): Handled {
    const batch = this.#batches.get(id);
    if (!batch) return err(404, 'INVALID_RESOURCE_ID');
    batch.gets++;
    if (batch.status === 'PENDING' && batch.gets > this.#payoutSettlesAfterGets) {
      batch.status = 'SUCCESS';
      batch.item.status = 'SUCCESS';
    }
    return {
      http: 200,
      body: {
        batch_header: {
          payout_batch_id: batch.id,
          batch_status: batch.status,
          sender_batch_header: { sender_batch_id: batch.senderBatchId },
          amount: { currency: 'USD', value: centsToDecimal(batch.amountCents) },
          fees: { currency: 'USD', value: '0.25' },
        },
        items: [this.#itemBody(batch)],
      },
    };
  }

  #itemBody(batch: FakePayoutBatch) {
    return {
      payout_item_id: batch.item.id,
      payout_batch_id: batch.id,
      transaction_status: batch.item.status,
      payout_item_fee: { currency: 'USD', value: '0.25' },
      payout_item: {
        recipient_type: 'EMAIL',
        receiver: batch.item.receiver,
        amount: { currency: 'USD', value: centsToDecimal(batch.amountCents) },
      },
      ...(batch.item.errorName ? { errors: { name: batch.item.errorName } } : {}),
    };
  }
}
