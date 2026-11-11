import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IDEMPOTENCY_HEADER, idempotent, type Db, type IdempotentResponse } from '@holdfast/core';
import { ApiError } from './errors.js';
import { isCsrfAndKeyExempt, isMutating, pathOf } from './paths.js';

/**
 * Idempotency wiring (HF-006 side of M3; the store is HF-003b's `idempotent()` in packages/core).
 *
 * 1. Every mutating `/api` call must carry an `Idempotency-Key` (api.md). A global onRequest hook
 *    answers `400 VALIDATION_ERROR` for a missing or malformed key before any guard or handler
 *    runs, so a route that forgets to opt into the store still can't be called without one.
 *    Exempt: webhooks, `/mcp` (keys per tool call via `runIdempotent`) and the OAuth callback.
 * 2. Routes that change money or state opt into the store with `app.idempotent(handler)`. The
 *    scope is the principal the route's guard authenticated (`req.auth.principal`), so guards
 *    must run first (`onRequest`):
 *
 *      app.post('/api/bids', { onRequest: app.guards.requireShopper },
 *        app.idempotent(async (req) => ({ status: 201, body: await placeBid(...) })));
 *
 * Login endpoints need the header but are not stored: there is no principal yet, and a replayed
 * login could not set a cookie anyway.
 */

/** Same rule as HF-003b's `idempotent()`: printable ASCII, no spaces, 1–255 characters. */
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export type IdempotentHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<IdempotentResponse>;

declare module 'fastify' {
  interface FastifyInstance {
    /** HF-003b's `idempotent()` bound to this app's database and the guard's principal. */
    idempotent(
      handler: IdempotentHandler,
    ): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;
  }
}

export function needsIdempotencyKey(method: string, url: string): boolean {
  const path = pathOf(url);
  return isMutating(method) && path.startsWith('/api/') && !isCsrfAndKeyExempt(path);
}

/** Validate the header; returns the key, or null when the request is safe or exempt. */
export function readIdempotencyKey(req: FastifyRequest): string | null {
  if (!needsIdempotencyKey(req.method, req.url)) return null;
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) {
    // `field` matches HF-003b's `idempotent()` answer, so both layers return the same shape.
    throw new ApiError('VALIDATION_ERROR', 'This request needs an Idempotency-Key header.', {
      field: 'Idempotency-Key',
      issues: [{ path: 'headers.idempotency-key', message: 'is required' }],
    });
  }
  if (!KEY_RE.test(key)) {
    throw new ApiError('VALIDATION_ERROR', 'The Idempotency-Key header is malformed.', {
      field: 'Idempotency-Key',
      issues: [{ path: 'headers.idempotency-key', message: 'must be 1-255 printable characters' }],
    });
  }
  return key;
}

export function registerIdempotency(app: FastifyInstance, db: Db | undefined): void {
  app.addHook('onRequest', async (req) => {
    req.idempotencyKey = readIdempotencyKey(req);
  });
  app.decorate('idempotent', (handler: IdempotentHandler) => {
    if (!db) throw new Error('app.idempotent needs a database (ServerDeps.sql)');
    return idempotent<FastifyRequest, FastifyReply>(
      { db, principal: (req) => req.auth.principal },
      handler,
    );
  });
}
