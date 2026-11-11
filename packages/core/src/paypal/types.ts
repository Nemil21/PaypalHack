import type { ErrorClass } from '@holdfast/shared';
import type {
  AuthorizeRequestId,
  CaptureRequestId,
  OrderRequestId,
  PayoutRequestId,
  VoidRequestId,
} from './ids.js';

/** PayPal authorization `status` values (Payments v2). */
export type AuthorizationStatus =
  | 'CREATED'
  | 'CAPTURED'
  | 'DENIED'
  | 'PARTIALLY_CAPTURED'
  | 'VOIDED'
  | 'PENDING'
  | 'EXPIRED'
  | (string & {});

/** Published sandbox test card. Raw card data only from seed / spike / labelled demo paths. */
export interface TestCard {
  number: string;
  /** `YYYY-MM`. */
  expiry: string;
  security_code: string;
  name: string;
}

/**
 * How the buyer pays for a hold. Bodies follow what S1, S2 and S7 proved.
 * - `wallet`: PayPal approval redirect (`rel=payer-action`), then `authorizeOrder`; vaults on success.
 * - `card_fields`: JS SDK card fields submit the card in the browser (maybe 3DS), then
 *   `authorizeOrder`; `SCA_WHEN_REQUIRED` + `store_in_vault: ON_SUCCESS`.
 * - `card_vault`: a hold from a vaulted card. `CUSTOMER` when the shopper is present, `MERCHANT`
 *   only for rounds auto-raise and roll (S2, S7 step 4).
 * - `wallet_vault`: a hold from a vaulted PayPal wallet, no buyer present (S7 step 4).
 * - `test_card`: raw card (seed, spikes, the labelled "Use sandbox test card" button). Refused
 *   unless the client was built with `allowRawCard` (sandbox only).
 */
export type PaymentSource =
  | { kind: 'wallet'; returnUrl: string; cancelUrl: string; vault?: boolean; brandName?: string }
  | { kind: 'card_fields'; returnUrl: string; cancelUrl: string }
  | { kind: 'card_vault'; vaultId: string; initiator: 'CUSTOMER' | 'MERCHANT' }
  | { kind: 'wallet_vault'; vaultId: string }
  | { kind: 'test_card'; card: TestCard; vault?: boolean };

export interface CreateAuthOrderInput {
  /** `orderRequestId(bid.id)`; also sent as `invoice_id` and `custom_id`. */
  requestId: OrderRequestId;
  amountCents: number;
  paymentSource: PaymentSource;
  description?: string;
}

export interface VaultInfo {
  id: string | null;
  status: string;
}

/**
 * Outcome of order create or authorize, judged by the response **body** (never the HTTP code).
 * Only an authorization with status `CREATED` is `held` (M6).
 * - `unknown`: PayPal never answered after the in-call retries, or the answer needs reconciling
 *   (raw-card replay, duplicate invoice). The caller sets `needs_reconcile` and the sweeper
 *   (HF-034) replays with the **same** request id.
 */
export type HoldResult =
  | {
      kind: 'held';
      orderId: string;
      authorizationId: string;
      /** Authorization `create_time` (D6: hold-age math uses it). */
      authorizedAt: string;
      expiresAt: string | null;
      amountCents: number;
      vault: VaultInfo | null;
    }
  | { kind: 'pending'; orderId: string; authorizationId: string | null; status: string }
  | {
      kind: 'denied';
      orderId: string | null;
      authorizationId: string | null;
      code: string;
      errorClass: 'TERMINAL';
    }
  | { kind: 'needs_approval'; orderId: string; approveUrl: string | null; status: string }
  | { kind: 'unknown'; orderId: string | null; code: string; errorClass: ErrorClass };

/** Values allowed in `PayPal-Mock-Response` (sandbox demo aid, only from `settlements.mock_response`). */
export type MockResponseCode = 'INSTRUMENT_DECLINED' | 'AUTHORIZATION_EXPIRED';

export interface CaptureInput {
  authorizationId: string;
  /** `captureRequestId(settlement.id)`. */
  requestId: CaptureRequestId;
  /** The bid's own amount (INV-5); build with `captureInputFor`. */
  amountCents: number;
  /** From `settlements.mock_response` only; ignored unless mock responses are allowed. */
  mockResponse?: MockResponseCode | null;
}

/**
 * Capture outcome. `reconciled` means a 4xx was resolved by GETting the authorization (B4): a 422
 * "already captured" is a success with the original capture id, never TERMINAL. `alert` flags
 * states a human must look at (capture on a voided authorization).
 */
export type CaptureResult =
  | {
      ok: true;
      captureId: string | null;
      status: string;
      amountCents: number | null;
      reconciled: boolean;
    }
  | {
      ok: false;
      errorClass: ErrorClass;
      code: string;
      http: number;
      authorizationStatus?: AuthorizationStatus;
      alert: boolean;
    };

/**
 * Void outcome; assignable to the money primitives' `PayPalVoidResult` (HF-003a). A replay or a
 * 422 on an already-voided authorization is `ok` (reconciled). A 422 on a captured authorization
 * is RECONCILE + `alert` (money was taken on a loser).
 */
export type VoidResult =
  | { ok: true; status: 'VOIDED'; reconciled: boolean }
  | {
      ok: false;
      errorClass: ErrorClass;
      code: string;
      http: number;
      authorizationStatus?: AuthorizationStatus;
      alert: boolean;
    };

export interface AuthorizationView {
  id: string;
  status: AuthorizationStatus;
  amountCents: number | null;
  createTime: string | null;
  expirationTime: string | null;
  orderId: string | null;
}

export interface CaptureView {
  id: string;
  status: string;
  amountCents: number | null;
  /** The authorization this capture came from (its `rel=up` link), when PayPal says. */
  authorizationId: string | null;
}

export interface OrderView {
  id: string;
  status: string;
  approveUrl: string | null;
  authorizations: AuthorizationView[];
  captures: CaptureView[];
  vault: VaultInfo | null;
}

export interface PayoutInput {
  /** `payoutRequestId(payouts.id)`: also the `sender_batch_id`. */
  attemptId: PayoutRequestId;
  email: string;
  amountCents: number;
  note: string;
  emailSubject?: string;
}

/**
 * `INSUFFICIENT_FUNDS` (S7: 422 at POST, no batch created) is TRANSIENT with
 * `retryWithNewAttempt` + `alert`: retry later under a new attempt id, never mark FAILED.
 */
export type PayoutResult =
  | { ok: true; batchId: string; batchStatus: string }
  | {
      ok: false;
      errorClass: ErrorClass;
      code: string;
      http: number;
      retryWithNewAttempt: boolean;
      alert: boolean;
    };

/** Payout item outcome per features/12: SUCCESS → PAID_OUT; DENIED / UNCLAIMED / … → FAILED. */
export type PayoutItemOutcome = 'SUCCESS' | 'FAILED' | 'PENDING';

export interface PayoutItemView {
  itemId: string;
  batchId: string | null;
  transactionStatus: string;
  outcome: PayoutItemOutcome;
  errorName: string | null;
  amountCents: number | null;
  feeCents: number | null;
}

export interface PayoutBatchView {
  batchId: string;
  senderBatchId: string | null;
  batchStatus: string;
  amountCents: number | null;
  feesCents: number | null;
  items: PayoutItemView[];
}

/** Webhook signature headers PayPal sends (lower-cased keys accepted). */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

/**
 * The PayPal client every money path shares (HF-014a bids, HF-029 settlement, HF-032 payouts,
 * HF-034 crons). `PayPalRestClient` talks to PayPal; `FakePayPal().client` is the same class over
 * an in-memory PayPal (`PAYPAL_MODE=stub`).
 *
 * Every mutating call takes its branded request id as a required argument (D5, INV-4).
 */
export interface PayPalClient {
  createAuthOrder(input: CreateAuthOrderInput): Promise<HoldResult>;
  authorizeOrder(orderId: string, requestId: AuthorizeRequestId): Promise<HoldResult>;
  capture(input: CaptureInput): Promise<CaptureResult>;
  void(authorizationId: string, requestId: VoidRequestId): Promise<VoidResult>;
  getAuthorization(authorizationId: string): Promise<AuthorizationView>;
  getOrder(orderId: string): Promise<OrderView>;
  payout(input: PayoutInput): Promise<PayoutResult>;
  getPayoutBatch(batchId: string): Promise<PayoutBatchView>;
  getPayoutItem(itemId: string): Promise<PayoutItemView>;
  verifyWebhook(headers: WebhookHeaders, rawBody: string): Promise<boolean>;
}
