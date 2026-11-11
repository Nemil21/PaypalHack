import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type Db,
  type Recipient,
} from '@holdfast/core';
import { envelope } from '../http/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HF-054a in-app notifications (api.md §`/notifications/*`, screens.md W14 bell):
 * `GET /api/notifications`, `POST /api/notifications/:id/read` and
 * `POST /api/notifications/read-all`. The shopper's list by default; `?as=brand` is the signed-in
 * brand user's brand list (any role). The recipient always comes from the session, and another
 * recipient's notification id answers 404 like an unknown one.
 */
export function registerNotificationRoutes(app: FastifyInstance, db: Db): void {
  const asBrand = (req: FastifyRequest) => (req.query as { as?: string }).as === 'brand';
  const guard = async (req: FastifyRequest, reply: FastifyReply) =>
    asBrand(req)
      ? app.guards.requireBrandUser()(req, reply)
      : app.guards.requireShopper(req, reply);
  const recipientOf = (req: FastifyRequest): Recipient =>
    req.auth.brandUser && asBrand(req)
      ? { type: 'BRAND', id: req.auth.brandUser.brandId }
      : { type: 'SHOPPER', id: req.auth.shopper!.id };

  app.get('/api/notifications', { onRequest: guard }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return listNotifications(db.pool, recipientOf(req));
  });

  app.post(
    '/api/notifications/:id/read',
    { onRequest: guard },
    app.idempotent(async (req) => {
      const id = (req.params as { id?: string }).id ?? '';
      const out = UUID.test(id) ? await markNotificationRead(db.pool, recipientOf(req), id) : null;
      return out
        ? { status: 200, body: out }
        : { status: 404, body: envelope('NOT_FOUND', 'Notification not found.') };
    }),
  );

  app.post(
    '/api/notifications/read-all',
    { onRequest: guard },
    app.idempotent(async (req) => ({
      status: 200,
      body: await markAllNotificationsRead(db.pool, recipientOf(req)),
    })),
  );
}
