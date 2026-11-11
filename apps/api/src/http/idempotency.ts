import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';
import { isCsrfAndKeyExempt, isMutating, pathOf } from './paths.js';

/**
 * Idempotency wiring (HF-006 side of M3). Every mutating `/api` call must carry an
 * `Idempotency-Key` (api.md); a missing or malformed key is `400 VALIDATION_ERROR` before any
 * handler runs. Exempt: webhooks, `/mcp` (keys per tool call) and the OAuth callback.
 *
 * The store itself (insert IN_PROGRESS, 409 IN_PROGRESS, 422 IDEMPOTENCY_MISMATCH, replay DONE
 * responses, forget retryable failures) is HF-003b's `idempotent()` in packages/core. It plugs
 * in through `IdempotencyLayer`: its hooks run on every mutating, non-exempt route **after** the
 * route's auth guards, so `idempotencyContext(req)` already knows the principal. Routes with no
 * principal (the login endpoints) need the header but are not stored: a replayed login could not
 * set a cookie anyway.
 */

/** Printable ASCII without spaces, 1–255 characters (a UUID from the web client is typical). */
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export type IdempotencyPrincipalType = 'SHOPPER' | 'BRAND_USER' | 'MCP_CLIENT' | 'AGENT_ACTION';

export interface IdempotencyPrincipal {
  type: IdempotencyPrincipalType;
  id: string;
}

export interface IdempotencyContext {
  key: string;
  principal: IdempotencyPrincipal;
  /** `METHOD /route/:pattern`, so the same key on another route never replays. */
  route: string;
}

/** HF-003b's store, adapted to Fastify hooks. Either hook may send the reply (replay / 409 / 422). */
export interface IdempotencyLayer {
  preHandler(req: FastifyRequest, reply: FastifyReply, ctx: IdempotencyContext): Promise<void>;
  onSend(
    req: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    ctx: IdempotencyContext,
  ): Promise<unknown>;
}

export function needsIdempotencyKey(method: string, url: string): boolean {
  const path = pathOf(url);
  return isMutating(method) && path.startsWith('/api/') && !isCsrfAndKeyExempt(path);
}

/** Validate the header; returns the key, or null when the request is exempt. */
export function readIdempotencyKey(req: FastifyRequest): string | null {
  if (!needsIdempotencyKey(req.method, req.url)) return null;
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) {
    throw new ApiError('VALIDATION_ERROR', 'This request needs an Idempotency-Key header.', {
      issues: [{ path: 'headers.idempotency-key', message: 'is required' }],
    });
  }
  if (!KEY_RE.test(key)) {
    throw new ApiError('VALIDATION_ERROR', 'The Idempotency-Key header is malformed.', {
      issues: [{ path: 'headers.idempotency-key', message: 'must be 1-255 printable characters' }],
    });
  }
  return key;
}

/** Principal for the store, from whatever the route's guard authenticated (null = not stored). */
export function idempotencyContext(req: FastifyRequest): IdempotencyContext | null {
  const key = req.idempotencyKey;
  if (!key) return null;
  // Set by the guard the route used (requireShopper → SHOPPER, requireBrandUser → BRAND_USER …).
  const principal = req.auth.principal;
  if (!principal) return null;
  return { key, principal, route: `${req.method} ${req.routeOptions.url ?? pathOf(req.url)}` };
}

/** Global hooks: the header check at onRequest, the store (if any) around the handler. */
export function registerIdempotency(app: FastifyInstance, layer?: IdempotencyLayer): void {
  app.addHook('onRequest', async (req) => {
    req.idempotencyKey = readIdempotencyKey(req);
  });
  if (!layer) return;
  app.addHook('preHandler', async (req, reply) => {
    const ctx = idempotencyContext(req);
    if (ctx) await layer.preHandler(req, reply, ctx);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const ctx = idempotencyContext(req);
    return ctx ? layer.onSend(req, reply, payload, ctx) : payload;
  });
}
