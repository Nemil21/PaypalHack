/**
 * Test-only: the HF-033 replay bodies in `fixtures/paypal/webhooks/` (real sandbox capture and
 * authorization resources) with ids swapped for the stub's. Not exported from the package.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FAKE_VALID_WEBHOOK_SIGNATURE } from '../paypal/fake.js';

export type PayPalFixtureName =
  | 'payment.capture.completed'
  | 'payment.capture.denied'
  | 'payment.authorization.voided'
  | 'payment.payoutsbatch.success'
  | 'payment.payoutsbatch.denied';

/** Ids in the recorded sandbox resources (fixtures/paypal/README.md). */
export const SANDBOX_IDS = {
  captureId: '90Y08719AU802670V',
  capturedAuthorizationId: '32L18808C7119720N',
  voidedAuthorizationId: '6P562205412054447',
} as const;

export interface FixtureOverrides {
  /** Event id; default a fresh `WH-…` so each delivery is a new event unless given. */
  eventId?: string;
  authorizationId?: string;
  captureId?: string;
  /** `custom_id` / `invoice_id`. */
  bidId?: string;
  senderBatchId?: string;
  payoutBatchId?: string;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function paypalWebhookFixture(name: PayPalFixtureName, over: FixtureOverrides = {}): Json {
  const url = new URL(`../../../../fixtures/paypal/webhooks/${name}.json`, import.meta.url);
  const body = JSON.parse(readFileSync(url, 'utf8')) as Json;
  body.id = over.eventId ?? `WH-${randomUUID()}`;
  const r = body.resource as Json;
  if (r.batch_header) {
    if (over.senderBatchId) r.batch_header.sender_batch_header.sender_batch_id = over.senderBatchId;
    if (over.payoutBatchId) r.batch_header.payout_batch_id = over.payoutBatchId;
    return body;
  }
  if (over.bidId) {
    r.custom_id = over.bidId;
    r.invoice_id = over.bidId;
  }
  if (body.resource_type === 'authorization') {
    if (over.authorizationId) r.id = over.authorizationId;
  } else {
    if (over.captureId) r.id = over.captureId;
    if (over.authorizationId)
      r.supplementary_data.related_ids.authorization_id = over.authorizationId;
  }
  return body;
}

/** Signature headers the `FakePayPal` verifier accepts (`sig` overrides the signature). */
export function signedHeaders(sig: string = FAKE_VALID_WEBHOOK_SIGNATURE): Record<string, string> {
  return {
    'content-type': 'application/json',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake',
    'paypal-transmission-id': randomUUID(),
    'paypal-transmission-sig': sig,
    'paypal-transmission-time': new Date().toISOString(),
  };
}
