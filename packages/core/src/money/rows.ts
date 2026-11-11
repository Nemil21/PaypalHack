import type { BidStatus, ListingStatus, VoidReason } from '@holdfast/shared';
import type { MandateStatus } from './transition.js';

/** Columns of `listings` the money primitives read (db/migrations/0001_init.sql). */
export interface ListingRow {
  id: string;
  brand_id: string;
  status: ListingStatus;
  quantity: number;
  floor_cents: number;
  window_closes_at: Date | null;
  rounds_end_at: Date | null;
  clear_deadline_at: Date | null;
  [col: string]: unknown;
}

/** Columns of `bids` the money primitives read. `seq` is bigint, so pg returns a string. */
export interface BidRow {
  id: string;
  seq: string;
  listing_id: string;
  shopper_id: string;
  mandate_id: string | null;
  intent_id: string | null;
  status: BidStatus;
  amount_cents: number;
  authorized_amount_cents: number | null;
  authorized_at: Date | null;
  paypal_order_id: string | null;
  paypal_authorization_id: string | null;
  source: string | null;
  placed_at: Date;
  void_reason: VoidReason | null;
  void_request_id: string | null;
  void_attempts: number;
  voided_at: Date | null;
  replaces_bid_id: string | null;
  error_code: string | null;
  [col: string]: unknown;
}

export interface MandateRow {
  id: string;
  shopper_id: string;
  status: MandateStatus;
  max_price_cents: number;
  total_hold_cap_cents: number;
  expires_at: Date | null;
  [col: string]: unknown;
}
