import Fastify, { type FastifyInstance } from 'fastify';
import type { Config, Db } from '@holdfast/core';
import { createGuards, registerAuth, Sessions, type McpTokenVerifier } from './auth/guards.js';
import { registerAuthRoutes, type MagicLinkSender } from './auth/routes.js';
import { registerHealthz, type Pingable } from './healthz.js';
import { assertSameOrigin } from './http/csrf.js';
import { registerErrorHandler } from './http/errors.js';
import { registerIdempotency, type IdempotencyLayer } from './http/idempotency.js';
import { isCsrfAndKeyExempt, isMutating, isRestLimited, pathOf } from './http/paths.js';
import { applyRateDecision, RateLimiter } from './http/rate-limit.js';
import { loggerOptions } from './http/redact.js';
import { registerClearRoute, type ClearRouteDeps } from './routes/clear.js';
import { DEFAULT_WEB_DIST, registerWebApp } from './web.js';

export interface ServerDeps {
  /** Postgres pool (or anything with `query`). `/healthz` answers 503 without one. */
  db?: Pingable;
  /** Transactional database for sessions, sign-in and every feature route (HF-006 onwards). */
  sql?: Db;
  /** Built SPA to serve (default `apps/web/dist`); `null` serves none. */
  webDistDir?: string | null;
  /** `POST /api/listings/:id/clear` (HF-027); mounted once auth (HF-006) and PayPal (HF-004) are wired. */
  clear?: ClearRouteDeps;
  /** Shared rate limiter (one web instance). Tests pass their own. */
  limiter?: RateLimiter;
  /** MCP token lookup (HF-043). Without it every MCP call is 401. */
  mcpTokens?: McpTokenVerifier;
  /** HF-003b's idempotency store. Without it the key is required but nothing is stored. */
  idempotency?: IdempotencyLayer;
  /** Magic-link delivery (default: printed locally; email in HF-054b). */
  sendMagicLink?: MagicLinkSender;
}

/**
 * Build the Fastify app without listening, so tests can use `app.inject()`.
 * Routes are mounted under `/api`; everything else is the same-origin web SPA (HF-007, M31).
 *
 * Request plumbing (HF-006), in order, for every request:
 *   onRequest  auth reset → REST rate limit (60/min/user) → CSRF Origin check (mutating) →
 *              Idempotency-Key required (mutating) → the route's guard (`app.guards.*`)
 *   preHandler idempotency store (HF-003b), then the handler; errors → api.md envelope.
 */
export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : loggerOptions(config.LOG_LEVEL),
    // Render terminates TLS one proxy hop in front: trust exactly that hop for req.ip / protocol.
    trustProxy:
      config.NODE_ENV === 'production' ? (_addr: string, hop: number) => hop === 0 : false,
  });

  registerErrorHandler(app);

  const limiter = deps.limiter ?? new RateLimiter();
  const sessions = new Sessions(config);
  const guards = createGuards(
    { config, db: deps.sql, limiter, mcpTokens: deps.mcpTokens },
    sessions,
  );
  registerAuth(app, guards);

  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req.url);
    if (
      isRestLimited(path) &&
      !applyRateDecision(reply, limiter.hit('rest', sessions.restKey(req)))
    ) {
      return reply;
    }
    if (isMutating(req.method) && !isCsrfAndKeyExempt(path)) assertSameOrigin(config, req);
  });
  registerIdempotency(app, deps.idempotency);

  app.get('/api/healthz', async () => ({
    status: 'ok',
    paypalMode: config.PAYPAL_MODE,
    paypalSandbox: config.paypalIsSandbox,
    settlementRunner: config.SETTLEMENT_RUNNER,
    demoMode: config.DEMO_MODE,
  }));

  registerHealthz(app, deps.db);
  if (deps.clear) registerClearRoute(app, deps.clear);

  registerAuthRoutes(app, {
    config,
    db: deps.sql,
    guards,
    sessions,
    sendMagicLink: deps.sendMagicLink,
  });

  // Last: its not-found handler serves the SPA for every path no route above claimed.
  registerWebApp(app, config, deps.webDistDir === undefined ? DEFAULT_WEB_DIST : deps.webDistDir);

  return app;
}
