import Fastify, { type FastifyInstance } from 'fastify';
import {
  createChannel3Client,
  type CancelListingDeps,
  type Channel3Client,
  type Config,
  type Db,
  type KickSettlement,
  type PriceWatchDeps,
  type RoundsDeps,
  verifyMcpToken,
} from '@holdfast/core';
import { createGuards, registerAuth, Sessions, type McpTokenVerifier } from './auth/guards.js';
import type { PayPalIdentity } from './auth/paypal-login.js';
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
import { registerBrandOverviewRoutes } from './routes/brand-overview.js';
import { registerAdminBrandRoutes } from './routes/admin-brands.js';
import { registerBrandVerificationRoutes } from './routes/brand-verification.js';
import { registerAdminPriceEventRoutes } from './routes/admin-price-events.js';
import {
  registerChannel3WebhookRoute,
  type Channel3WebhookRouteDeps,
} from './routes/channel3-webhook.js';
import { registerClearRoute, type ClearRouteDeps } from './routes/clear.js';
import { registerEventRoutes } from './routes/events.js';
import { registerListingRoutes } from './routes/listings.js';
import { registerRoundsRoutes } from './routes/rounds.js';
import { registerSettlementRoutes, type RetryPayout } from './routes/settlement.js';
import { registerMandateRoutes } from './routes/mandates.js';
import { registerMyBidRoutes } from './routes/my-bids.js';
import { registerOfferRoutes } from './routes/offers.js';
import {
  registerPayPalWebhookRoute,
  type PayPalWebhookRouteDeps,
} from './routes/paypal-webhook.js';
import { registerProductRoutes } from './routes/products.js';
import { registerAgentRoutes, type AgentRoutesDeps } from './routes/agent.js';
import { registerMcpClientRoutes } from './routes/mcp-clients.js';
import { registerMcpRoute, type McpRouteDeps } from './mcp/route.js';
import { createMcpHandler } from './mcp/server.js';
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
   * Settlement runner (HF-030a): admin retry re-kicks through it. `retryPayout` (HF-032) backs
   * the admin payout retry; without it that route answers 500. The settlement routes are mounted
   * whenever `sql` is set.
   */
  settlement?: { kick?: KickSettlement; retryPayout?: RetryPayout };
  /** Shared rate limiter (one web instance). Tests pass their own. */
  limiter?: RateLimiter;
  /**
   * MCP token lookup (HF-043). Default with `sql`: `mcp_clients` by token hash. Without either,
   * every MCP call is 401.
   */
  mcpTokens?: McpTokenVerifier;
  /**
   * `/mcp` (HF-043 auth + scope gate). Default with `bids`: the HF-044a MCP server
   * (`mcp/server.ts`); tests may pass their own `handler`.
   */
  mcp?: McpRouteDeps;
  /** Magic-link delivery (default: printed locally; email in HF-054b). */
  sendMagicLink?: MagicLinkSender;
  /** Log in with PayPal (HF-010). Default: from `PAYPAL_MODE` (stub or sandbox REST). */
  paypalIdentity?: PayPalIdentity;
  /** Listing event bus (HF-008): mounts the SSE streams when `sql` is set too. */
  events?: ListingEventBus;
  /** SSE heartbeat interval (default 15 s); tests shorten it. */
  sseHeartbeatMs?: number;
  /** Listing cancel (HF-012b): the PayPal void port and audit hook. Without it cancel is not mounted. */
  listings?: { money?: CancelListingDeps };
  /** Channel3 client (HF-009). Default: `createChannel3Client(config)` (`CHANNEL3_MODE`). */
  channel3?: Channel3Client;
  /** `POST /api/webhooks/paypal` (HF-033): verifier and processor deps. Not mounted without it. */
  paypalWebhooks?: PayPalWebhookRouteDeps;
  /**
   * Buyer agent (HF-039): the Claude model (null without `ANTHROPIC_API_KEY`: every turn shows
   * the fallback). Mounted with `bids`, whose bid service executes confirmed actions.
   */
  agent?: Omit<AgentRoutesDeps, 'money' | 'channel3'>;
  /**
   * Price watcher (HF-042a): mounts `POST /api/admin/replay-price-event`, and (HF-042b) the live
   * `POST /api/webhooks/channel3` verified with `CHANNEL3_WEBHOOK_SECRET`. Not mounted without it.
   */
  priceWatch?: PriceWatchDeps;
  /** Test overrides for the Channel3 webhook route (secret, schedule, clock). */
  channel3Webhook?: Partial<Omit<Channel3WebhookRouteDeps, keyof PriceWatchDeps>>;
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
  const sql = deps.sql;
  const mcpTokens: McpTokenVerifier | undefined =
    deps.mcpTokens ?? (sql ? { verify: (token) => verifyMcpToken(sql.pool, token) } : undefined);
  const guards = createGuards({ config, db: sql, limiter, mcpTokens }, sessions);
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
    // HF-017b: mandate settings; pause releases holds through the same PayPal client.
    registerMandateRoutes(app, deps.bids);
  }
  if (deps.sql) registerBookRoutes(app, deps.sql);
  if (deps.sql) registerBrandOverviewRoutes(app, deps.sql);
  if (deps.sql) registerRoundsRoutes(app, { ...deps.rounds, db: deps.sql });
  if (deps.events && deps.sql) {
    registerEventRoutes(app, { sql: deps.sql, bus: deps.events, heartbeatMs: deps.sseHeartbeatMs });
  }
  if (deps.sql) registerAdminBrandRoutes(app, deps.sql);
  if (deps.paypalWebhooks) registerPayPalWebhookRoute(app, deps.paypalWebhooks);
  // W03 onboarding (HF-011b): upserts the PENDING brand and re-issues the brand session.
  if (deps.sql) registerBrandVerificationRoutes(app, { db: deps.sql, config, sessions });
  if (deps.priceWatch) {
    registerAdminPriceEventRoutes(app, deps.priceWatch);
    registerChannel3WebhookRoute(app, {
      ...deps.priceWatch,
      secret: config.CHANNEL3_WEBHOOK_SECRET,
      ...deps.channel3Webhook,
    });
  }
  if (deps.sql) registerOfferRoutes(app, { db: deps.sql });
  // W19 tokens and `/mcp` (HF-043): bearer token only, scopes checked per tool.
  if (deps.sql) registerMcpClientRoutes(app, { db: deps.sql });
  // HF-044a: the MCP server runs on the bid service's deps; without them, the placeholder.
  registerMcpRoute(
    app,
    deps.mcp ??
      (deps.bids
        ? {
            handler: createMcpHandler({
              money: deps.bids.money,
              appBaseUrl: config.APP_BASE_URL,
            }),
          }
        : {}),
  );
  if (deps.sql) {
    registerSettlementRoutes(app, {
      db: deps.sql,
      kickSettlement: deps.settlement?.kick,
      retryPayout: deps.settlement?.retryPayout,
    });
  }
  const channel3 =
    deps.channel3 ??
    createChannel3Client(config, {
      logger: (entry) => app.log.info({ channel3: entry }, 'channel3'),
    });
  registerProductRoutes(app, { channel3, ...(deps.sql ? { db: deps.sql.pool } : {}) });
  if (deps.sql) registerListingRoutes(app, { db: deps.sql, channel3, money: deps.listings?.money });
  if (deps.bids) {
    registerAgentRoutes(app, { model: null, ...deps.agent, channel3, money: deps.bids.money });
  }

  registerAuthRoutes(app, {
    config,
    db: deps.sql,
    guards,
    sessions,
    limiter,
    sendMagicLink: deps.sendMagicLink,
    paypalIdentity: deps.paypalIdentity,
  });

  // Last: its not-found handler serves the SPA for every path no route above claimed.
  registerWebApp(app, config, deps.webDistDir === undefined ? DEFAULT_WEB_DIST : deps.webDistDir);

  return app;
}
