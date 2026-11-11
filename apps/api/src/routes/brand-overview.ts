import type { FastifyInstance } from 'fastify';
import { brandOverview, type Db } from '@holdfast/core';

/**
 * `GET /api/brands/me/overview` (HF-026; api.md, screens.md §W04). Brand only, any role. The
 * brand comes from the session, so there is no id to tamper with; every read is tenant-scoped.
 */
export function registerBrandOverviewRoutes(app: FastifyInstance, db: Db): void {
  app.get(
    '/api/brands/me/overview',
    { onRequest: app.guards.requireBrandUser() },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return brandOverview(db.pool, req.auth.brandUser!.brandId);
    },
  );
}
