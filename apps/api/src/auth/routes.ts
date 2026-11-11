import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isAdminEmail, type Config, type Db } from '@holdfast/core';
import { ApiError, parse } from '../http/errors.js';
import { applyRateDecision, type RateLimiter } from '../http/rate-limit.js';
import type { Guards, Sessions } from './guards.js';
import {
  claimShopperEmail,
  ensureDemoBrandUser,
  ensureDemoShopper,
  isUuid,
  loadBrandUser,
  loadShopper,
  type BrandUserRow,
  type ShopperRow,
} from './store.js';
import { signToken, verifyToken } from './tokens.js';

/**
 * Sign-in endpoints (HF-006):
 *   GET  /api/me                              who am I (brand user, shopper, admin flag); creates nothing
 *   POST /api/auth/logout                     { who?: 'brand' | 'shopper' | 'all' }
 *   POST /api/auth/shopper/magic-link         { email, next? } → 202; link console-logged locally
 *   GET  /api/auth/shopper/magic-link/verify  ?token=…   → 302 to `next` with the shopper cookie
 *   POST /api/auth/demo/brand                 { role?: 'OWNER' | 'VIEWER' }   DEMO_MODE only
 *   POST /api/auth/demo/shopper                                               DEMO_MODE only
 * With `DEMO_MODE=false` the demo routes are not registered at all, so they answer 404.
 * Log in with PayPal (HF-010) adds /api/auth/paypal/* next to these.
 */

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/** Delivers a magic link. Default: print it locally; email arrives with HF-054b. */
export type MagicLinkSender = (email: string, url: string) => Promise<void> | void;

export interface AuthRouteDeps {
  config: Config;
  db?: Db;
  guards: Guards;
  sessions: Sessions;
  limiter: RateLimiter;
  sendMagicLink?: MagicLinkSender;
}

const email = z.string().trim().toLowerCase().email().max(254);

/** Same-origin relative path only (no `//host`, no scheme): no open redirects. */
const nextPath = z
  .string()
  .max(512)
  .regex(/^\/(?![/\\])[^\s]*$/, 'must be a same-origin path')
  .optional();

function brandUserView(u: BrandUserRow, config: Config) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    brand: { id: u.brandId, name: u.brandName, verificationStatus: u.brandVerificationStatus },
    isAdmin: isAdminEmail(config, u.email),
  };
}

function shopperView(s: ShopperRow) {
  return { id: s.id, email: s.email, displayName: s.displayName, provisional: s.email === null };
}

/** Public origin for links: APP_BASE_URL, else the request's own. */
function baseUrl(config: Config, req: FastifyRequest): string {
  return config.APP_BASE_URL?.replace(/\/+$/, '') ?? `${req.protocol}://${req.headers.host}`;
}

function defaultSender(config: Config): MagicLinkSender {
  return (to, url) => {
    if (config.NODE_ENV === 'production') return; // No mailer until HF-054b; never log the link.
    // Deliberately stdout, not the (redacting) logger: locally this *is* the delivery channel.
    console.info(`\n[holdfast] Magic sign-in link for ${to} (valid 15 min):\n  ${url}\n`);
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config, guards, sessions } = deps;
  const send = deps.sendMagicLink ?? defaultSender(config);
  const db = (): Db => {
    if (!deps.db) throw new Error('auth needs a database (ServerDeps.pool)');
    return deps.db;
  };
  /** Magic-link `jti`s already used. In memory: one web instance (see README). */
  const usedLinks = new Map<string, number>();

  app.get('/api/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const brandClaims = sessions.brandClaims(req);
    const shopperClaims = sessions.shopperClaims(req);
    const [brandUser, shopper] = await Promise.all([
      brandClaims && isUuid(brandClaims.sub) ? loadBrandUser(db().pool, brandClaims.sub) : null,
      shopperClaims ? loadShopper(db().pool, shopperClaims.sub) : null,
    ]);
    return {
      brandUser: brandUser ? brandUserView(brandUser, config) : null,
      shopper: shopper ? shopperView(shopper) : null,
      demoMode: config.DEMO_MODE,
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const { who } = parse(
      z.object({ who: z.enum(['brand', 'shopper', 'all']).default('all') }),
      req.body ?? {},
      'body',
    );
    if (who !== 'shopper') sessions.clear(req, reply, 'brand');
    if (who !== 'brand') sessions.clear(req, reply, 'shopper');
    return { signedOut: who };
  });

  app.post(
    '/api/auth/shopper/magic-link',
    { onRequest: guards.ensureShopper },
    async (req, reply) => {
      const body = parse(z.object({ email, next: nextPath }), req.body, 'body');
      // Per-email limit on top of the REST one, so nobody can mail-bomb an address (HF-054b).
      if (!applyRateDecision(reply, deps.limiter.hit('magicLink', body.email))) return reply;
      const token = signToken(config.SESSION_SECRET, 'magic-link', {
        sub: body.email,
        exp: Date.now() + MAGIC_LINK_TTL_MS,
        ext: { shopperId: req.auth.shopper!.id, ...(body.next ? { next: body.next } : {}) },
      });
      const url = `${baseUrl(config, req)}/api/auth/shopper/magic-link/verify?token=${token}`;
      await send(body.email, url);
      // Same answer whether or not the email is known: no account enumeration.
      return reply.code(202).send({ sent: true });
    },
  );

  app.get('/api/auth/shopper/magic-link/verify', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(4096) }), req.query, 'query');
    const claims = verifyToken(config.SESSION_SECRET, 'magic-link', token);
    const now = Date.now();
    for (const [jti, exp] of usedLinks) if (exp <= now) usedLinks.delete(jti);
    if (!claims || usedLinks.has(claims.jti)) {
      throw new ApiError('UNAUTHENTICATED', 'This sign-in link is invalid or has expired.');
    }
    usedLinks.set(claims.jti, claims.exp);
    // The email may only land on the requester's provisional shopper when the *same browser*
    // verifies. Otherwise whoever requested a link for someone else's address would, once the
    // owner clicks it, hold a cookie for a shopper carrying that verified email. Opened elsewhere,
    // the link signs in the email's existing shopper or a new one only this browser gets.
    const requester = claims.ext?.shopperId;
    const sameBrowser = !!requester && sessions.shopperClaims(req)?.sub === requester;
    const shopper = await claimShopperEmail(db(), sameBrowser ? requester : null, claims.sub);
    sessions.setShopper(req, reply, shopper.id);
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(claims.ext?.next ?? '/bids', 302);
  });

  if (!config.DEMO_MODE) return;

  app.post('/api/auth/demo/brand', async (req, reply) => {
    const { role } = parse(
      z.object({ role: z.enum(['OWNER', 'VIEWER']).default('OWNER') }),
      req.body ?? {},
      'body',
    );
    const user = await ensureDemoBrandUser(db(), role, config.PAYPAL_BRAND_EMAIL);
    sessions.setBrand(req, reply, user.id);
    return { brandUser: brandUserView(user, config) };
  });

  app.post('/api/auth/demo/shopper', async (req, reply) => {
    const shopper = await ensureDemoShopper(db().pool);
    sessions.setShopper(req, reply, shopper.id);
    return { shopper: shopperView(shopper) };
  });
}
