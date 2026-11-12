import type { FastifyInstance, FastifyRequest } from 'fastify';
import { advanceShipment, errorBody, type Db } from '@holdfast/core';

/**
 * `POST /api/admin/shipments/:id/advance` (v4 §3.6, decision 3): the Ops console's
 * "MARK DELIVERED (DEMO)". Registered **only when `DEMO_MODE=true`** (like the demo sign-in
 * routes), so it answers 404 otherwise; admin only (`requireAdmin`). `:id` is a shipment id or
 * the winning bid's id. Each call moves the shipment one step:
 * SHIPPED → OUT_FOR_DELIVERY → DELIVERED, audited SHIPMENT_ADVANCED.
 *
 *   200 { from, shipment } · 404 NOT_FOUND
 *   409 STATE_CONFLICT { reason: 'NOT_SHIPPED' | 'ALREADY_DELIVERED', shipment }
 */
export function registerAdminDemoShipmentRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Params: { id: string } }>(
    '/api/admin/shipments/:id/advance',
    { onRequest: app.guards.requireAdmin },
    app.idempotent(async (req) => {
      const { id } = (req as FastifyRequest<{ Params: { id: string } }>).params;
      const out = await advanceShipment(db, id, {
        type: 'ADMIN',
        id: req.auth.brandUser!.id,
      });
      if (!out.ok) {
        if (out.code === 'NOT_FOUND') {
          return { status: 404, body: errorBody('NOT_FOUND', 'No shipment for that id.') };
        }
        return {
          status: 409,
          body: errorBody(
            'STATE_CONFLICT',
            out.reason === 'ALREADY_DELIVERED'
              ? 'This shipment is already delivered.'
              : 'This order has not shipped yet: add tracking first.',
            { reason: out.reason, shipment: out.shipment },
          ),
        };
      }
      return { status: 200, body: { from: out.from, shipment: out.shipment } };
    }),
  );
}
