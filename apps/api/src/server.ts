import Fastify, { type FastifyInstance } from 'fastify';
import type { Config, Db, KickSettlement, RoundsDeps } from '@holdfast/core';
import { createGuards, registerAuth, Sessions, type McpTokenVerifier } from './auth/guards.js';
import { registerAuthRoutes, type MagicLinkSender } from './auth/routes.js';
import { registerHealthz, type Pingable } from './healthz.js';
import { assertSameOrigin } from './http/csrf.js';
import { registerErrorHandler } from './http/errors.js';
import { registerIdempotency } from './http/idempotency.js';
import { isCsrfAndKeyExempt, isMutating, isRestLimited, pathOf } from './http/paths.js';
import { applyRateDecision, RateLimiter } from './http/rate-limit.js';
import { loggerOptions } from './http/redact.js';
import type { ListingEventBus } from './events/bus.js';
import { registerBidRoutes, type BidRoutesDeps } from './routes/bids.js';
import { registerBookRoutes } from './routes/book.js';
import { registerAdminBrandRoutes } from './routes/admin-brands.js';
import { registerClearRoute, type ClearRouteDeps } from './routes/clear.js';
import { registerEventRoutes } from './routes/events.js';
import { registerRoundsRoutes } from './routes/rounds.js';
import { registerSettlementRoutes } from './routes/settlement.js';
import { registerMyBidRoutes } from './routes/my-bids.js';
import { registerOfferRoutes } from './routes/offers.js';
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
  /** `POST /api/bids` (HF-014a): the bid service's PayPal client and policies. */
  bids?: BidRoutesDeps;
  /**
   * Live rounds hooks (HF-036a): `onNudge` (HF-038b's consumer). The rounds routes are mounted
   * whenever `sql` is set.
   */
  rounds?: Omit<RoundsDeps, 'db'>;
  /**
   * Settlement runner (HF-030a): admin retry re-kicks through it. The settlement routes are
   * mounted whenever `sql` is set.
   */
  settlement?: { kick?: KickSettlement };
  /** Shared rate limiter (one web instance). Tests pass their own. */
  limiter?: RateLimiter;
  /** MCP token lookup (HF-043). Without it every MCP call is 401. */
  mcpTokens?: McpTokenVerifier;
  /** Magic-link delivery (default: printed locally; email in HF-054b). */
  sendMagicLink?: MagicLinkSender;
  /** Listing event bus (HF-008): mounts the SSE streams when `sql` is set too. */
  events?: ListingEventBus;
  /** SSE heartbeat interval (default 15 s); tests shorten it. */
  sseHeartbeatMs?: number;
}

/**
 * Build the Fastify app without listening, so tests can use `app.inject()`.
 * Routes are mounted under `/api`; everything else is the same-origin web SPA (HF-007, M31).
 *
 * Request plumbing (HF-006), in order, for every request:
 *   onRequest  auth reset → REST rate limit (60/min/user) → CSRF Origin check (mutating) →
 *              Idempotency-Key required (mutating) → the route's guard (`app.guards.*`)
 *   handler    `app.idempotent(…)` (HF-003b's store) on routes that opt in; errors → api.md envelope.
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
  registerIdempotency(app, deps.sql);

  app.get('/api/healthz', async () => ({
    status: 'ok',
    paypalMode: config.PAYPAL_MODE,
    paypalSandbox: config.paypalIsSandbox,
    settlementRunner: config.SETTLEMENT_RUNNER,
    demoMode: config.DEMO_MODE,
  }));

  registerHealthz(app, deps.db);
  if (deps.clear) registerClearRoute(app, deps.clear);
  if (deps.bids) {
    registerBidRoutes(app, deps.bids);
    // HF-016: cancel, my bids and bid detail share the bid service's deps.
    registerMyBidRoutes(app, deps.bids);
  }
  if (deps.sql) registerBookRoutes(app, deps.sql);
  if (deps.sql) registerRoundsRoutes(app, { ...deps.rounds, db: deps.sql });
  if (deps.events && deps.sql) {
    registerEventRoutes(app, { sql: deps.sql, bus: deps.events, heartbeatMs: deps.sseHeartbeatMs });
  }
  if (deps.sql) registerAdminBrandRoutes(app, deps.sql);
  if (deps.sql) registerOfferRoutes(app, { db: deps.sql });
  if (deps.sql) {
    registerSettlementRoutes(app, { db: deps.sql, kickSettlement: deps.settlement?.kick });
  }

  registerAuthRoutes(app, {
    config,
    db: deps.sql,
    guards,
    sessions,
    limiter,
    sendMagicLink: deps.sendMagicLink,
  });

  // Last: its not-found handler serves the SPA for every path no route above claimed.
  registerWebApp(app, config, deps.webDistDir === undefined ? DEFAULT_WEB_DIST : deps.webDistDir);

  return app;
}
