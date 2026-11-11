import type { ErrorClass } from '@holdfast/shared';
import type { Db, Queryable } from '../db.js';
import type { BidRow, MandateRow } from './rows.js';

/** `void-<bidId>`: the one PayPal-Request-Id for voiding a bid's authorization (D4, D5, INV-4). */
export type VoidRequestId = string & { readonly __brand: 'VoidRequestId' };

/**
 * Result of `POST /v2/payments/authorizations/{id}/void`, judged by the body (B4).
 * `RECONCILE` (a 422) means the client GET the authorization; `authorizationStatus` carries what
 * it found when known.
 */
export type PayPalVoidResult =
  | { ok: true; status?: string }
  | { ok: false; errorClass: ErrorClass; code?: string; authorizationStatus?: string };

/**
 * The slice of the HF-004 PayPal client the money primitives need. HF-004's `PayPalClient` and
 * `FakePayPal` (`PAYPAL_MODE=stub`) satisfy it; until then tests use a local stub.
 */
export interface PayPalVoidPort {
  void(authorizationId: string, requestId: VoidRequestId): Promise<PayPalVoidResult>;
}

/** Who asked for a money action (audit actor types from data-model §audit_events). */
export interface Actor {
  type: string;
  id?: string | null;
}

export interface AuditEntry {
  actor: Actor;
  action: string;
  entity: 'bid';
  entityId: string;
  listingId: string;
  paypalId?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
}

/** HF-003b plugs the audit writer in here; called inside the business transaction. */
export type AuditHook = (tx: Queryable, entry: AuditEntry) => Promise<void>;

/** Why a mandate refuses a hold; `landHold` maps both to `void_reason = MANDATE_PAUSED`. */
export type MandateRefusal = 'MANDATE_PAUSED' | 'MANDATE_CAP';

export interface MandateCheckInput {
  mandate: MandateRow;
  bid: BidRow;
  /** The bid a raise replaces; its amount does not count toward the cap (D12). */
  replacesBidId: string | null;
  now: Date;
}

/**
 * Runs in `landHold` with the mandate locked `FOR UPDATE`. Returns null to allow the hold.
 * HF-017a supplies the full rules; `defaultMandateCheck` implements ACTIVE + D12 cap.
 */
export type MandateCheck = (
  tx: Queryable,
  input: MandateCheckInput,
) => Promise<MandateRefusal | null>;

export interface MoneyDeps {
  db: Db;
  paypal: PayPalVoidPort;
  mandateCheck?: MandateCheck;
  audit?: AuditHook;
  /** Waits before each void retry (D11: 1 s, 4 s, 16 s → 4 calls in total). */
  voidBackoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_VOID_BACKOFF_MS = [1_000, 4_000, 16_000] as const;
