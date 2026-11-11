import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  errorBody,
  isUuid,
  REPLAYED_EVENT_LABEL,
  replayPriceDrop,
  replayPriceEvent,
  type PriceEventResult,
  type PriceWatchDeps,
  type ReplayResult,
} from '@holdfast/core';

export const REPLAY_PRICE_EVENT_PATH = '/api/admin/replay-price-event';

const dropSchema = z
  .object({
    listingId: z.string(),
    priceCents: z.number().int().positive(),
    domain: z.string().min(1).max(253).optional(),
    url: z.string().url().max(2048).optional(),
    eventId: z.string().min(1).max(200).optional(),
  })
  .strict();

/** A raw Channel3 event body (e.g. `fixtures/channel3/webhooks/offer.price.changed.json` `body`). */
const rawSchema = z
  .object({ event: z.object({ id: z.string().optional(), type: z.string() }).passthrough() })
  .strict();

export function replayResponseBody(result: PriceEventResult) {
  return {
    eventId: result.eventId,
    replayed: result.replayed,
    label: REPLAYED_EVENT_LABEL,
    outcome: result.outcome,
    productId: result.productId,
    cheaper: result.cheaper,
    bestPublicPriceCents: result.bestPublicPriceCents,
    releasedCount: result.released.length,
    released: result.released.map((b) => ({
      bidId: b.bidId,
      listingId: b.listingId,
      amountCents: b.amountCents,
      status: b.status,
    })),
    ignored: result.ignored,
  };
}

/**
 * `POST /api/admin/replay-price-event` (HF-042a; features/06 §Logic 8). Admin only (`ADMIN_EMAILS`).
 * Records the event in `webhook_events` with `replayed = true` and runs the price watcher's own
 * path (`processPriceWebhookRow`), then answers with what it released.
 *
 *   { listingId, priceCents, domain?, url?, eventId? }  a price drop at an allowlisted store
 *   { event: <Channel3 event body> }                    a raw fixture body
 *
 *   200 { eventId, replayed: true, label, outcome, cheaper, releasedCount, released, ignored }
 *   200 { eventId, duplicate: true } (that event id was already processed)
 *   404 NOT_FOUND · 422 VALIDATION_ERROR (bad body, no allowlist, domain not allowlisted)
 */
export function registerAdminPriceEventRoutes(app: FastifyInstance, deps: PriceWatchDeps): void {
  app.post(
    REPLAY_PRICE_EVENT_PATH,
    { onRequest: app.guards.requireAdmin },
    app.idempotent(async (req) => {
      const actor = { type: 'ADMIN', id: req.auth.brandUser!.id };
      const drop = dropSchema.safeParse(req.body);
      let out: ReplayResult;
      if (drop.success) {
        if (!isUuid(drop.data.listingId)) {
          return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
        }
        out = await replayPriceDrop(deps, { ...drop.data, actor });
      } else {
        const raw = rawSchema.safeParse(req.body);
        if (!raw.success) {
          return {
            status: 422,
            body: errorBody(
              'VALIDATION_ERROR',
              'Send { listingId, priceCents } or { event: <Channel3 event> }.',
            ),
          };
        }
        out = await replayPriceEvent(deps, raw.data.event, actor);
      }
      if (!out.ok) {
        switch (out.error.code) {
          case 'NOT_FOUND':
            return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
          case 'NO_ALLOWLIST':
            return {
              status: 422,
              body: errorBody('VALIDATION_ERROR', "The brand's retailer allowlist is empty.", {
                reason: 'NO_ALLOWLIST',
              }),
            };
          case 'DOMAIN_NOT_ALLOWED':
            return {
              status: 422,
              body: errorBody('VALIDATION_ERROR', "That store is not on the brand's allowlist.", {
                reason: 'DOMAIN_NOT_ALLOWED',
                domain: out.error.domain,
              }),
            };
          default:
            return { status: 422, body: errorBody('VALIDATION_ERROR', 'Invalid price.') };
        }
      }
      if (out.duplicate) return { status: 200, body: { eventId: out.eventId, duplicate: true } };
      return { status: 200, body: replayResponseBody(out.result) };
    }),
  );
}
