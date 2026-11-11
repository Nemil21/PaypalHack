import type { FastifyInstance } from 'fastify';
import {
  cancelBid,
  cancelBidResponse,
  getBidDetail,
  listMyBids,
  type MoneyDeps,
} from '@holdfast/core';
import { ApiError } from '../http/errors.js';

export interface MyBidRoutesDeps {
  /** Database, PayPal client (void) and audit hook; the same deps the bid service uses. */
  money: MoneyDeps;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unknown, malformed and other shoppers' ids all answer 404 (never 403). */
function bidIdOf(params: unknown): string {
  const id = (params as { id?: string }).id ?? '';
  if (!UUID.test(id)) throw new ApiError('NOT_FOUND', 'Bid not found.');
  return id;
}

/**
 * HF-016 shopper bid routes (api.md): `POST /api/bids/:id/cancel`, `GET /api/bids/mine` and
 * `GET /api/bids/:id`. Shopper session required; everything is owner-scoped.
 *
 * Cancel is naturally idempotent (a second cancel returns the current state) and still runs inside
 * HF-003b's `idempotent()` store like every mutating route.
 */
export function registerMyBidRoutes(app: FastifyInstance, deps: MyBidRoutesDeps): void {
  app.post(
    '/api/bids/:id/cancel',
    { onRequest: app.guards.requireShopper },
    app.idempotent(async (req) => {
      const id = (req.params as { id?: string }).id ?? '';
      if (!UUID.test(id)) return cancelBidResponse({ ok: false, error: { code: 'NOT_FOUND' } });
      const shopperId = req.auth.shopper!.id;
      return cancelBidResponse(await cancelBid(deps.money, { bidId: id, shopperId }));
    }),
  );

  app.get('/api/bids/mine', { onRequest: app.guards.requireShopper }, async (req) =>
    listMyBids(deps.money.db.pool, req.auth.shopper!.id),
  );

  app.get('/api/bids/:id', { onRequest: app.guards.requireShopper }, async (req) => {
    const detail = await getBidDetail(
      deps.money.db.pool,
      req.auth.shopper!.id,
      bidIdOf(req.params),
    );
    if (!detail) throw new ApiError('NOT_FOUND', 'Bid not found.');
    return detail;
  });
}
