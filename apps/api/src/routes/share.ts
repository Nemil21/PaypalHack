import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  errorBody,
  loadWidgetStatus,
  normalizeSource,
  recordOfferClick,
  shareStats,
  type Db,
} from '@holdfast/core';
import { ApiError, parse } from '../http/errors.js';

export interface ShareRoutesDeps {
  db: Db;
}

const slugParams = z.object({ slug: z.string().trim().min(1).max(128) });

const clickBody = z.object({
  source: z.string().trim().min(1).max(64),
  medium: z.string().trim().max(64).nullable().optional(),
});

/**
 * Share links and the embed widget (HF-055; features/14, screens.md §W10).
 *
 *   GET  /api/widget/:slug          public, any origin (CORS `*`, no cookies): `widget.js` polls it
 *                                   once to show "Make an offer" or "Offers closed" (D7).
 *   POST /api/offers/:slug/clicks   shopper cookie (same-origin offer page), Idempotency-Key:
 *                                   one `OFFER_CLICK` per tracked arrival (`utm_source`).
 *   GET  /api/listings/:id/share    brand, any role: clicks, bids and held $ by source.
 *
 * The widget opens `/o/:slug?utm_source=…` in a new tab rather than a modal iframe: PayPal's
 * approval page can't be framed and the SameSite=Lax shopper cookie isn't sent cross-site, so the
 * click is logged by the offer page (first party), not by the brand's page.
 */
export function registerShareRoutes(app: FastifyInstance, deps: ShareRoutesDeps): void {
  app.get('/api/widget/:slug', async (req, reply) => {
    const { slug } = parse(slugParams, req.params, 'params');
    reply.header('Access-Control-Allow-Origin', '*');
    // Brand pages are cached by their CDNs; the button must not say "open" for long after close.
    reply.header('Cache-Control', 'public, max-age=30');
    const status = await loadWidgetStatus(deps.db.pool, slug);
    if (!status) throw new ApiError('NOT_FOUND', 'We could not find this offer.');
    return status;
  });

  app.post(
    '/api/offers/:slug/clicks',
    { onRequest: app.guards.ensureShopper },
    app.idempotent(async (req) => {
      const { slug } = parse(slugParams, req.params, 'params');
      const body = parse(clickBody, req.body, 'click');
      const source = normalizeSource(body.source);
      if (!source) {
        return {
          status: 400,
          body: errorBody('VALIDATION_ERROR', 'The source must be letters, digits, - or _.', {
            field: 'source',
          }),
        };
      }
      const ok = await recordOfferClick(deps.db.pool, {
        slug,
        source,
        medium: body.medium ?? null,
        shopperId: req.auth.shopper!.id,
      });
      if (!ok) {
        return { status: 404, body: errorBody('NOT_FOUND', 'We could not find this offer.') };
      }
      return { status: 201, body: { recorded: true, source } };
    }),
  );

  app.get(
    '/api/listings/:id/share',
    { onRequest: app.guards.requireBrandUser() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      reply.header('Cache-Control', 'no-store');
      const stats = await shareStats(deps.db.pool, req.auth.brandUser!.brandId, id);
      if (!stats) throw new ApiError('NOT_FOUND', 'Listing not found.');
      return stats;
    },
  );
}
