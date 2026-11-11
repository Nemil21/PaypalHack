import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
  brandUserByEmail,
  loadBrandUser,
  loadShopper,
  type BrandUserRow,
  type ShopperRow,
} from './store.js';
import { openToken, sealToken } from './tokens.js';
import {
  createPayPalIdentity,
  PayPalLoginError,
  sameState,
  type PayPalIdentity,
} from './paypal-login.js';
import { randomBytes } from 'node:crypto';

/**
 * Sign-in endpoints (HF-006):
 *   GET  /api/me                              who am I (brand user, shopper, admin flag); creates nothing
 *   POST /api/auth/logout                     { who?: 'brand' | 'shopper' | 'all' }
 *   POST /api/auth/shopper/magic-link         { email, next? } → 202; link console-logged locally
 *   GET  /api/auth/shopper/magic-link/verify  ?token=…   → 302 to `next` with the shopper cookie
 *   POST /api/auth/demo/brand                 { role?: 'OWNER' | 'VIEWER' }   DEMO_MODE only
 *   POST /api/auth/demo/shopper               { email? }                      DEMO_MODE only
 *   GET  /api/auth/paypal/start               ?next=/path → 302 to PayPal consent (HF-010)
 *                                             &purpose=payout: W11 payout re-login (HF-056)
 *   GET  /api/auth/paypal/callback            ?code&state | ?error → 302 /brand, /brand/onboarding
 *                                             or /brand/sign-in?error=cancelled|state|failed|unverified
 *                                             (payout re-login: /brand/settings?tab=payout&reauth=…)
 * With `DEMO_MODE=false` the demo routes are not registered at all, so they answer 404.
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
  /** Log in with PayPal (HF-010). Default: `createPayPalIdentity(config)` (`PAYPAL_MODE`). */
  paypalIdentity?: PayPalIdentity;
}

/** W02 error states the sign-in screen reads from `?error=` (HF-010). */
export type LippError = 'cancelled' | 'state' | 'failed' | 'unverified';

/** W11 payout tab `?reauth=` outcomes of a payout re-login (HF-056). */
export type PayoutReauthResult = 'ok' | 'cancelled' | 'failed' | 'unverified' | 'forbidden';
const PAYOUT_TAB = '/brand/settings?tab=payout';
/** The invite join page (HF-056): a new user signing in from it comes back to it. */
const JOIN_PATH = '/brand/join';

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
  const paypal = deps.paypalIdentity ?? createPayPalIdentity(config);

  app.get('/api/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const brandClaims = sessions.brandClaims(req);
    const shopperClaims = sessions.shopperClaims(req);
    const [brandUser, shopper] = await Promise.all([
      brandClaims && isUuid(brandClaims.sub) ? loadBrandUser(db().pool, brandClaims.sub) : null,
      shopperClaims ? loadShopper(db().pool, shopperClaims.sub) : null,
    ]);
    // Signed in with PayPal but not onboarded yet (HF-010): W03 picks up from here (HF-011b).
    const pending = brandUser ? null : sessions.pendingBrand(req);
    return {
      brandUser: brandUser ? brandUserView(brandUser, config) : null,
      pendingBrand: pending
        ? { email: pending.email, name: pending.name, hasPayerId: pending.payerId !== null }
        : null,
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
    if (who !== 'shopper') {
      sessions.clear(req, reply, 'brand');
      sessions.clear(req, reply, 'brand-pending');
    }
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
      const token = sealToken(config.SESSION_SECRET, 'magic-link', {
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
    const claims = openToken(config.SESSION_SECRET, 'magic-link', token);
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

  // --- Log in with PayPal (HF-010) -------------------------------------------------------------

  const callbackUrl = (req: FastifyRequest) => `${baseUrl(config, req)}/api/auth/paypal/callback`;
  const signInError = (reply: FastifyReply, error: LippError) => {
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(`/brand/sign-in?error=${error}`, 302);
  };

  app.get('/api/auth/paypal/start', async (req, reply) => {
    const q = parse(
      z.object({ next: nextPath, purpose: z.enum(['payout']).optional() }),
      req.query ?? {},
      'query',
    );
    const state = randomBytes(24).toString('base64url');
    sessions.setLippState(req, reply, state, q.next, q.purpose);
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(paypal.authorizeUrl({ state, redirectUri: callbackUrl(req) }), 302);
  });

  app.get('/api/auth/paypal/callback', async (req, reply) => {
    const q = parse(
      z.object({
        code: z.string().min(1).max(2048).optional(),
        state: z.string().max(512).optional(),
        error: z.string().max(200).optional(),
      }),
      req.query ?? {},
      'query',
    );
    const expected = sessions.lippState(req);
    // One attempt per state: the cookie goes whatever the outcome.
    sessions.clear(req, reply, 'lipp-state');

    // W11 payout re-login (HF-056): errors land back on the payout tab, not on W02.
    const payout = expected?.ext?.purpose === 'payout';
    const payoutResult = (result: PayoutReauthResult) => {
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(`${PAYOUT_TAB}&reauth=${result}`, 302);
    };
    if (q.error && payout)
      return payoutResult(q.error === 'access_denied' ? 'cancelled' : 'failed');
    if (q.error) return signInError(reply, q.error === 'access_denied' ? 'cancelled' : 'failed');
    if (!expected || !q.state || !sameState(q.state, expected.sub)) {
      req.log.warn({ lipp: { reason: expected ? 'STATE_MISMATCH' : 'NO_STATE_COOKIE' } }, 'lipp');
      return signInError(reply, 'state');
    }
    if (!q.code) return payout ? payoutResult('failed') : signInError(reply, 'failed');

    let identity;
    try {
      identity = await paypal.exchange(q.code);
    } catch (err) {
      if (!(err instanceof PayPalLoginError)) throw err;
      req.log.warn({ lipp: { stage: err.stage, http: err.http, code: err.code } }, 'lipp');
      return payout ? payoutResult('failed') : signInError(reply, 'failed');
    }
    if (payout) {
      if (!identity.emailVerified) return payoutResult('unverified');
      // Only the signed-in OWNER who started it; the brand session itself is left untouched.
      const claims = sessions.brandClaims(req);
      const owner =
        claims && isUuid(claims.sub) ? await loadBrandUser(db().pool, claims.sub) : null;
      if (!owner || owner.role !== 'OWNER') return payoutResult('forbidden');
      sessions.setPayoutReauth(req, reply, {
        brandUserId: owner.id,
        email: identity.email.toLowerCase(),
        payerId: identity.payerId,
      });
      return payoutResult('ok');
    }
    if (!identity.emailVerified) return signInError(reply, 'unverified');

    reply.header('Cache-Control', 'no-store');
    const user = await brandUserByEmail(db().pool, identity.email);
    if (user) {
      sessions.clear(req, reply, 'brand-pending');
      sessions.setBrand(req, reply, user.id);
      if (user.brandVerificationStatus !== 'VERIFIED')
        return reply.redirect('/brand/onboarding', 302);
      return reply.redirect(expected.ext?.next ?? '/brand', 302);
    }
    // Unknown email: identity in the session only; HF-011b creates the brand and OWNER row, or
    // an invite link (HF-056, `/brand/join`) adds the user to an existing brand.
    sessions.clear(req, reply, 'brand');
    sessions.setPendingBrand(req, reply, {
      email: identity.email,
      payerId: identity.payerId,
      name: identity.name,
    });
    return reply.redirect(expected.ext?.next === JOIN_PATH ? JOIN_PATH : '/brand/onboarding', 302);
  });

  if (!config.DEMO_MODE) return;

  app.post('/api/auth/demo/brand', async (req, reply) => {
    const { role } = parse(
      z.object({ role: z.enum(['OWNER', 'VIEWER']).default('OWNER') }),
      req.body ?? {},
      'body',
    );
    const user = await ensureDemoBrandUser(db(), role, config.PAYPAL_BRAND_EMAIL);
    sessions.clear(req, reply, 'brand-pending');
    sessions.setBrand(req, reply, user.id);
    return { brandUser: brandUserView(user, config) };
  });

  // Instant demo sign-in (D13, HF-019): with an email, create or load that shopper at once (the
  // magic link without the round trip); without one, the fixed demo shopper.
  app.post('/api/auth/demo/shopper', async (req, reply) => {
    const body = parse(z.object({ email: email.optional() }), req.body ?? {}, 'body');
    const shopper = body.email
      ? await claimShopperEmail(db(), sessions.shopperClaims(req)?.sub ?? null, body.email)
      : await ensureDemoShopper(db().pool);
    sessions.setShopper(req, reply, shopper.id);
    return { shopper: shopperView(shopper) };
  });
}
