import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  errorBody,
  IDEMPOTENCY_HEADER,
  isAdminEmail,
  loadOnboardingBrand,
  REPLAYED_HEADER,
  runIdempotent,
  upsertPendingBrand,
  type Config,
  type Db,
  type IdempotentResponse,
  type Principal,
} from '@holdfast/core';
import type { Sessions } from '../auth/guards.js';
import { brandUserByEmail, isUuid, loadBrandUser, type BrandUserRow } from '../auth/store.js';
import { ApiError, parse } from '../http/errors.js';

/**
 * W03 brand verification onboarding (HF-011b; features/01 §Logic 2–5, api.md):
 *
 *   GET  /api/brands/verification   → { loginEmail, isAdmin, brand: null | OnboardingBrandView }
 *   POST /api/brands/verification   { name, domain, payoutEmail? }  (Idempotency-Key)
 *        → 201 (created) | 200 (updated / unchanged) { ...OnboardingBrandView, created }
 *        400 VALIDATION_ERROR { field: domain | payoutEmail } · 403 FORBIDDEN (not OWNER)
 *        409 DUPLICATE { field: domain | paypalAccount } (another brand's) · 409 STATE_CONFLICT
 *
 * Callers are either signed in as a brand user or carry HF-010's pending PayPal identity (no
 * `brand_users` row yet). The POST upserts that user's PENDING brand and, in the same response,
 * re-issues the brand session cookie for the OWNER row (and drops the pending one), so brand
 * endpoints work without a second sign-in. The GET does the same for a pending identity whose
 * row already exists (e.g. a reload after the first response's cookie was lost).
 *
 * The payout email is locked to the login email (a PayPal login is a real sandbox account, so a
 * payout can't go UNCLAIMED at a typo). Omitted → the login email; anything else → 400.
 */

export interface BrandVerificationRouteDeps {
  db: Db;
  config: Config;
  sessions: Sessions;
}

interface Caller {
  loginEmail: string;
  payerId: string | null;
  displayName: string | null;
  brandUser: BrandUserRow | null;
  principal: Principal;
}

const bodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain: z.string().trim().min(1).max(260),
  payoutEmail: z.string().trim().toLowerCase().email().max(254).optional(),
});

export function registerBrandVerificationRoutes(
  app: FastifyInstance,
  deps: BrandVerificationRouteDeps,
): void {
  const { db, config, sessions } = deps;

  async function caller(req: FastifyRequest, reply: FastifyReply): Promise<Caller> {
    const claims = sessions.brandClaims(req);
    const user = claims && isUuid(claims.sub) ? await loadBrandUser(db.pool, claims.sub) : null;
    if (user) {
      return {
        loginEmail: user.email.toLowerCase(),
        payerId: null,
        displayName: user.displayName,
        brandUser: user,
        principal: { type: 'BRAND_USER', id: user.id },
      };
    }
    if (claims) sessions.clear(req, reply, 'brand');
    const pending = sessions.pendingBrand(req);
    if (!pending) throw new ApiError('UNAUTHENTICATED', 'Sign in with PayPal first.');
    return {
      loginEmail: pending.email.toLowerCase(),
      payerId: pending.payerId,
      displayName: pending.name,
      brandUser: null,
      // Scoped by the PayPal login email until the OWNER row exists.
      principal: { type: 'BRAND_PENDING', id: pending.email.toLowerCase() },
    };
  }

  /** Swap a pending identity for the brand session of its (now existing) OWNER row. */
  async function promoteSession(req: FastifyRequest, reply: FastifyReply, c: Caller) {
    if (c.brandUser) return c.brandUser;
    const user = await brandUserByEmail(db.pool, c.loginEmail);
    if (!user) return null;
    sessions.setBrand(req, reply, user.id);
    sessions.clear(req, reply, 'brand-pending');
    return user;
  }

  app.get('/api/brands/verification', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const c = await caller(req, reply);
    const user = await promoteSession(req, reply, c);
    const brand = user
      ? await loadOnboardingBrand(db.pool, user.brandId, config.SESSION_SECRET)
      : null;
    return {
      loginEmail: c.loginEmail,
      role: user?.role ?? null,
      isAdmin: isAdminEmail(config, c.loginEmail),
      brand,
    };
  });

  app.post('/api/brands/verification', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const c = await caller(req, reply);
    const body = parse(bodySchema, req.body, 'body');
    const payoutEmail = body.payoutEmail ?? c.loginEmail;
    if (payoutEmail !== c.loginEmail) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Payouts go to the PayPal account you signed in with.',
        { field: 'payoutEmail', reason: 'PAYOUT_EMAIL_LOCKED' },
      );
    }
    const key = req.headers[IDEMPOTENCY_HEADER];
    const outcome = await runIdempotent(
      db,
      {
        principal: c.principal,
        key: String(key),
        route: 'POST /api/brands/verification',
        body: req.body ?? null,
      },
      async (): Promise<IdempotentResponse> => {
        const result = await upsertPendingBrand(db, {
          loginEmail: c.loginEmail,
          payerId: c.payerId,
          displayName: c.displayName,
          name: body.name,
          domain: body.domain,
          payoutEmail,
          secret: config.SESSION_SECRET,
        });
        if (result.ok) {
          return {
            status: result.created ? 201 : 200,
            body: { ...result.brand, created: result.created },
          };
        }
        const e = result.error;
        switch (e.code) {
          case 'VALIDATION_ERROR':
            return {
              status: 400,
              body: errorBody(
                'VALIDATION_ERROR',
                'Enter a website domain like aurelaudio.example.',
                {
                  field: 'domain',
                },
              ),
            };
          case 'FORBIDDEN':
            return {
              status: 403,
              body: errorBody(
                'FORBIDDEN',
                'Only the brand owner can change verification details.',
                {
                  reason: e.reason,
                },
              ),
            };
          case 'STATE_CONFLICT':
            return {
              status: 409,
              body: errorBody(
                'STATE_CONFLICT',
                e.reason === 'BRAND_VERIFIED'
                  ? 'Your brand is already verified; change its details in settings.'
                  : 'This brand was rejected. Contact us to review it.',
                { reason: e.reason, brandId: e.brandId },
              ),
            };
          case 'DUPLICATE':
            return {
              status: 409,
              body: errorBody(
                'DUPLICATE',
                e.field === 'domain'
                  ? `${e.domain} is already claimed by another brand. Contact us if it's yours.`
                  : 'This PayPal account already belongs to another brand.',
                { field: e.field, contact: 'mailto:support@holdfast.example' },
              ),
            };
        }
      },
    );
    if (outcome.kind === 'REPLAYED') reply.header(REPLAYED_HEADER, 'true');
    const res = outcome.response;
    // Executed or replayed: a 2xx means the OWNER row exists now, so the session carries it.
    if (res.status < 300) await promoteSession(req, reply, c);
    return reply.code(res.status).send(res.body);
  });
}
