import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  isValidSubscription,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  pushToRecipient,
  revokePushSubscription,
  savePushSubscription,
  type Db,
  type PushSender,
  type Recipient,
} from '@holdfast/core';
import type { PushMessage } from '@holdfast/shared';
import { envelope } from '../http/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HF-054a in-app notifications (api.md §`/notifications/*`, screens.md W14 bell):
 * `GET /api/notifications`, `POST /api/notifications/:id/read` and
 * `POST /api/notifications/read-all`. The shopper's list by default; `?as=brand` is the signed-in
 * brand user's brand list (any role). The recipient always comes from the session, and another
 * recipient's notification id answers 404 like an unknown one.
 *
 * HF-054b web push: `POST /api/notifications/subscribe` (api.md) stores this browser's push
 * subscription for the session's recipient (a brand device also records the brand user, for the
 * W11 switches); `POST /api/notifications/unsubscribe` revokes it; `POST
 * /api/notifications/push-test` sends one test alert to the caller's own devices (M11 "Send a
 * test"). Without VAPID keys, subscribe and the test answer 409
 * `STATE_CONFLICT` / `PUSH_NOT_CONFIGURED`.
 */
export interface NotificationRouteDeps {
  /** Null / unset: push is off (no VAPID keys). */
  push?: PushSender | null;
  /** Clock for the test-push throttle. */
  now?: () => number;
}

/** One test push per recipient per this long. */
export const PUSH_TEST_GAP_MS = 10_000;

export function registerNotificationRoutes(
  app: FastifyInstance,
  db: Db,
  deps: NotificationRouteDeps = {},
): void {
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

  const push = deps.push ?? null;
  const now = deps.now ?? Date.now;
  const lastTest = new Map<string, number>();
  const pushOff = () => ({
    status: 409,
    body: envelope('STATE_CONFLICT', 'Phone alerts are not set up on this server.', {
      reason: 'PUSH_NOT_CONFIGURED',
    }),
  });

  app.post(
    '/api/notifications/subscribe',
    { onRequest: guard },
    app.idempotent(async (req) => {
      if (!push) return pushOff();
      const sub = (req.body as { subscription?: unknown } | null)?.subscription;
      if (!isValidSubscription(sub)) {
        return {
          status: 400,
          body: envelope('VALIDATION_ERROR', 'That push subscription is not valid.'),
        };
      }
      const r = recipientOf(req);
      const brandUserId = r.type === 'BRAND' ? req.auth.brandUser!.id : null;
      await savePushSubscription(db.pool, r, brandUserId, sub);
      return { status: 200, body: { subscribed: true } };
    }),
  );

  app.post(
    '/api/notifications/unsubscribe',
    { onRequest: guard },
    app.idempotent(async (req) => {
      const endpoint = (req.body as { endpoint?: unknown } | null)?.endpoint;
      if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) {
        return { status: 400, body: envelope('VALIDATION_ERROR', 'endpoint is required.') };
      }
      // Unknown or another recipient's endpoint answers the same: nothing to revoke here.
      await revokePushSubscription(db.pool, recipientOf(req), endpoint);
      return { status: 200, body: { subscribed: false } };
    }),
  );

  app.post(
    '/api/notifications/push-test',
    { onRequest: guard },
    app.idempotent(async (req) => {
      if (!push) return pushOff();
      const r = recipientOf(req);
      const key = `${r.type}:${r.id}`;
      const last = lastTest.get(key);
      if (last !== undefined && now() - last < PUSH_TEST_GAP_MS) {
        return {
          status: 429,
          body: envelope('RATE_LIMITED', 'A test alert was just sent. Try again in a few seconds.'),
        };
      }
      lastTest.set(key, now());
      const message: PushMessage = {
        title: 'Holdfast alerts are on',
        body:
          r.type === 'BRAND'
            ? 'This is how "Window closes in 6 h" will reach this phone.'
            : 'This is how a price drop or a raise prompt will reach this phone.',
        url: r.type === 'BRAND' ? '/brand/notifications' : '/notifications',
        tag: 'push-test',
        template: 'test',
      };
      const out = await pushToRecipient(db.pool, push, r, message);
      return { status: 200, body: { devices: out.devices, sent: out.sent, failed: out.failed } };
    }),
  );
}
