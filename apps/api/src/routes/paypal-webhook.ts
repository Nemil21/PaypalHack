import type { FastifyInstance } from 'fastify';
import {
  parsePayPalEvent,
  processPayPalWebhookRow,
  recordWebhookEvent,
  type PayPalWebhookDeps,
  type PayPalWebhookResult,
  type WebhookEventRow,
  type WebhookHeaders,
} from '@holdfast/core';
import { ApiError } from '../http/errors.js';

export const PAYPAL_WEBHOOK_PATH = '/api/webhooks/paypal';

export interface PayPalWebhookRouteDeps extends PayPalWebhookDeps {
  /**
   * Signature check over the raw body: `paypal.verifyWebhook` (the real
   * `verify-webhook-signature` in deployed envs, `FakePayPal`'s stub in stub mode and tests).
   */
  verify: (headers: WebhookHeaders, rawBody: string) => Promise<boolean>;
  /** How processing is run after the 200 (default `setImmediate`); tests collect it. */
  schedule?: (run: () => Promise<void>) => void;
  onProcessed?: (eventId: string, result: PayPalWebhookResult) => void;
}

/**
 * `POST /api/webhooks/paypal` (HF-033; api.md §Webhooks, features/16 §Acceptance):
 *
 * 1. Verify the signature on the **raw** body (this route keeps the body as a string). Bad or
 *    missing signature → 401. Verification could not run (PayPal down, no `PAYPAL_WEBHOOK_ID`)
 *    → 502, so PayPal redelivers.
 * 2. Insert into `webhook_events` (event id = PK). Already processed → 200, nothing else.
 * 3. Answer 200 at once and process asynchronously. A crash or failure leaves the row with
 *    `processed_at IS NULL`; PayPal's redelivery or the minute cron reprocesses it (M14).
 *
 * Exempt from CSRF, `Idempotency-Key` and the REST rate limit (`isWebhookPath`).
 */
export function registerPayPalWebhookRoute(
  app: FastifyInstance,
  deps: PayPalWebhookRouteDeps,
): void {
  const schedule =
    deps.schedule ??
    ((run: () => Promise<void>) => {
      setImmediate(() => void run());
    });

  void app.register(async (scope) => {
    // Raw body for the signature: PayPal verifies the exact bytes it sent.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post(PAYPAL_WEBHOOK_PATH, async (req, reply) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      let verified: boolean;
      try {
        verified = await deps.verify(req.headers as WebhookHeaders, rawBody);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'paypal webhook verification unavailable');
        throw new ApiError('PAYPAL_ERROR', 'Webhook verification is unavailable.');
      }
      if (!verified) throw new ApiError('UNAUTHENTICATED', 'Invalid webhook signature.');

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new ApiError('VALIDATION_ERROR', 'Webhook body is not JSON.');
      }
      const event = parsePayPalEvent(body);
      if (!event) throw new ApiError('VALIDATION_ERROR', 'Not a PayPal webhook event.');

      const recorded = await recordWebhookEvent(deps.db.pool, {
        id: event.id,
        provider: 'PAYPAL',
        eventType: event.event_type,
        payload: body,
      });
      if (recorded.status === 'DUPLICATE') return reply.code(200).send({ received: true });

      const row: WebhookEventRow = recorded.event;
      schedule(async () => {
        try {
          const result = await processPayPalWebhookRow(deps, row);
          deps.onProcessed?.(row.id, result);
          req.log.info({ eventId: row.id, ...result }, 'paypal webhook processed');
        } catch (err) {
          // The row stays unprocessed with last_error; the cron or a redelivery retries it.
          req.log.warn(
            { eventId: row.id, err: (err as Error).message },
            'paypal webhook processing failed',
          );
          deps.onError?.(err, { eventId: row.id, step: 'process' });
        }
      });
      return reply.code(200).send({ received: true });
    });
  });
}
