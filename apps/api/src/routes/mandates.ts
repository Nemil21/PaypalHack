import type { FastifyInstance } from 'fastify';
import {
  createShopperMandate,
  getMandateView,
  listMandates,
  mandateResponse,
  updateShopperMandate,
  type MoneyDeps,
} from '@holdfast/core';
import { createMandateRequestSchema, updateMandateRequestSchema } from '@holdfast/shared';
import { ApiError, parse } from '../http/errors.js';

export interface MandateRoutesDeps {
  /** Database, PayPal client (pause voids) and audit hook; the same deps the bid service uses. */
  money: MoneyDeps;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unknown, malformed and other shoppers' ids all answer 404 (never 403). */
function mandateIdOf(params: unknown): string {
  const id = (params as { id?: string }).id ?? '';
  if (!UUID.test(id)) throw new ApiError('NOT_FOUND', 'Mandate not found.');
  return id;
}

/**
 * HF-017b mandate routes (api.md §Mandates; features/05 §Logic 1, 6): `GET /api/mandates`,
 * `GET /api/mandates/:id`, `POST /api/mandates`, `PATCH /api/mandates/:id` (limits, pause,
 * resume). Shopper session required; everything is owner-scoped. Writes run inside HF-003b's
 * `idempotent()` store, so a double submit (or a retried pause) replays the first answer.
 */
export function registerMandateRoutes(app: FastifyInstance, deps: MandateRoutesDeps): void {
  app.get('/api/mandates', { onRequest: app.guards.requireShopper }, async (req) =>
    listMandates(deps.money.db.pool, req.auth.shopper!.id),
  );

  app.get('/api/mandates/:id', { onRequest: app.guards.requireShopper }, async (req) => {
    const mandate = await getMandateView(
      deps.money.db.pool,
      req.auth.shopper!.id,
      mandateIdOf(req.params),
    );
    if (!mandate) throw new ApiError('NOT_FOUND', 'Mandate not found.');
    return { mandate };
  });

  app.post(
    '/api/mandates',
    { onRequest: app.guards.requireShopper },
    app.idempotent(async (req) => {
      const body = parse(createMandateRequestSchema, req.body, 'mandate');
      return mandateResponse(await createShopperMandate(deps.money, req.auth.shopper!.id, body));
    }),
  );

  app.patch(
    '/api/mandates/:id',
    { onRequest: app.guards.requireShopper },
    app.idempotent(async (req) => {
      const id = mandateIdOf(req.params);
      const body = parse(updateMandateRequestSchema, req.body, 'mandate');
      return mandateResponse(
        await updateShopperMandate(deps.money, req.auth.shopper!.id, id, body),
      );
    }),
  );
}
