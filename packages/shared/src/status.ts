/** Status values mirror the CHECK constraints in db/migrations (HF-002, data-model.md). */

export const LISTING_STATUSES = [
  'DRAFT',
  'OPEN',
  'ROUNDS',
  'CLEARING',
  'SETTLED',
  'PAID_OUT',
  'PAYOUT_FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const BID_STATUSES = [
  'PENDING_APPROVAL',
  'ABANDONED',
  'HELD',
  'VOIDING',
  'VOIDED',
  'HOLD_FAILED',
  'WON',
  'LOST',
  'CAPTURED',
  'CAPTURE_FAILED',
  'SHIPPED',
] as const;
export type BidStatus = (typeof BID_STATUSES)[number];

export const VOID_REASONS = [
  'CANCELLED',
  'PRICE_DROP',
  'LOST',
  'WINDOW_EXPIRED',
  'WINDOW_CLOSED',
  'REPLACED',
  'MANDATE_PAUSED',
  'FULFILLED',
  'CAPTURE_FAILED',
  'HOLD_AGED',
  'EXPIRED',
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

export const SETTLEMENT_ACTIONS = ['CAPTURE', 'VOID'] as const;
export type SettlementAction = (typeof SETTLEMENT_ACTIONS)[number];

export const SETTLEMENT_STATUSES = [
  'QUEUED',
  'RUNNING',
  'RETRY',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const ERROR_CLASSES = ['TRANSIENT', 'TERMINAL', 'RECONCILE'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const PAYOUT_STATUSES = ['PENDING', 'PENDING_UNKNOWN', 'SUCCESS', 'FAILED'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
