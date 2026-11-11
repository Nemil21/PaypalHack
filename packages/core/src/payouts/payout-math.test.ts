/**
 * HF-032 unit tests: fee rounding on the payout path, the POST and batch status mapping, the
 * sender_batch_id format and the payout note. No database.
 */
import { feeCents } from '@holdfast/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PayoutBatchView, PayoutItemView, PayoutResult } from '../paypal/types.js';
import { payoutItemOutcome } from '../paypal/payouts.js';
import {
  classifyPayoutPost,
  isDuplicateBatch,
  parseSenderBatchId,
  payoutAmounts,
  payoutFailureReason,
  payoutNote,
  resolveBatch,
  senderBatchId,
} from './payout-brand.js';

describe('payoutAmounts (fee rounding)', () => {
  it('uses the shared feeCents: 9% rounded half up', () => {
    expect(payoutAmounts(5_424_000, 900)).toEqual({
      grossCents: 5_424_000,
      feeCents: 488_160,
      netCents: 4_935_840,
    });
    // 240 units at an average of $226.00: the demo listing.
    expect(payoutAmounts(240 * 22_600, 900)).toEqual({
      grossCents: 5_424_000,
      feeCents: 488_160,
      netCents: 4_935_840,
    });
    expect(payoutAmounts(5, 900).feeCents).toBe(0); // 0.45¢ rounds down
    expect(payoutAmounts(6, 900).feeCents).toBe(1); // 0.54¢ rounds up
    expect(payoutAmounts(50, 900)).toEqual({ grossCents: 50, feeCents: 5, netCents: 45 }); // 4.5¢ → 5
    expect(payoutAmounts(0, 900)).toEqual({ grossCents: 0, feeCents: 0, netCents: 0 });
    expect(payoutAmounts(10_000, 0).netCents).toBe(10_000);
    expect(payoutAmounts(10_000, 10_000).netCents).toBe(0);
  });

  it('fee + net = gross, and the fee matches what /simulate shows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (gross, bps) => {
          const a = payoutAmounts(gross, bps);
          expect(a.feeCents + a.netCents).toBe(gross);
          expect(a.feeCents).toBe(feeCents(gross, bps));
          expect(a.netCents).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(a.feeCents)).toBe(true);
        },
      ),
    );
  });
});

describe('sender_batch_id (D5)', () => {
  const id = '3f2b7c1e-0a9d-4e5f-8b6a-1c2d3e4f5a6b';
  it('is <payout.id>:<attempt> and round-trips', () => {
    expect(senderBatchId(id, 1)).toBe(`${id}:1`);
    expect(senderBatchId(id, 2)).toBe(`${id}:2`);
    expect(parseSenderBatchId(`${id}:2`)).toEqual({ payoutId: id, attempt: 2 });
    expect(parseSenderBatchId('not-ours')).toBeNull();
    expect(parseSenderBatchId(`${id}`)).toBeNull();
    expect(() => senderBatchId(id, 0)).toThrow(RangeError);
  });
});

describe('payoutNote (D14)', () => {
  it('names units and the average, never one price', () => {
    expect(payoutNote('Aurel A7', 240, 240 * 22_600)).toBe(
      'Holdfast: Aurel A7, 240 units cleared, average $226.00',
    );
    expect(payoutNote('Aurel A7', 3, 100)).toBe(
      'Holdfast: Aurel A7, 3 units cleared, average $0.33',
    );
    expect(payoutNote(' ', 1, 22_950)).toBe('Holdfast: listing, 1 unit cleared, average $229.50');
  });
});

const fail = (over: Partial<Extract<PayoutResult, { ok: false }>>): PayoutResult => ({
  ok: false,
  errorClass: 'TERMINAL',
  code: 'VALIDATION_ERROR',
  http: 400,
  retryWithNewAttempt: false,
  alert: true,
  ...over,
});

describe('classifyPayoutPost', () => {
  it('maps every POST answer to one attempt outcome', () => {
    expect(classifyPayoutPost({ ok: true, batchId: 'B1', batchStatus: 'PENDING' })).toEqual({
      kind: 'SENT',
      batchId: 'B1',
      batchStatus: 'PENDING',
    });
    // No answer / timeout / 5xx: ambiguous, re-POST the same id.
    expect(classifyPayoutPost(fail({ errorClass: 'TRANSIENT', code: 'TIMEOUT', http: 0 }))).toEqual(
      { kind: 'UNKNOWN', code: 'TIMEOUT' },
    );
    expect(
      classifyPayoutPost(fail({ errorClass: 'TRANSIENT', code: 'HTTP_503', http: 503 })).kind,
    ).toBe('UNKNOWN');
    // A 2xx without a batch id: PayPal may have it.
    expect(
      classifyPayoutPost(fail({ errorClass: 'RECONCILE', code: 'MALFORMED_RESPONSE', http: 201 })),
    ).toEqual({ kind: 'UNKNOWN', code: 'MALFORMED_RESPONSE' });
    // Duplicate batch: never a failure (the batch may exist under our id).
    expect(
      classifyPayoutPost(fail({ code: 'Batch with given sender_batch_id already exists' })),
    ).toEqual({ kind: 'UNKNOWN', code: 'DUPLICATE_BATCH' });
    expect(classifyPayoutPost(fail({ code: 'DUPLICATE_REQUEST_ID' })).kind).toBe('UNKNOWN');
    // S7: INSUFFICIENT_FUNDS is a 422 at POST with no batch: retry later with a new attempt.
    expect(
      classifyPayoutPost(
        fail({
          errorClass: 'TRANSIENT',
          code: 'INSUFFICIENT_FUNDS',
          http: 422,
          retryWithNewAttempt: true,
        }),
      ),
    ).toEqual({ kind: 'FUNDS', code: 'INSUFFICIENT_FUNDS' });
    expect(classifyPayoutPost(fail({ code: 'VALIDATION_ERROR' }))).toEqual({
      kind: 'REFUSED',
      code: 'VALIDATION_ERROR',
    });
  });

  it('isDuplicateBatch only matches duplicate answers', () => {
    expect(isDuplicateBatch('SENDER_BATCH_ID_ALREADY_EXISTS')).toBe(true);
    expect(isDuplicateBatch('INSUFFICIENT_FUNDS')).toBe(false);
    expect(isDuplicateBatch('TIMEOUT')).toBe(false);
  });
});

function item(transactionStatus: string, errorName: string | null = null): PayoutItemView {
  return {
    itemId: 'ITEM-1',
    batchId: 'BATCH-1',
    transactionStatus,
    outcome: payoutItemOutcome(transactionStatus),
    errorName,
    amountCents: 100,
    feeCents: 25,
  };
}
const batch = (batchStatus: string, items: PayoutItemView[]): PayoutBatchView => ({
  batchId: 'BATCH-1',
  senderBatchId: 'x:1',
  batchStatus,
  amountCents: 100,
  feesCents: 25,
  items,
});

describe('resolveBatch (status mapping, features/12 §Logic 2)', () => {
  it('the item decides: SUCCESS → PAID_OUT', () => {
    expect(resolveBatch(batch('SUCCESS', [item('SUCCESS')]))).toEqual({
      kind: 'SUCCESS',
      itemId: 'ITEM-1',
      itemStatus: 'SUCCESS',
    });
  });

  it('batch SUCCESS with a non-success item is not PAID_OUT', () => {
    expect(resolveBatch(batch('SUCCESS', [item('UNCLAIMED')]))).toMatchObject({
      kind: 'FAILED',
      code: 'UNCLAIMED',
    });
    expect(resolveBatch(batch('SUCCESS', [item('PENDING')])).kind).toBe('PENDING');
  });

  it('DENIED / FAILED / RETURNED / UNCLAIMED → PAYOUT_FAILED with a code', () => {
    expect(resolveBatch(batch('DENIED', [item('FAILED', 'SELF_PAY_NOT_ALLOWED')]))).toEqual({
      kind: 'FAILED',
      itemId: 'ITEM-1',
      itemStatus: 'FAILED',
      code: 'SELF_PAY_NOT_ALLOWED',
    });
    expect(resolveBatch(batch('SUCCESS', [item('RETURNED')]))).toMatchObject({
      kind: 'FAILED',
      code: 'RETURNED',
    });
    expect(resolveBatch(batch('DENIED', [item('UNCLAIMED')]))).toMatchObject({
      kind: 'FAILED',
      code: 'UNCLAIMED',
    });
    expect(resolveBatch(batch('DENIED', []))).toMatchObject({
      kind: 'FAILED',
      code: 'BATCH_DENIED',
    });
    expect(resolveBatch(batch('DENIED', [item('PENDING')]))).toMatchObject({
      kind: 'FAILED',
      code: 'BATCH_DENIED',
    });
  });

  it('anything else is still pending', () => {
    for (const s of ['PENDING', 'PROCESSING', 'ONHOLD', 'NEW']) {
      expect(resolveBatch(batch(s, [item(s)])).kind).toBe('PENDING');
    }
    expect(resolveBatch(batch('PENDING', [])).kind).toBe('PENDING');
  });

  it('failure reasons read like the spec', () => {
    expect(payoutFailureReason('UNCLAIMED')).toBe('brand payout email is not a PayPal account');
    expect(payoutFailureReason('SOMETHING')).toBe('SOMETHING');
    expect(payoutFailureReason(null)).toBeNull();
  });
});
