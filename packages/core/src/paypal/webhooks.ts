import { MissingFeatureConfigError } from '../config.js';
import type { PayPalHttp } from './client.js';
import { classifyFailure, PayPalApiError } from './errors.js';
import type { WebhookHeaders } from './types.js';

const SIGNATURE_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

function header(headers: WebhookHeaders, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const v = Array.isArray(value) ? value[0] : value;
    return v?.trim() || undefined;
  }
  return undefined;
}

/**
 * `POST /v1/notifications/verify-webhook-signature`. Returns true only for
 * `verification_status: SUCCESS`; missing signature headers or an unparsable body are false.
 * Not a money mutation, so no `PayPal-Request-Id`. A PayPal outage throws (TRANSIENT) so the
 * webhook handler answers 5xx and PayPal redelivers.
 */
export async function verifyWebhookSignature(
  http: PayPalHttp,
  webhookId: string | undefined,
  headers: WebhookHeaders,
  rawBody: string,
): Promise<boolean> {
  if (!webhookId) throw new MissingFeatureConfigError('PayPal webhooks', ['PAYPAL_WEBHOOK_ID']);
  const fields: Record<string, string> = {};
  for (const [field, name] of Object.entries(SIGNATURE_HEADERS)) {
    const value = header(headers, name);
    if (!value) return false;
    fields[field] = value;
  }
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const res = await http.request(
    'verify_webhook',
    'POST',
    '/v1/notifications/verify-webhook-signature',
    {
      body: { ...fields, webhook_id: webhookId, webhook_event: event },
    },
  );
  if (res.http >= 200 && res.http < 300) return res.json.verification_status === 'SUCCESS';
  const errorClass = classifyFailure('verify_webhook', res);
  if (errorClass === 'TRANSIENT') {
    throw new PayPalApiError(
      'verify_webhook',
      res.http,
      errorClass,
      res.issue ?? 'NETWORK',
      res.debugId,
    );
  }
  return false;
}
