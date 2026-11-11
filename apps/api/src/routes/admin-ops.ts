import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AUDIT_SEARCH_MAX_LIMIT,
  errorBody,
  readOpsHealth,
  searchAudit,
  voidDangling,
  type Db,
  type PayPalTokenProbe,
  type SweepDeps,
} from '@holdfast/core';
import { parse } from '../http/errors.js';

export interface AdminOpsRouteDeps {
  db: Db;
  /** `PAYPAL_MODE`, shown on the PayPal tile. */
  paypalMode: string;
  /** Mints / reuses the PayPal OAuth token (`paypalTokenProbe(client)`). Without it the tile is red. */
  paypalToken?: PayPalTokenProbe;
  /** The hold sweeper's deps (HF-034). Without them `void-dangling` is not mounted. */
  sweep?: SweepDeps;
}

const uuid = z.string().uuid();
const auditQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    brandId: uuid.optional(),
    listingId: uuid.optional(),
    entity: z.string().trim().min(1).max(40).optional(),
    action: z.string().trim().min(1).max(80).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    beforeId: z
      .string()
      .regex(/^\d{1,19}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_SEARCH_MAX_LIMIT).optional(),
  })
  .strict();

/**
 * W20 ops routes (HF-058; api.md §Ops). Admin only (`ADMIN_EMAILS`, D13): anyone else gets
 * 401 / 403 from `requireAdmin`. The other W20 actions are mounted by their own tickets:
 * verify brand (HF-011a), retry settlement (HF-030a), replay price event (HF-042a).
 *
 *   GET  /api/admin/audit?q&brandId&listingId&entity&action&from&to&beforeId&limit
 *        → { rows, nextBeforeId }; `q` is a PayPal id, a request id, or a brand / listing /
 *          entity UUID (see `searchAudit`)
 *   GET  /api/admin/health → `OpsHealth` (always 200; `status: 'degraded'` turns tiles red)
 *   POST /api/admin/void-dangling → 200 { result, ms }: one HF-034 hold-sweeper pass, now, under
 *        the sweeper's own lock · 409 STATE_CONFLICT { reason: 'SWEEP_RUNNING' }
 */
export function registerAdminOpsRoutes(app: FastifyInstance, deps: AdminOpsRouteDeps): void {
  app.get('/api/admin/audit', { onRequest: app.guards.requireAdmin }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = parse(auditQuerySchema, req.query, 'query');
    return searchAudit(deps.db.pool, {
      ...query,
      from: query.from ? new Date(query.from) : null,
      to: query.to ? new Date(query.to) : null,
    });
  });

  app.get('/api/admin/health', { onRequest: app.guards.requireAdmin }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readOpsHealth({
      db: deps.db.pool,
      paypalMode: deps.paypalMode,
      paypalToken: deps.paypalToken,
    });
  });

  const sweep = deps.sweep;
  if (sweep) {
    app.post(
      '/api/admin/void-dangling',
      { onRequest: app.guards.requireAdmin },
      app.idempotent(async (req) => {
        const out = await voidDangling(sweep, { type: 'ADMIN', id: req.auth.brandUser!.id });
        if (!out.ran) {
          return {
            status: 409,
            body: errorBody('STATE_CONFLICT', 'The hold sweeper is already running. Try again.', {
              reason: 'SWEEP_RUNNING',
            }),
          };
        }
        return { status: 200, body: { result: out.result, ms: out.ms } };
      }),
    );
  }
}
