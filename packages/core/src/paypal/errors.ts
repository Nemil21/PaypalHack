import type { ErrorClass } from '@holdfast/shared';

/** The call a failed response came from; classification depends on it (D11, B4). */
export type PayPalCall =
  | 'token'
  | 'order_create'
  | 'authorize'
  | 'capture'
  | 'void'
  | 'payout'
  | 'track'
  | 'get'
  | 'verify_webhook';

/** What a failed response looked like. `http` is 0 when no response arrived (network, timeout). */
export interface FailureInfo {
  http: number;
  /** `details[0].issue`, else the top-level `name`, when the body had one. */
  issue?: string | undefined;
  timeout?: boolean;
}

/**
 * Issue codes recorded in spikes/s7-results.md (HF-063). Other codes still classify by the
 * table in `classifyFailure`; these are named because the client acts on them.
 */
export const ISSUE = {
  INSTRUMENT_DECLINED: 'INSTRUMENT_DECLINED',
  AUTHORIZATION_EXPIRED: 'AUTHORIZATION_EXPIRED',
  AUTHORIZATION_VOIDED: 'AUTHORIZATION_VOIDED',
  AUTHORIZATION_ALREADY_CAPTURED: 'AUTHORIZATION_ALREADY_CAPTURED',
  PREVIOUSLY_VOIDED: 'PREVIOUSLY_VOIDED',
  PREVIOUSLY_CAPTURED: 'PREVIOUSLY_CAPTURED',
  ORDER_ALREADY_AUTHORIZED: 'ORDER_ALREADY_AUTHORIZED',
  ORDER_NOT_APPROVED: 'ORDER_NOT_APPROVED',
  TRANSACTION_REFUSED: 'TRANSACTION_REFUSED',
  DUPLICATE_INVOICE_ID: 'DUPLICATE_INVOICE_ID',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
} as const;

/**
 * Three-way error class (D11, B4):
 * - `TRANSIENT`: no answer (network, timeout), 5xx, 429, 408; retry with the **same** request id.
 *   A payout `INSUFFICIENT_FUNDS` is also TRANSIENT (S7: retry later with a new attempt + alert).
 * - `RECONCILE`: any 422 on capture or void; `ORDER_ALREADY_AUTHORIZED` on authorize;
 *   `DUPLICATE_INVOICE_ID` on order create. The money is in an unknown state: GET it and act on
 *   what PayPal says, never treat it as a decline.
 * - `TERMINAL`: everything else (`INSTRUMENT_DECLINED`, `AUTHORIZATION_EXPIRED`, validation).
 *
 * The capture/void/authorize functions then turn RECONCILE into a final outcome via a GET.
 */
export function classifyFailure(call: PayPalCall, info: FailureInfo): ErrorClass {
  const { http, issue } = info;
  if (info.timeout || http === 0 || http >= 500 || http === 429 || http === 408) return 'TRANSIENT';
  if ((call === 'capture' || call === 'void') && http === 422) return 'RECONCILE';
  if (call === 'authorize' && issue === ISSUE.ORDER_ALREADY_AUTHORIZED) return 'RECONCILE';
  if (call === 'order_create' && issue === ISSUE.DUPLICATE_INVOICE_ID) return 'RECONCILE';
  if (call === 'payout' && issue === ISSUE.INSUFFICIENT_FUNDS) return 'TRANSIENT';
  return 'TERMINAL';
}

/** A non-2xx answer from a read (GET) or an unrecoverable transport failure. */
export class PayPalApiError extends Error {
  constructor(
    readonly call: PayPalCall,
    readonly http: number,
    readonly errorClass: ErrorClass,
    readonly code: string,
    readonly debugId?: string | undefined,
  ) {
    super(`PayPal ${call} failed: ${http || 'no response'} ${code}`);
    this.name = 'PayPalApiError';
  }
}
