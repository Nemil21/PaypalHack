import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadOffer, type Db } from '@holdfast/core';
import { ApiError, parse } from '../http/errors.js';

export interface OfferRoutesDeps {
  db: Db;
}

/**
 * `GET /api/offers/:slug` (api.md; HF-019). Public. The first visit binds an anonymous shopper to
 * a cookie (`ensureShopper`, D13) so every later bid has a `shopper_id`; `myBid` is that shopper's
 * live bid. The floor is never part of the body (M22, see `loadOffer`).
 */
export function registerOfferRoutes(app: FastifyInstance, deps: OfferRoutesDeps): void {
  app.get('/api/offers/:slug', { onRequest: app.guards.ensureShopper }, async (req, reply) => {
    const { slug } = parse(
      z.object({ slug: z.string().trim().min(1).max(128) }),
      req.params,
      'params',
    );
    reply.header('Cache-Control', 'no-store');
    const view = await loadOffer(deps.db.pool, slug, req.auth.shopper!.id);
    if (!view) throw new ApiError('NOT_FOUND', 'We could not find this offer.');
    return view;
  });
}
