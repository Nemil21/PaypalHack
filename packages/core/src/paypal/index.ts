import { mockDeclinesAllowed, type Config } from '../config.js';
import { PayPalRestClient, type PayPalLogger } from './client.js';
import { FakePayPal } from './fake.js';
import type { PayPalClient } from './types.js';

export * from './types.js';
export * from './errors.js';
export {
  orderRequestId,
  authorizeRequestId,
  captureRequestId,
  payoutRequestId,
  trackRequestId,
  type OrderRequestId,
  type AuthorizeRequestId,
  type CaptureRequestId,
  type PayoutRequestId,
  type TrackRequestId,
  type AnyRequestId,
} from './ids.js';
export {
  PayPalHttp,
  PayPalRestClient,
  redact,
  issueOf,
  type PayPalHttpOptions,
  type PayPalRestClientOptions,
  type PayPalLogEntry,
  type PayPalLogger,
  type PayPalResponse,
} from './client.js';
export {
  captureInputFor,
  judgeHold,
  paymentSourceBody,
  type CaptureBidRow,
  type CaptureSettlementRow,
} from './orders.js';
export { payoutAmount, payoutItemOutcome } from './payouts.js';
export { PAYPAL_CARRIERS, paypalCarrier, trackerIdFor } from './tracking.js';
export {
  FakePayPal,
  FAKE_PAYPAL_BASE,
  FAKE_VALID_WEBHOOK_SIGNATURE,
  type FakeCall,
  type FakeFault,
  type FakeOp,
  type FakePayPalOptions,
} from './fake.js';

let sharedFake: FakePayPal | undefined;

/** The process-wide `FakePayPal` used when `PAYPAL_MODE=stub` (dev seeds share its state). */
export function sharedFakePayPal(): FakePayPal {
  sharedFake ??= new FakePayPal({ latencyMs: 5 });
  return sharedFake;
}

export interface CreatePayPalClientOptions {
  logger?: PayPalLogger;
  /** Use this fake in stub mode instead of the shared one. */
  fake?: FakePayPal;
}

/**
 * The PayPal client for this process. `PAYPAL_MODE=stub` → the real client over `FakePayPal`;
 * otherwise REST against `PAYPAL_API_BASE`. Raw test cards are allowed only on a sandbox base;
 * `PayPal-Mock-Response` only when `mockDeclinesAllowed(config)` (sandbox + DEMO_MODE +
 * ALLOW_MOCK_DECLINE).
 */
export function createPayPalClient(
  config: Config,
  opts: CreatePayPalClientOptions = {},
): PayPalClient {
  const allowMockResponse = mockDeclinesAllowed(config);
  if (config.PAYPAL_MODE === 'stub') {
    return (opts.fake ?? sharedFakePayPal()).client({
      allowMockResponse,
      sleep: undefined,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
  }
  return new PayPalRestClient({
    baseUrl: config.PAYPAL_API_BASE,
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
    webhookId: config.PAYPAL_WEBHOOK_ID,
    allowRawCard: config.paypalIsSandbox,
    allowMockResponse,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}
