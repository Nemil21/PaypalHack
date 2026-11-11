import type { FastifyInstance } from 'fastify';
import {
  NotFoundError,
  SimulateQuantityError,
  loadBook,
  simulateListing,
  type Db,
} from '@holdfast/core';
import { simulateQuerySchema } from '@holdfast/shared';
import { ApiError, parse } from '../http/errors.js';

type ListingParams = { Params: { id: string } };

/**
 * `GET /api/listings/:id/book` and `GET /api/listings/:id/simulate?quantity=` (HF-022, api.md).
 * Brand only, any role (VIEWER reads the console). The brand comes from the session; another
 * brand's listing, or a malformed id, is 404 `NOT_FOUND`.
 */
export function registerBookRoutes(app: FastifyInstance, db: Db): void {
  const notFound = () => new ApiError('NOT_FOUND', 'Listing not found.');
  const guard = { onRequest: app.guards.requireBrandUser() };

  app.get<ListingParams>('/api/listings/:id/book', guard, async (req) => {
    try {
      return await loadBook(db, req.auth.brandUser!.brandId, req.params.id);
    } catch (err) {
      if (err instanceof NotFoundError) throw notFound();
      throw err;
    }
  });

  app.get<ListingParams>('/api/listings/:id/simulate', guard, async (req) => {
    const { quantity } = parse(simulateQuerySchema, req.query, 'simulate query');
    try {
      return await simulateListing(db, req.auth.brandUser!.brandId, req.params.id, quantity);
    } catch (err) {
      if (err instanceof NotFoundError) throw notFound();
      if (err instanceof SimulateQuantityError) {
        throw new ApiError('VALIDATION_ERROR', err.message, {
          field: 'quantity',
          maxQuantity: err.maxQuantity,
        });
      }
      throw err;
    }
  });
}
