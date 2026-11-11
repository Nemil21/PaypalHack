import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  isChannel3Error,
  searchProducts,
  type Channel3Client,
  type Queryable,
} from '@holdfast/core';
import { ApiError, parse } from '../http/errors.js';

/**
 * `GET /api/products/search?q=` (HF-009, api.md): the Channel3 search proxy for the listing
 * wizard (W05) and shopper-side comparisons. Needs a brand or shopper session; counted against
 * the shared HF-006 REST limit (60/min/user) like every `/api` route. Each call spends one
 * Channel3 search credit. Hits' identities are cached in `products` so listing creation reuses
 * them through the free detail endpoint.
 */

export interface ProductRouteDeps {
  channel3: Channel3Client;
  /** Identity cache for search hits; optional so the route works before a database is wired. */
  db?: Queryable;
}

const querySchema = z.object({
  q: z.string().trim().min(2, 'must be at least 2 characters').max(200),
  limit: z.coerce.number().int().min(1).max(30).optional(),
});

/** Shown on 502 so the wizard can switch to manual GTIN / MPN entry (02 §Edge cases). */
export const CHANNEL3_DOWN_MESSAGE =
  'Product search is unavailable right now. You can enter the GTIN or MPN by hand.';

export function channel3Failure(err: unknown): ApiError {
  return new ApiError('CHANNEL3_ERROR', CHANNEL3_DOWN_MESSAGE, {
    fallback: 'MANUAL_IDENTIFIER',
    ...(isChannel3Error(err) ? { reason: err.kind } : {}),
  });
}

export function registerProductRoutes(app: FastifyInstance, deps: ProductRouteDeps): void {
  const { requireBrandUser, requireShopper } = app.guards;
  const brandUser = requireBrandUser();

  /** A brand session, else a shopper session (provisional shoppers included), else 401. */
  async function requireBrandOrShopper(req: FastifyRequest, reply: FastifyReply) {
    try {
      await brandUser(req, reply);
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'UNAUTHENTICATED')) throw err;
    }
    await requireShopper(req, reply);
  }

  app.get('/api/products/search', { onRequest: requireBrandOrShopper }, async (req) => {
    const { q, limit } = parse(querySchema, req.query, 'search');
    try {
      const results = await searchProducts(deps.channel3, q, {
        ...(limit === undefined ? {} : { limit }),
        brandName: req.auth.brandUser?.brandName ?? null,
        ...(deps.db ? { db: deps.db } : {}),
      });
      return { results };
    } catch (err) {
      if (isChannel3Error(err)) {
        req.log.warn({ channel3: err.kind, http: err.http }, 'channel3 search failed');
        throw channel3Failure(err);
      }
      throw err;
    }
  });
}
