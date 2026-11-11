import type { FastifyInstance } from 'fastify';
import {
  errorBody,
  isUuid,
  loadSettlementView,
  retrySettlement,
  type Db,
  type KickSettlement,
} from '@holdfast/core';
import { ApiError } from '../http/errors.js';

export interface SettlementRoutesDeps {
  db: Db;
  /** The settlement runner's kick (HF-030a in-process; HF-030b Workflows). */
  kickSettlement?: KickSettlement;
}

type ListingParams = { Params: { id: string } };

/**
 * HF-030a routes (api.md):
 * - `GET /api/listings/:id/settlement`: the `SettlementView` payload (W08, HF-035). Brand users of
 *   the listing's brand, any role; admins (`ADMIN_EMAILS`) read any listing. Otherwise 404.
 * - `POST /api/admin/listings/:id/retry-settlement`: admin only, audited; makes RETRY rows due and
 *   re-kicks the run. 409 once the listing has left CLEARING (SETTLED and later).
 */
export function registerSettlementRoutes(app: FastifyInstance, deps: SettlementRoutesDeps): void {
  const notFound = () => new ApiError('NOT_FOUND', 'Listing not found.');

  app.get<ListingParams>(
    '/api/listings/:id/settlement',
    { onRequest: app.guards.requireBrandUser() },
    async (req) => {
      if (!isUuid(req.params.id)) throw notFound();
      const brandId = req.auth.isAdmin ? null : req.auth.brandUser!.brandId;
      const view = await loadSettlementView(deps.db.pool, req.params.id, brandId);
      if (!view) throw notFound();
      return view;
    },
  );

  app.post(
    '/api/admin/listings/:id/retry-settlement',
    { onRequest: app.guards.requireAdmin },
    app.idempotent(async (req) => {
      const id = (req.params as { id?: string }).id ?? '';
      if (!isUuid(id)) return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
      const out = await retrySettlement(
        { db: deps.db, kickSettlement: deps.kickSettlement },
        { listingId: id, actor: { type: 'ADMIN', id: req.auth.principal?.id } },
      );
      if (out.ok) {
        const { ok: _ok, ...body } = out;
        return { status: 202, body };
      }
      if (out.code === 'NOT_FOUND') {
        return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
      }
      return {
        status: 409,
        body: errorBody('STATE_CONFLICT', 'Settlement can only be retried while clearing.', {
          reason: out.reason,
          status: out.status,
        }),
      };
    }),
  );
}
