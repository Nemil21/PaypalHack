import { assertCents, decimalToCents, paypalAmount } from '@holdfast/shared';
import type { PayPalHttp, PayPalResponse } from './client.js';
import { classifyFailure, ISSUE, PayPalApiError, type PayPalCall } from './errors.js';
import { captureRequestId, type AuthorizeRequestId, type VoidRequestId } from './ids.js';
import type {
  AuthorizationView,
  CaptureInput,
  CaptureResult,
  CaptureView,
  CreateAuthOrderInput,
  HoldResult,
  MockResponseCode,
  OrderView,
  PaymentSource,
  VaultInfo,
  VoidResult,
} from './types.js';

export interface OrderSettings {
  allowRawCard: boolean;
  allowMockResponse: boolean;
  /** Extra tries with the same request id when create / authorize gets no answer (M6). */
  holdRetries: number;
  holdRetryDelayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function cents(amount: unknown): number | null {
  const value = obj(amount).value;
  if (typeof value !== 'string') return null;
  try {
    return decimalToCents(value);
  } catch {
    return null;
  }
}

const is2xx = (res: PayPalResponse) => res.http >= 200 && res.http < 300;
const codeOf = (res: PayPalResponse) => res.issue ?? (res.http ? `HTTP_${res.http}` : 'NETWORK');

// ---------------------------------------------------------------------------------------------
// Body readers

export function readAuthorization(raw: unknown): AuthorizationView {
  const a = obj(raw);
  return {
    id: str(a.id) ?? '',
    status: str(a.status) ?? 'UNKNOWN',
    amountCents: cents(a.amount),
    createTime: str(a.create_time),
    expirationTime: str(a.expiration_time),
    orderId: str(obj(obj(a.supplementary_data).related_ids).order_id),
  };
}

function readCapture(raw: unknown): CaptureView {
  const c = obj(raw);
  const up = arr(c.links)
    .map(obj)
    .find((l) => l.rel === 'up' && typeof l.href === 'string');
  const authId = up ? /\/authorizations\/([^/?#]+)/.exec(up.href as string)?.[1] : undefined;
  return {
    id: str(c.id) ?? '',
    status: str(c.status) ?? 'UNKNOWN',
    amountCents: cents(c.amount),
    authorizationId:
      authId ?? str(obj(obj(c.supplementary_data).related_ids).authorization_id) ?? null,
  };
}

function payments(order: Json): Json {
  return obj(obj(arr(order.purchase_units)[0]).payments);
}

function vaultOf(order: Json): VaultInfo | null {
  const ps = obj(order.payment_source);
  const vault = obj(obj(obj(ps.card).attributes).vault ?? obj(obj(ps.paypal).attributes).vault);
  const status = str(vault.status);
  return status ? { id: str(vault.id), status } : null;
}

/** The buyer approval link: `rel=payer-action` (v2 with payment_source) or `approve`. */
function approveUrlOf(order: Json): string | null {
  const links = arr(order.links).map(obj);
  const link =
    links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve');
  return link ? str(link.href) : null;
}

export function readOrder(raw: unknown): OrderView {
  const o = obj(raw);
  const pay = payments(o);
  return {
    id: str(o.id) ?? '',
    status: str(o.status) ?? 'UNKNOWN',
    approveUrl: approveUrlOf(o),
    authorizations: arr(pay.authorizations).map(readAuthorization),
    captures: arr(pay.captures).map(readCapture),
    vault: vaultOf(o),
  };
}

/** Statuses an order sits in before it has an authorization (buyer action or card submit due). */
const AWAITING_BUYER = new Set(['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED']);

/**
 * Judge a hold by the response **body** (M6): only an authorization in status `CREATED` is held.
 */
export function judgeHold(raw: unknown): HoldResult {
  const order = readOrder(raw);
  const orderId = order.id || null;
  const auth = order.authorizations[0];
  if (auth?.id) {
    if (auth.status === 'CREATED') {
      if (auth.amountCents === null || !auth.createTime || !orderId) {
        return { kind: 'unknown', orderId, code: 'MALFORMED_RESPONSE', errorClass: 'RECONCILE' };
      }
      return {
        kind: 'held',
        orderId,
        authorizationId: auth.id,
        authorizedAt: auth.createTime,
        expiresAt: auth.expirationTime,
        amountCents: auth.amountCents,
        vault: order.vault,
      };
    }
    if (auth.status === 'PENDING') {
      return {
        kind: 'pending',
        orderId: orderId ?? '',
        authorizationId: auth.id,
        status: auth.status,
      };
    }
    return {
      kind: 'denied',
      orderId,
      authorizationId: auth.id,
      code: `AUTHORIZATION_${auth.status}`,
      errorClass: 'TERMINAL',
    };
  }
  if (orderId && AWAITING_BUYER.has(order.status)) {
    return { kind: 'needs_approval', orderId, approveUrl: order.approveUrl, status: order.status };
  }
  if (order.status === 'VOIDED') {
    return {
      kind: 'denied',
      orderId,
      authorizationId: null,
      code: 'ORDER_VOIDED',
      errorClass: 'TERMINAL',
    };
  }
  return { kind: 'unknown', orderId, code: `ORDER_${order.status}`, errorClass: 'RECONCILE' };
}

// ---------------------------------------------------------------------------------------------
// Order create / authorize

const STORED_CREDENTIAL = { payment_type: 'UNSCHEDULED', usage: 'SUBSEQUENT' } as const;

export function paymentSourceBody(source: PaymentSource): Json {
  switch (source.kind) {
    case 'wallet':
      return {
        paypal: {
          // S7 step 2: wallet orders vault (MERCHANT / CONSUMER), so raises can use the vault_id.
          ...(source.vault === false
            ? {}
            : {
                attributes: {
                  vault: {
                    store_in_vault: 'ON_SUCCESS',
                    usage_type: 'MERCHANT',
                    customer_type: 'CONSUMER',
                  },
                },
              }),
          experience_context: {
            return_url: source.returnUrl,
            cancel_url: source.cancelUrl,
            user_action: 'CONTINUE',
            shipping_preference: 'NO_SHIPPING',
            ...(source.brandName ? { brand_name: source.brandName } : {}),
          },
        },
      };
    case 'card_fields':
      return {
        card: {
          attributes: {
            verification: { method: 'SCA_WHEN_REQUIRED' },
            vault: { store_in_vault: 'ON_SUCCESS' },
          },
          experience_context: { return_url: source.returnUrl, cancel_url: source.cancelUrl },
        },
      };
    case 'card_vault':
      return {
        card: {
          vault_id: source.vaultId,
          stored_credential: { payment_initiator: source.initiator, ...STORED_CREDENTIAL },
        },
      };
    case 'wallet_vault':
      return { paypal: { vault_id: source.vaultId } };
    case 'test_card':
      return {
        card: {
          ...source.card,
          ...(source.vault ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } } : {}),
        },
      };
  }
}

/** Retry a create / authorize with the same request id while PayPal doesn't answer (M6). */
async function withHoldRetries(
  settings: OrderSettings,
  call: PayPalCall,
  send: () => Promise<PayPalResponse>,
): Promise<PayPalResponse> {
  let res = await send();
  for (let attempt = 1; attempt <= settings.holdRetries; attempt++) {
    if (is2xx(res) || classifyFailure(call, res) !== 'TRANSIENT') return res;
    await settings.sleep(settings.holdRetryDelayMs(attempt));
    res = await send();
  }
  return res;
}

function assertAmount(amountCents: number): void {
  assertCents(amountCents, 'amountCents');
  if (amountCents <= 0) throw new RangeError('amountCents must be positive');
}

/**
 * `POST /v2/checkout/orders` with `intent: AUTHORIZE`, `PayPal-Request-Id = bid.id` and
 * `invoice_id = custom_id = bid.id` (D5). Vault and test-card sources authorize at create; wallet
 * and card-fields orders come back `needs_approval`.
 *
 * S7 mapping: a raw-card replay is refused (`TRANSACTION_REFUSED`) and `DUPLICATE_INVOICE_ID`
 * means a hold for this bid already exists; both are `unknown` (RECONCILE): our bid row (bid →
 * order id) is the dedupe, never a decline.
 */
export async function createAuthOrder(
  http: PayPalHttp,
  settings: OrderSettings,
  input: CreateAuthOrderInput,
): Promise<HoldResult> {
  assertAmount(input.amountCents);
  if (input.paymentSource.kind === 'test_card' && !settings.allowRawCard) {
    throw new Error('raw card payment sources are allowed only in seed / sandbox demo paths');
  }
  const bidId: string = input.requestId;
  const body = {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        invoice_id: bidId,
        custom_id: bidId,
        amount: paypalAmount(input.amountCents),
        ...(input.description ? { description: input.description.slice(0, 127) } : {}),
      },
    ],
    payment_source: paymentSourceBody(input.paymentSource),
  };
  const res = await withHoldRetries(settings, 'order_create', () =>
    http.request('order_create', 'POST', '/v2/checkout/orders', {
      body,
      requestId: input.requestId,
    }),
  );
  if (is2xx(res)) return judgeHold(res.json);
  const errorClass = classifyFailure('order_create', res);
  if (errorClass !== 'TERMINAL') {
    return { kind: 'unknown', orderId: null, code: codeOf(res), errorClass };
  }
  if (res.issue === ISSUE.TRANSACTION_REFUSED && input.paymentSource.kind === 'test_card') {
    return { kind: 'unknown', orderId: null, code: res.issue, errorClass: 'RECONCILE' };
  }
  return {
    kind: 'denied',
    orderId: null,
    authorizationId: null,
    code: codeOf(res),
    errorClass: 'TERMINAL',
  };
}

/**
 * `POST /v2/checkout/orders/{id}/authorize` with `authz-<bidId>` and **no body** (S7: a body with
 * `payment_source` is refused on any second call). A same-id replay returns the same authorization;
 * `ORDER_ALREADY_AUTHORIZED` (a different id) → GET the order and take its authorization (M2).
 */
export async function authorizeOrder(
  http: PayPalHttp,
  settings: OrderSettings,
  orderId: string,
  requestId: AuthorizeRequestId,
): Promise<HoldResult> {
  const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`;
  const res = await withHoldRetries(settings, 'authorize', () =>
    http.request('authorize', 'POST', path, { requestId }),
  );
  if (is2xx(res)) return judgeHold(res.json);
  const errorClass = classifyFailure('authorize', res);
  if (errorClass === 'TRANSIENT')
    return { kind: 'unknown', orderId, code: codeOf(res), errorClass };
  if (res.issue === ISSUE.ORDER_ALREADY_AUTHORIZED || res.issue === ISSUE.TRANSACTION_REFUSED) {
    // S7 step 3 also saw TRANSACTION_REFUSED on an authorize replay: if the order already has an
    // authorization, that is the hold.
    const order = await http.request(
      'get',
      'GET',
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
    if (is2xx(order) && readOrder(order.json).authorizations.length) return judgeHold(order.json);
    if (res.issue === ISSUE.ORDER_ALREADY_AUTHORIZED) {
      return { kind: 'unknown', orderId, code: res.issue, errorClass: 'RECONCILE' };
    }
  }
  if (res.issue === ISSUE.ORDER_NOT_APPROVED || res.issue === 'PAYER_ACTION_REQUIRED') {
    return { kind: 'needs_approval', orderId, approveUrl: null, status: res.issue };
  }
  return {
    kind: 'denied',
    orderId,
    authorizationId: null,
    code: codeOf(res),
    errorClass: 'TERMINAL',
  };
}

// ---------------------------------------------------------------------------------------------
// Reads

async function getJson(http: PayPalHttp, path: string): Promise<Json> {
  const res = await http.request('get', 'GET', path);
  if (is2xx(res)) return res.json;
  throw new PayPalApiError('get', res.http, classifyFailure('get', res), codeOf(res), res.debugId);
}

export async function getAuthorization(
  http: PayPalHttp,
  authorizationId: string,
): Promise<AuthorizationView> {
  return readAuthorization(
    await getJson(http, `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`),
  );
}

export async function getOrder(http: PayPalHttp, orderId: string): Promise<OrderView> {
  return readOrder(await getJson(http, `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
}

/** GET the authorization for RECONCILE; a failed GET is TRANSIENT unless PayPal says it never will work. */
async function reconcileAuthorization(
  http: PayPalHttp,
  authorizationId: string,
): Promise<{ auth: AuthorizationView } | { failed: PayPalApiError }> {
  try {
    return { auth: await getAuthorization(http, authorizationId) };
  } catch (err) {
    if (err instanceof PayPalApiError) return { failed: err };
    return { failed: new PayPalApiError('get', 0, 'TRANSIENT', 'NETWORK') };
  }
}

// ---------------------------------------------------------------------------------------------
// Capture / void

const CAPTURED = new Set(['CAPTURED', 'PARTIALLY_CAPTURED']);
const CAPTURE_OK = new Set(['COMPLETED', 'PENDING']);

/**
 * `POST /v2/payments/authorizations/{id}/capture` `{amount, final_capture: true}` with
 * `PayPal-Request-Id = settlement.id` (S1, S3). Success is judged by the body status
 * (`COMPLETED` or `PENDING`).
 *
 * Any other 4xx goes through RECONCILE (B4, S7): GET the authorization, then
 * CAPTURED → success with the original capture id (from the order; the authorization body has no
 * capture link) · VOIDED → TERMINAL + alert · EXPIRED → TERMINAL · still CREATED (mock decline is a
 * 403 with an empty body; mock expired is a 422 `AUTHORIZATION_EXPIRED`) → TERMINAL; the caller
 * voids it.
 */
export async function capture(
  http: PayPalHttp,
  settings: OrderSettings,
  input: CaptureInput,
): Promise<CaptureResult> {
  assertAmount(input.amountCents);
  const headers: Record<string, string> = {};
  if (input.mockResponse && settings.allowMockResponse) {
    headers['PayPal-Mock-Response'] = JSON.stringify({
      mock_application_codes: input.mockResponse,
    });
  }
  const path = `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/capture`;
  const res = await http.request('capture', 'POST', path, {
    body: { amount: paypalAmount(input.amountCents), final_capture: true },
    requestId: input.requestId,
    headers,
  });

  if (is2xx(res)) {
    const status = str(res.json.status) ?? 'UNKNOWN';
    if (CAPTURE_OK.has(status)) {
      return {
        ok: true,
        captureId: str(res.json.id),
        status,
        amountCents: cents(res.json.amount),
        reconciled: false,
      };
    }
    return {
      ok: false,
      errorClass: 'TERMINAL',
      code: `CAPTURE_${status}`,
      http: res.http,
      alert: false,
    };
  }
  const errorClass = classifyFailure('capture', res);
  if (errorClass === 'TRANSIENT') {
    return { ok: false, errorClass, code: codeOf(res), http: res.http, alert: false };
  }
  if (res.http === 401) {
    return {
      ok: false,
      errorClass: 'TERMINAL',
      code: 'AUTHENTICATION_FAILURE',
      http: 401,
      alert: true,
    };
  }

  const found = await reconcileAuthorization(http, input.authorizationId);
  if ('failed' in found) {
    return {
      ok: false,
      errorClass: found.failed.errorClass === 'TRANSIENT' ? 'TRANSIENT' : 'TERMINAL',
      code: codeOf(res),
      http: res.http,
      alert: false,
    };
  }
  const { auth } = found;
  if (CAPTURED.has(auth.status)) {
    const existing = await findCapture(http, auth);
    return {
      ok: true,
      captureId: existing?.id ?? null,
      status: existing?.status ?? 'COMPLETED',
      amountCents: existing?.amountCents ?? null,
      reconciled: true,
    };
  }
  const base = { ok: false as const, http: res.http, authorizationStatus: auth.status };
  if (auth.status === 'VOIDED') {
    return { ...base, errorClass: 'TERMINAL', code: ISSUE.AUTHORIZATION_VOIDED, alert: true };
  }
  if (auth.status === 'EXPIRED') {
    return { ...base, errorClass: 'TERMINAL', code: ISSUE.AUTHORIZATION_EXPIRED, alert: false };
  }
  // Still CREATED (or DENIED / PENDING): the capture really failed; the hold must be voided.
  return { ...base, errorClass: 'TERMINAL', code: res.issue ?? 'CAPTURE_DECLINED', alert: false };
}

/** The capture made from `auth`, read from its order (S7: the authorization has no capture link). */
async function findCapture(http: PayPalHttp, auth: AuthorizationView): Promise<CaptureView | null> {
  if (!auth.orderId) return null;
  try {
    const order = await getOrder(http, auth.orderId);
    const mine = order.captures.filter((c) => c.authorizationId === auth.id);
    if (mine.length) return mine[0] ?? null;
    return order.captures.length === 1 ? (order.captures[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * `POST /v2/payments/authorizations/{id}/void` with `void-<bidId>` on every path (D4). A same-id
 * replay returns 200 VOIDED. Any 4xx → GET the authorization (RECONCILE, S7):
 * VOIDED → success · CAPTURED → RECONCILE + alert (money taken on a loser) · EXPIRED → TERMINAL
 * `AUTHORIZATION_EXPIRED` (nothing held any more).
 */
export async function voidAuthorization(
  http: PayPalHttp,
  authorizationId: string,
  requestId: VoidRequestId,
): Promise<VoidResult> {
  const path = `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`;
  const res = await http.request('void', 'POST', path, { requestId });
  if (is2xx(res)) return { ok: true, status: 'VOIDED', reconciled: false };
  const errorClass = classifyFailure('void', res);
  if (errorClass === 'TRANSIENT') {
    return { ok: false, errorClass, code: codeOf(res), http: res.http, alert: false };
  }
  if (res.http === 401) {
    return {
      ok: false,
      errorClass: 'TERMINAL',
      code: 'AUTHENTICATION_FAILURE',
      http: 401,
      alert: true,
    };
  }

  const found = await reconcileAuthorization(http, authorizationId);
  if ('failed' in found) {
    return {
      ok: false,
      errorClass: found.failed.errorClass === 'TRANSIENT' ? 'TRANSIENT' : 'TERMINAL',
      code: codeOf(res),
      http: res.http,
      alert: false,
    };
  }
  const { auth } = found;
  if (auth.status === 'VOIDED') return { ok: true, status: 'VOIDED', reconciled: true };
  const base = { ok: false as const, http: res.http, authorizationStatus: auth.status };
  if (CAPTURED.has(auth.status)) {
    return {
      ...base,
      errorClass: 'RECONCILE',
      code: res.issue ?? ISSUE.PREVIOUSLY_CAPTURED,
      alert: true,
    };
  }
  if (auth.status === 'EXPIRED') {
    return { ...base, errorClass: 'TERMINAL', code: ISSUE.AUTHORIZATION_EXPIRED, alert: false };
  }
  return { ...base, errorClass: 'TERMINAL', code: codeOf(res), alert: true };
}

// ---------------------------------------------------------------------------------------------
// INV-5

const MOCK_CODES: readonly MockResponseCode[] = ['INSTRUMENT_DECLINED', 'AUTHORIZATION_EXPIRED'];

export interface CaptureSettlementRow {
  id: string;
  bid_id: string;
  action: string;
  amount_cents: number | null;
  mock_response?: string | null;
}

export interface CaptureBidRow {
  id: string;
  amount_cents: number;
  authorized_amount_cents: number | null;
  paypal_authorization_id: string | null;
}

/**
 * Build the capture call from the settlement and its bid row (INV-5): the amount is the bid's own
 * amount and must equal the settlement and the authorized amount; the request id is the
 * settlement id; `mock_response` comes only from the settlement row, never from request input.
 */
export function captureInputFor(
  settlement: CaptureSettlementRow,
  bid: CaptureBidRow,
): CaptureInput {
  if (settlement.action !== 'CAPTURE')
    throw new Error(`settlement ${settlement.id} is not a CAPTURE`);
  if (settlement.bid_id !== bid.id)
    throw new Error(`settlement ${settlement.id} is not for bid ${bid.id}`);
  if (!bid.paypal_authorization_id) throw new Error(`bid ${bid.id} has no authorization`);
  if (
    settlement.amount_cents !== bid.amount_cents ||
    bid.authorized_amount_cents !== bid.amount_cents
  ) {
    throw new Error(
      `INV-5: capture amount for settlement ${settlement.id} differs from bid ${bid.id}`,
    );
  }
  const mock = settlement.mock_response ?? null;
  if (mock !== null && !(MOCK_CODES as readonly string[]).includes(mock)) {
    throw new Error(`settlement ${settlement.id} has an unknown mock_response`);
  }
  return {
    authorizationId: bid.paypal_authorization_id,
    requestId: captureRequestId(settlement.id),
    amountCents: bid.amount_cents,
    mockResponse: mock as MockResponseCode | null,
  };
}
