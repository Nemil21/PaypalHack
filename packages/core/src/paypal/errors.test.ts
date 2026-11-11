import { describe, expect, it } from 'vitest';
import { classifyFailure, type FailureInfo, type PayPalCall } from './errors.js';

describe('classifyFailure (D11, B4, S7 mapping)', () => {
  const table: [PayPalCall, FailureInfo, string][] = [
    // TRANSIENT: no answer, 5xx, 429, 408.
    ['capture', { http: 0, timeout: true }, 'TRANSIENT'],
    ['void', { http: 0 }, 'TRANSIENT'],
    ['capture', { http: 503 }, 'TRANSIENT'],
    ['capture', { http: 500, issue: 'INTERNAL_SERVER_ERROR' }, 'TRANSIENT'],
    ['order_create', { http: 429, issue: 'RATE_LIMIT_REACHED' }, 'TRANSIENT'],
    ['authorize', { http: 408 }, 'TRANSIENT'],
    ['get', { http: 502 }, 'TRANSIENT'],
    // RECONCILE: any 422 on capture or void.
    ['capture', { http: 422, issue: 'AUTHORIZATION_ALREADY_CAPTURED' }, 'RECONCILE'],
    ['capture', { http: 422, issue: 'AUTHORIZATION_VOIDED' }, 'RECONCILE'],
    ['capture', { http: 422, issue: 'AUTHORIZATION_EXPIRED' }, 'RECONCILE'],
    ['capture', { http: 422 }, 'RECONCILE'],
    ['void', { http: 422, issue: 'PREVIOUSLY_VOIDED' }, 'RECONCILE'],
    ['void', { http: 422, issue: 'PREVIOUSLY_CAPTURED' }, 'RECONCILE'],
    ['authorize', { http: 422, issue: 'ORDER_ALREADY_AUTHORIZED' }, 'RECONCILE'],
    ['order_create', { http: 422, issue: 'DUPLICATE_INVOICE_ID' }, 'RECONCILE'],
    // TERMINAL.
    ['capture', { http: 403 }, 'TERMINAL'],
    ['order_create', { http: 422, issue: 'INSTRUMENT_DECLINED' }, 'TERMINAL'],
    ['order_create', { http: 422, issue: 'TRANSACTION_REFUSED' }, 'TERMINAL'],
    ['order_create', { http: 400, issue: 'INVALID_PARAMETER_VALUE' }, 'TERMINAL'],
    ['authorize', { http: 422, issue: 'INSTRUMENT_DECLINED' }, 'TERMINAL'],
    ['get', { http: 404, issue: 'INVALID_RESOURCE_ID' }, 'TERMINAL'],
    ['token', { http: 401 }, 'TERMINAL'],
    // Payouts (S7): INSUFFICIENT_FUNDS is retry-later, not FAILED.
    ['payout', { http: 422, issue: 'INSUFFICIENT_FUNDS' }, 'TRANSIENT'],
    ['payout', { http: 400, issue: 'VALIDATION_ERROR' }, 'TERMINAL'],
  ];

  it.each(table)('%s %j → %s', (call, info, expected) => {
    expect(classifyFailure(call, info)).toBe(expected);
  });
});
