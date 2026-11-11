import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAdminEmail, type Config, type Db, type Principal } from '@holdfast/core';
import { ApiError } from '../http/errors.js';
import { applyRateDecision, type RateBucket, type RateLimiter } from '../http/rate-limit.js';
import {
  createProvisionalShopper,
  isUuid,
  loadBrandUser,
  loadShopper,
  type BrandRole,
  type BrandUserRow,
  type ShopperRow,
} from './store.js';
import { openPending, sealPending, type PendingBrandIdentity } from './paypal-login.js';
import {
  parseCookies,
  serializeCookie,
  signToken,
  verifyToken,
  type TokenClaims,
} from './tokens.js';

/**
 * Who is calling (HF-006). Guards are Fastify hooks; use them as a route's `onRequest` so they
 * run before body parsing and before `app.idempotent` (HF-003b's store, scoped by the principal):
 *
 *   app.post('/api/listings/:id/clear', { onRequest: app.guards.requireBrandUser('MANAGER') }, …)
 *   app.post('/api/bids', { onRequest: app.guards.requireShopper }, …)
 *   app.get('/api/offers/:slug', { onRequest: app.guards.ensureShopper }, …)
 *   app.route({ url: '/mcp', onRequest: app.guards.requireMcpToken(), … })   // scopes per tool
 *
 * Sessions are HMAC-signed cookies (stateless); the user row is loaded on every guarded request,
 * so a role change or a deleted user takes effect immediately.
 */

export const BRAND_COOKIE = 'hf_brand';
export const SHOPPER_COOKIE = 'hf_shopper';
export const BRAND_SESSION_SEC = 12 * 60 * 60;
export const SHOPPER_SESSION_SEC = 30 * 24 * 60 * 60;
/** Log in with PayPal (HF-010): the OAuth `state` cookie and the pre-brand identity cookie. */
export const LIPP_STATE_COOKIE = 'hf_lipp_state';
export const BRAND_PENDING_COOKIE = 'hf_brand_pending';
export const LIPP_STATE_SEC = 10 * 60;
export const BRAND_PENDING_SEC = BRAND_SESSION_SEC;

export interface McpPrincipal {
  clientId: string;
  shopperId: string;
  scopes: string[];
  /** `mcp_clients.rate_limit_per_min`; can only lower the 30/min MCP limit. */
  rateLimitPerMin?: number;
}

/** HF-043 issues and hashes MCP tokens; it plugs its lookup in here. */
export interface McpTokenVerifier {
  verify(token: string): Promise<McpPrincipal | null>;
}

export interface AuthState {
  brandUser: BrandUserRow | null;
  shopper: ShopperRow | null;
  mcp: McpPrincipal | null;
  isAdmin: boolean;
  /** The principal the route's guard authenticated: idempotency scope and rate-limit key. */
  principal: Principal | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthState;
    /** Validated `Idempotency-Key`, or null on safe / exempt requests (HF-006). */
    idempotencyKey: string | null;
  }
  interface FastifyInstance {
    guards: Guards;
  }
}

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface Guards {
  requireBrandUser(minRole?: BrandRole): Hook;
  requireShopper: Hook;
  requireAdmin: Hook;
  /** Bearer token only; with `scope`, the token must hold it (`/mcp` checks scopes per tool). */
  requireMcpToken(scope?: string): Hook;
  /** Offer-page visit: load the shopper, or create a provisional one bound to a new cookie (D13). */
  ensureShopper: Hook;
  /** Per-principal limit for a bucket, e.g. `rateLimit('agent')` after `requireShopper`. */
  rateLimit(bucket: RateBucket): Hook;
}

export interface AuthDeps {
  config: Config;
  db?: Db;
  limiter: RateLimiter;
  mcpTokens?: McpTokenVerifier;
}

const ROLE_RANK: Record<BrandRole, number> = { VIEWER: 1, MANAGER: 2, OWNER: 3 };

export function emptyAuth(): AuthState {
  return { brandUser: null, shopper: null, mcp: null, isAdmin: false, principal: null };
}

// --- Cookies ---------------------------------------------------------------------------------

function cookieSecure(config: Config, req: FastifyRequest): boolean {
  return config.NODE_ENV === 'production' || req.protocol === 'https';
}

function appendCookie(reply: FastifyReply, cookie: string): void {
  const prev = reply.getHeader('set-cookie');
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev : [String(prev)];
  reply.header('set-cookie', [
    ...list.filter((c) => !c.startsWith(cookie.split('=')[0]! + '=')),
    cookie,
  ]);
}

export class Sessions {
  constructor(private readonly config: Config) {}

  brandClaims(req: FastifyRequest): TokenClaims | null {
    const c = parseCookies(req.headers.cookie)[BRAND_COOKIE];
    return verifyToken(this.config.SESSION_SECRET, 'brand-session', c);
  }

  shopperClaims(req: FastifyRequest): TokenClaims | null {
    const c = parseCookies(req.headers.cookie)[SHOPPER_COOKIE];
    const claims = verifyToken(this.config.SESSION_SECRET, 'shopper-session', c);
    return claims && isUuid(claims.sub) ? claims : null;
  }

  setBrand(req: FastifyRequest, reply: FastifyReply, brandUserId: string): void {
    const token = signToken(this.config.SESSION_SECRET, 'brand-session', {
      sub: brandUserId,
      exp: Date.now() + BRAND_SESSION_SEC * 1000,
    });
    appendCookie(
      reply,
      serializeCookie(BRAND_COOKIE, token, {
        maxAgeSec: BRAND_SESSION_SEC,
        secure: cookieSecure(this.config, req),
      }),
    );
  }

  setShopper(req: FastifyRequest, reply: FastifyReply, shopperId: string): void {
    const token = signToken(this.config.SESSION_SECRET, 'shopper-session', {
      sub: shopperId,
      exp: Date.now() + SHOPPER_SESSION_SEC * 1000,
    });
    appendCookie(
      reply,
      serializeCookie(SHOPPER_COOKIE, token, {
        maxAgeSec: SHOPPER_SESSION_SEC,
        secure: cookieSecure(this.config, req),
      }),
    );
  }

  /**
   * The PayPal identity of a signed-in manager with no `brand_users` row yet (HF-010). HF-011b
   * reads it to create the PENDING brand + OWNER row, then calls `setBrand` and
   * `clear(…, 'brand-pending')`.
   */
  pendingBrand(req: FastifyRequest): PendingBrandIdentity | null {
    const c = parseCookies(req.headers.cookie)[BRAND_PENDING_COOKIE];
    return openPending(this.config.SESSION_SECRET, c);
  }

  setPendingBrand(
    req: FastifyRequest,
    reply: FastifyReply,
    identity: Omit<PendingBrandIdentity, 'exp'>,
  ): void {
    const sealed = sealPending(this.config.SESSION_SECRET, {
      ...identity,
      exp: Date.now() + BRAND_PENDING_SEC * 1000,
    });
    appendCookie(
      reply,
      serializeCookie(BRAND_PENDING_COOKIE, sealed, {
        maxAgeSec: BRAND_PENDING_SEC,
        secure: cookieSecure(this.config, req),
      }),
    );
  }

  /** LIPP `state` (and the same-origin `next` path) for one sign-in attempt, 10 minutes. */
  setLippState(req: FastifyRequest, reply: FastifyReply, state: string, next?: string): void {
    const token = signToken(this.config.SESSION_SECRET, 'paypal-state', {
      sub: state,
      exp: Date.now() + LIPP_STATE_SEC * 1000,
      ...(next ? { ext: { next } } : {}),
    });
    appendCookie(
      reply,
      serializeCookie(LIPP_STATE_COOKIE, token, {
        maxAgeSec: LIPP_STATE_SEC,
        secure: cookieSecure(this.config, req),
      }),
    );
  }

  lippState(req: FastifyRequest): TokenClaims | null {
    const c = parseCookies(req.headers.cookie)[LIPP_STATE_COOKIE];
    return verifyToken(this.config.SESSION_SECRET, 'paypal-state', c);
  }

  clear(
    req: FastifyRequest,
    reply: FastifyReply,
    which: 'brand' | 'shopper' | 'brand-pending' | 'lipp-state',
  ): void {
    const name = {
      brand: BRAND_COOKIE,
      shopper: SHOPPER_COOKIE,
      'brand-pending': BRAND_PENDING_COOKIE,
      'lipp-state': LIPP_STATE_COOKIE,
    }[which];
    appendCookie(
      reply,
      serializeCookie(name, '', { maxAgeSec: 0, secure: cookieSecure(this.config, req) }),
    );
  }

  /** Rate-limit key from the cookies alone (no DB): brand user, else shopper, else client IP. */
  restKey(req: FastifyRequest): string {
    const brand = this.brandClaims(req);
    if (brand) return `brand:${brand.sub}`;
    const shopper = this.shopperClaims(req);
    if (shopper) return `shopper:${shopper.sub}`;
    return `ip:${req.ip}`;
  }
}

// --- Guards ----------------------------------------------------------------------------------

function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1]! : null;
}

export function createGuards(deps: AuthDeps, sessions: Sessions): Guards {
  const { config, limiter } = deps;
  const db = (): Db => {
    if (!deps.db) throw new Error('auth needs a database (ServerDeps.pool)');
    return deps.db;
  };

  async function brandUserOf(req: FastifyRequest, reply: FastifyReply) {
    const claims = sessions.brandClaims(req);
    if (!claims || !isUuid(claims.sub)) return null;
    const user = await loadBrandUser(db().pool, claims.sub);
    if (!user) sessions.clear(req, reply, 'brand');
    return user;
  }

  async function shopperOf(req: FastifyRequest) {
    const claims = sessions.shopperClaims(req);
    return claims ? loadShopper(db().pool, claims.sub) : null;
  }

  const unauthenticated = (what: string) => new ApiError('UNAUTHENTICATED', `Sign in to ${what}.`);

  const requireBrandUser = (minRole?: BrandRole): Hook =>
    async function requireBrandUser(req, reply) {
      const user = await brandUserOf(req, reply);
      if (!user) throw unauthenticated('your brand account');
      if (minRole && ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
        throw new ApiError('FORBIDDEN', 'Your role does not allow this action.', {
          requiredRole: minRole,
        });
      }
      req.auth.brandUser = user;
      req.auth.isAdmin = isAdminEmail(config, user.email);
      req.auth.principal = { type: 'BRAND_USER', id: user.id };
    };

  const requireShopper: Hook = async function requireShopper(req) {
    const shopper = await shopperOf(req);
    if (!shopper) throw unauthenticated('continue');
    req.auth.shopper = shopper;
    req.auth.principal = { type: 'SHOPPER', id: shopper.id };
  };

  const requireAdmin: Hook = async function requireAdmin(req, reply) {
    const user = await brandUserOf(req, reply);
    if (!user) throw unauthenticated('the admin tools');
    if (!isAdminEmail(config, user.email)) {
      throw new ApiError('FORBIDDEN', 'Admins only.');
    }
    req.auth.brandUser = user;
    req.auth.isAdmin = true;
    req.auth.principal = { type: 'BRAND_USER', id: user.id };
  };

  const requireMcpToken = (scope?: string): Hook =>
    async function requireMcpToken(req, reply) {
      // Bearer only: cookies are ignored on /mcp (api.md), so a browser can't be driven into it.
      req.auth = emptyAuth();
      const token = bearerToken(req);
      if (!token) throw new ApiError('UNAUTHENTICATED', 'An MCP bearer token is required.');
      // Throttle guessing per client IP. Checked before the lookup so a throttled IP costs no
      // database query; only a failed lookup counts. Valid tokens are limited per token below.
      const guessKey = `invalid:${req.ip}`;
      if (!applyRateDecision(reply, limiter.peek('mcp', guessKey))) return reply;
      const principal = deps.mcpTokens ? await deps.mcpTokens.verify(token) : null;
      if (!principal) {
        if (!applyRateDecision(reply, limiter.hit('mcp', guessKey))) return reply;
        throw new ApiError('UNAUTHENTICATED', 'The MCP token is invalid or revoked.');
      }
      // 30 calls/min per mcp_clients.id (features/07); the row's own limit can only lower it.
      if (
        !applyRateDecision(reply, limiter.hit('mcp', principal.clientId, principal.rateLimitPerMin))
      ) {
        return reply;
      }
      if (scope && !principal.scopes.includes(scope)) {
        throw new ApiError('FORBIDDEN', `The MCP token lacks the ${scope} scope.`);
      }
      req.auth.mcp = principal;
      req.auth.principal = { type: 'MCP_CLIENT', id: principal.clientId };
    };

  const ensureShopper: Hook = async function ensureShopper(req, reply) {
    const claims = sessions.shopperClaims(req);
    let shopper = claims ? await loadShopper(db().pool, claims.sub) : null;
    if (!shopper) {
      // A valid cookie whose row is gone is recreated under the same id (one row per cookie).
      shopper = await createProvisionalShopper(db().pool, claims?.sub);
      if (!claims) sessions.setShopper(req, reply, shopper.id);
    }
    req.auth.shopper = shopper;
    req.auth.principal = { type: 'SHOPPER', id: shopper.id };
  };

  const rateLimit = (bucket: RateBucket): Hook =>
    async function rateLimit(req, reply) {
      const p = req.auth.principal;
      const key = p ? `${p.type}:${p.id}` : `ip:${req.ip}`;
      if (!applyRateDecision(reply, limiter.hit(bucket, key))) return reply;
    };

  return {
    requireBrandUser,
    requireShopper,
    requireAdmin,
    requireMcpToken,
    ensureShopper,
    rateLimit,
  };
}

/** Decorations and the per-request reset. Call before any route is registered. */
export function registerAuth(app: FastifyInstance, guards: Guards): void {
  app.decorate('guards', guards);
  app.decorateRequest('auth', null as unknown as AuthState);
  app.decorateRequest('idempotencyKey', null);
  app.addHook('onRequest', async (req) => {
    req.auth = emptyAuth();
  });
}
