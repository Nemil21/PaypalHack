import type { VoidRequestId } from '../money/deps.js';

/**
 * `PayPal-Request-Id` per call type (D5, INV-4, data-model.md §Locking and idempotency rule 6).
 * Every mutating client call takes one of these as a **required** parameter with no default, and
 * each call type has its own brand, so a capture id can't be passed to a void (and a plain string
 * can't be passed at all). Mint them only with the helpers below.
 *
 * | Call         | Request id                                   |
 * |--------------|----------------------------------------------|
 * | order create | `bid.id` (+ `invoice_id = custom_id = bid.id`) |
 * | authorize    | `authz-<bidId>`                              |
 * | capture      | `settlement.id`                              |
 * | void         | `void-<bidId>` (`voidKey`, money/void.ts)    |
 * | payout       | `sender_batch_id` = payout attempt id        |
 * | track        | `track-<shipmentId>` (HF-059b)               |
 */
type Branded<B extends string> = string & { readonly __brand: B };

export type OrderRequestId = Branded<'OrderRequestId'>;
export type AuthorizeRequestId = Branded<'AuthorizeRequestId'>;
export type CaptureRequestId = Branded<'CaptureRequestId'>;
export type PayoutRequestId = Branded<'PayoutRequestId'>;
export type TrackRequestId = Branded<'TrackRequestId'>;
export type { VoidRequestId };

export type AnyRequestId =
  | OrderRequestId
  | AuthorizeRequestId
  | CaptureRequestId
  | VoidRequestId
  | PayoutRequestId
  | TrackRequestId;

function nonEmpty(id: string, what: string): string {
  if (typeof id !== 'string' || id.trim() === '') throw new TypeError(`${what} is required`);
  return id;
}

/** Order create: the bid id itself. The same id is sent as `invoice_id` and `custom_id`. */
export function orderRequestId(bidId: string): OrderRequestId {
  return nonEmpty(bidId, 'bidId') as OrderRequestId;
}

/** Authorize an approved order: `authz-<bidId>` (M2). */
export function authorizeRequestId(bidId: string): AuthorizeRequestId {
  return `authz-${nonEmpty(bidId, 'bidId')}` as AuthorizeRequestId;
}

/** Capture: the settlement row id (S3). */
export function captureRequestId(settlementId: string): CaptureRequestId {
  return nonEmpty(settlementId, 'settlementId') as CaptureRequestId;
}

/** Payout: the `payouts` attempt row id, also used as `sender_batch_id` (M4). */
export function payoutRequestId(attemptId: string): PayoutRequestId {
  return nonEmpty(attemptId, 'attemptId') as PayoutRequestId;
}

/** Tracking upload (HF-059b): `track-<shipmentId>`. */
export function trackRequestId(shipmentId: string): TrackRequestId {
  return `track-${nonEmpty(shipmentId, 'shipmentId')}` as TrackRequestId;
}
