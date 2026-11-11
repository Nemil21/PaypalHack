import { assertCents, centsToDecimal, CURRENCY, decimalToCents } from '@holdfast/shared';
import type { PayPalHttp, PayPalResponse } from './client.js';
import { classifyFailure, ISSUE, PayPalApiError } from './errors.js';
import type {
  PayoutBatchView,
  PayoutInput,
  PayoutItemOutcome,
  PayoutItemView,
  PayoutResult,
} from './types.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const is2xx = (res: PayPalResponse) => res.http >= 200 && res.http < 300;
const codeOf = (res: PayPalResponse) => res.issue ?? (res.http ? `HTTP_${res.http}` : 'NETWORK');

function cents(amount: unknown): number | null {
  const value = obj(amount).value;
  if (typeof value !== 'string') return null;
  try {
    return decimalToCents(value);
  } catch {
    return null;
  }
}

/** Payouts API amount (note: `currency`, not `currency_code` as in Orders). */
export function payoutAmount(amountCents: number): { value: string; currency: typeof CURRENCY } {
  return { value: centsToDecimal(amountCents), currency: CURRENCY };
}

const ITEM_SUCCESS = new Set(['SUCCESS']);
/** features/12: DENIED or UNCLAIMED → PAYOUT_FAILED (S7 also saw FAILED `SELF_PAY_NOT_ALLOWED`). */
const ITEM_FAILED = new Set([
  'FAILED',
  'DENIED',
  'UNCLAIMED',
  'RETURNED',
  'REFUNDED',
  'REVERSED',
  'BLOCKED',
  'CANCELED',
]);

export function payoutItemOutcome(transactionStatus: string): PayoutItemOutcome {
  if (ITEM_SUCCESS.has(transactionStatus)) return 'SUCCESS';
  if (ITEM_FAILED.has(transactionStatus)) return 'FAILED';
  return 'PENDING';
}

/**
 * `POST /v1/payments/payouts` with `sender_batch_id` = `PayPal-Request-Id` = the payout attempt id
 * (S4, M4). One EMAIL item to the brand.
 *
 * S7: `INSUFFICIENT_FUNDS` is a 422 at POST (no batch created) → TRANSIENT, retry later under a
 * **new** attempt id, alert. A timeout is TRANSIENT too: the caller records PENDING_UNKNOWN.
 */
export async function payout(http: PayPalHttp, input: PayoutInput): Promise<PayoutResult> {
  assertCents(input.amountCents, 'amountCents');
  if (input.amountCents <= 0) throw new RangeError('amountCents must be positive');
  const attemptId: string = input.attemptId;
  const res = await http.request('payout', 'POST', '/v1/payments/payouts', {
    requestId: input.attemptId,
    body: {
      sender_batch_header: {
        sender_batch_id: attemptId,
        email_subject: input.emailSubject ?? 'Your Holdfast payout',
        email_message: input.note,
      },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: input.email,
          amount: payoutAmount(input.amountCents),
          note: input.note,
          sender_item_id: `${attemptId}-1`,
        },
      ],
    },
  });
  if (is2xx(res)) {
    const header = obj(res.json.batch_header);
    const batchId = str(header.payout_batch_id);
    if (batchId) return { ok: true, batchId, batchStatus: str(header.batch_status) ?? 'PENDING' };
    return {
      ok: false,
      errorClass: 'RECONCILE',
      code: 'MALFORMED_RESPONSE',
      http: res.http,
      retryWithNewAttempt: false,
      alert: true,
    };
  }
  const errorClass = classifyFailure('payout', res);
  const insufficient = res.issue === ISSUE.INSUFFICIENT_FUNDS;
  return {
    ok: false,
    errorClass,
    code: codeOf(res),
    http: res.http,
    retryWithNewAttempt: insufficient,
    alert: insufficient || errorClass === 'TERMINAL',
  };
}

function readItem(raw: unknown): PayoutItemView {
  const i = obj(raw);
  const status = str(i.transaction_status) ?? 'UNKNOWN';
  return {
    itemId: str(i.payout_item_id) ?? '',
    batchId: str(i.payout_batch_id),
    transactionStatus: status,
    outcome: payoutItemOutcome(status),
    errorName: str(obj(i.errors).name),
    amountCents: cents(obj(i.payout_item).amount),
    feeCents: cents(i.payout_item_fee),
  };
}

async function getJson(http: PayPalHttp, path: string): Promise<Json> {
  const res = await http.request('get', 'GET', path);
  if (is2xx(res)) return res.json;
  throw new PayPalApiError('get', res.http, classifyFailure('get', res), codeOf(res), res.debugId);
}

/** `GET /v1/payments/payouts/{batch_id}`: batch status plus each item's status. */
export async function getPayoutBatch(http: PayPalHttp, batchId: string): Promise<PayoutBatchView> {
  const json = await getJson(http, `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  const header = obj(json.batch_header);
  const items = Array.isArray(json.items) ? json.items.map(readItem) : [];
  return {
    batchId: str(header.payout_batch_id) ?? batchId,
    senderBatchId: str(obj(header.sender_batch_header).sender_batch_id),
    batchStatus: str(header.batch_status) ?? 'UNKNOWN',
    amountCents: cents(header.amount),
    feesCents: cents(header.fees),
    items,
  };
}

/** `GET /v1/payments/payouts-item/{item_id}`. */
export async function getPayoutItem(http: PayPalHttp, itemId: string): Promise<PayoutItemView> {
  return readItem(await getJson(http, `/v1/payments/payouts-item/${encodeURIComponent(itemId)}`));
}
