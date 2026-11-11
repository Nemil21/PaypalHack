import type { FastifyInstance } from 'fastify';
import {
  processPriceWebhookRow,
  recordChannel3Event,
  recordWebhookEvent,
  verifyChannel3Signature,
  type PriceEventResult,
  type PriceWatchDeps,
  type WebhookEventRow,
} from '@holdfast/core';
import { ApiError } from '../http/errors.js';

export const CHANNEL3_WEBHOOK_PATH = '/api/webhooks/channel3';

export interface Channel3WebhookRouteDeps extends PriceWatchDeps {
  /** `CHANNEL3_WEBHOOK_SECRET` (`whsec_…`, from the Channel3 webhook portal). */
  secret: string | undefined;
  /** How processing is run after the 2xx (default `setImmediate`); tests collect it. */
  schedule?: (run: () => Promise<void>) => void;
  onProcessed?: (eventId: string, result: PriceEventResult) => void;
  /** Test clock for the signature's 5-minute timestamp window. */
  nowMs?: () => number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * What a live delivery may not carry: the stamps our replay (`replayed`, `label`, `detail`) and
 * poll (`data.source`) put on their own rows. A signed body is Channel3's, but it never gets to
 * pose as a replay or bring its own product detail.
 */
function liveOnly(body: Json): Json {
  const { replayed: _r, label: _l, detail: _d, ...rest } = body;
  if (isObj(rest.data) && 'source' in rest.data) {
    const { source: _s, ...data } = rest.data;
    return { ...rest, data };
  }
  return rest;
}

/**
 * `POST /api/webhooks/channel3` (HF-042b; api.md §Webhooks, features/06 §Logic 2):
 *
 * 1. Verify the Standard Webhooks (Svix) signature over the **raw** body with
 *    `CHANNEL3_WEBHOOK_SECRET`, constant time, 5-minute timestamp window. Bad or missing
 *    signature → 401 and nothing stored. No secret configured → 502, so Channel3 retries once it
 *    is set.
 * 2. Insert into `webhook_events` (Channel3's event `id` = PK, stable across retries). Already
 *    processed → 200, nothing else.
 * 3. Answer 200 at once (Channel3 wants a 2xx within 15 s) and process asynchronously through
 *    HF-042a's `processPriceWebhookRow`. A crash or failure leaves `processed_at IS NULL`; the
 *    minute cron or Channel3's retry reprocesses it.
 *
 * Exempt from CSRF, `Idempotency-Key` and the REST rate limit (`isWebhookPath`).
 */
export function registerChannel3WebhookRoute(
  app: FastifyInstance,
  deps: Channel3WebhookRouteDeps,
): void {
  const schedule =
    deps.schedule ??
    ((run: () => Promise<void>) => {
      setImmediate(() => void run());
    });

  void app.register(async (scope) => {
    // Raw body for the signature: it covers the exact bytes Channel3 sent.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post(CHANNEL3_WEBHOOK_PATH, async (req, reply) => {
      if (!deps.secret) {
        req.log.warn('channel3 webhook received but CHANNEL3_WEBHOOK_SECRET is not set');
        throw new ApiError('CHANNEL3_ERROR', 'Webhook verification is not configured.');
      }
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const check = verifyChannel3Signature(
        req.headers as Record<string, string | string[] | undefined>,
        rawBody,
        deps.secret,
        { nowMs: deps.nowMs?.() },
      );
      if (!check.ok) {
        req.log.warn({ reason: check.reason }, 'channel3 webhook signature rejected');
        throw new ApiError('UNAUTHENTICATED', 'Invalid webhook signature.');
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new ApiError('VALIDATION_ERROR', 'Webhook body is not JSON.');
      }
      if (
        !isObj(body) ||
        typeof body.id !== 'string' ||
        !body.id ||
        typeof body.type !== 'string'
      ) {
        throw new ApiError('VALIDATION_ERROR', 'Not a Channel3 webhook event.');
      }
      const payload = liveOnly(body);

      await recordChannel3Event(deps.db.pool);
      const recorded = await recordWebhookEvent(deps.db.pool, {
        id: body.id,
        provider: 'CHANNEL3',
        eventType: body.type,
        payload,
      });
      if (recorded.status === 'DUPLICATE') return reply.code(200).send({ received: true });

      const row: WebhookEventRow = recorded.event;
      schedule(async () => {
        try {
          const result = await processPriceWebhookRow(deps, row);
          deps.onProcessed?.(row.id, result);
          req.log.info(
            { eventId: row.id, outcome: result.outcome, released: result.released.length },
            'channel3 webhook processed',
          );
        } catch (err) {
          // The row stays unprocessed with last_error; the cron or a redelivery retries it.
          req.log.warn(
            { eventId: row.id, err: (err as Error).message },
            'channel3 webhook processing failed',
          );
          deps.onError?.(err, { eventId: row.id, step: 'process' });
        }
      });
      return reply.code(200).send({ received: true });
    });
  });
}
