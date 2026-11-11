import type { FastifyInstance } from 'fastify';
import { brandOrderTimeline, shopperOrderTimeline, type Db } from '@holdfast/core';
import { ApiError } from '../http/errors.js';

type IdParams = { Params: { id: string } };

/**
 * Order-status timeline facts (HF-060 part 2; shared `orderTimeline()` turns them into phases):
 *   - `GET /api/listings/:id/timeline`: brand, any role (W06 console, W09 payouts);
 *   - `GET /api/bids/:id/order-timeline`: the shopper who owns the bid (W15).
 * Unknown, malformed and other tenants' ids all answer 404 `NOT_FOUND`.
 */
export function registerOrderTimelineRoutes(app: FastifyInstance, db: Db): void {
  app.get<IdParams>(
    '/api/listings/:id/timeline',
    { onRequest: app.guards.requireBrandUser() },
    async (req) => {
      const facts = await brandOrderTimeline(db.pool, req.auth.brandUser!.brandId, req.params.id);
      if (!facts) throw new ApiError('NOT_FOUND', 'Listing not found.');
      return facts;
    },
  );

  app.get<IdParams>(
    '/api/bids/:id/order-timeline',
    { onRequest: app.guards.requireShopper },
    async (req) => {
      const facts = await shopperOrderTimeline(db.pool, req.auth.shopper!.id, req.params.id);
      if (!facts) throw new ApiError('NOT_FOUND', 'Bid not found.');
      return facts;
    },
  );
}
