import { resolveTxt } from 'node:dns/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  acceptInvite,
  BRAND_NOTIFICATION_CHANNELS,
  BRAND_NOTIFICATION_TEMPLATES,
  BRAND_ROLES,
  changeMemberRole,
  changePayoutEmail,
  checkDnsVerification,
  createInvite,
  dnsTxtRecord,
  errorBody,
  isUuid,
  loadNotificationPrefs,
  loadTeam,
  MAX_AUTHORIZED_DOMAINS,
  previewInvite,
  removeMember,
  revokeInvite,
  setAuthorizedDomains,
  updateNotificationPrefs,
  type Config,
  type Db,
  type DnsCheckResult,
  type TeamChangeResult,
  type TxtResolver,
} from '@holdfast/core';
import type { Sessions } from '../auth/guards.js';
import { brandUserByEmail, loadBrandUser } from '../auth/store.js';
import { ApiError, parse } from '../http/errors.js';

/**
 * W11 brand settings (HF-056; features/01 §Logic 4, 7, §Edge cases; screens.md §W11):
 *
 *   GET    /api/brands/me/settings               brand, verification, payout, allowlist, team,
 *                                                my notification switches (any brand role)
 *   POST   /api/brands/me/invites                { role, email? } → 201 { invite, url }   OWNER
 *   DELETE /api/brands/me/invites/:id            revoke                                   OWNER
 *   PATCH  /api/brands/me/team/:userId           { role }                                 OWNER
 *   DELETE /api/brands/me/team/:userId           remove                                   OWNER
 *   PUT    /api/brands/me/authorized-domains     { domains } (≤ 25, D17)                  MANAGER+
 *   PUT    /api/brands/me/notifications          { prefs: { <template>: { EMAIL?, PUSH? } } }
 *   POST   /api/brands/me/payout-account         uses the fresh PayPal re-login           OWNER
 *   POST   /api/brands/verification/check        DNS TXT check, one lookup per brand per 30 s
 *   POST   /api/invites/preview                  { token } → { brandName, role, state }   public
 *   POST   /api/invites/accept                   { token, email? } → joins, brand session
 *
 * Invite tokens travel only in request bodies and the link's `#fragment` (`/brand/join#hfi_…`),
 * never in a URL the server sees, so they can't land in access logs. They are shown once, at
 * creation; only their hash is stored, so the create call is not stored for replay either (a
 * retried create mints a second link, which the OWNER can revoke).
 *
 * The payout account change needs OWNER plus a fresh Log in with PayPal as the new account
 * (`GET /api/auth/paypal/start?purpose=payout`), which leaves a 10-minute sealed cookie bound to
 * the OWNER (`Sessions.payoutReauth`). Payouts already in flight keep the email snapshotted at
 * Clear (`listings.payout_email_snapshot`).
 */

export interface BrandSettingsRouteDeps {
  db: Db;
  config: Config;
  sessions: Sessions;
  /** DNS TXT lookup (default `dns.promises.resolveTxt`); tests pass a mocked resolver. */
  resolveTxt?: TxtResolver;
  /** Minimum gap between two DNS lookups for one brand (default 30 s, features/01). */
  recheckMs?: number;
  now?: () => number;
}

export const DNS_RECHECK_MS = 30_000;
export const INVITE_JOIN_PATH = '/brand/join';

const role = z.enum(BRAND_ROLES);
const token = z.string().trim().min(1).max(200);
const channelFlags = z
  .object(Object.fromEntries(BRAND_NOTIFICATION_CHANNELS.map((c) => [c, z.boolean().optional()])))
  .strict();
const prefsPatch = z
  .object(Object.fromEntries(BRAND_NOTIFICATION_TEMPLATES.map((t) => [t, channelFlags.optional()])))
  .strict();

function origin(config: Config, req: FastifyRequest): string {
  return config.APP_BASE_URL?.replace(/\/+$/, '') ?? `${req.protocol}://${req.headers.host}`;
}

function teamError(r: Exclude<TeamChangeResult, { ok: true }>) {
  switch (r.error.code) {
    case 'FORBIDDEN':
      return new ApiError('FORBIDDEN', 'Only a brand owner can manage the team.', {
        reason: r.error.reason,
      });
    case 'NOT_FOUND':
      return new ApiError('NOT_FOUND', 'That teammate is not on your brand.');
    case 'STATE_CONFLICT':
      return new ApiError('STATE_CONFLICT', 'Your brand needs at least one owner.', {
        reason: r.error.reason,
      });
  }
}

export function registerBrandSettingsRoutes(app: FastifyInstance, deps: BrandSettingsRouteDeps) {
  const { db, config, sessions } = deps;
  const resolve: TxtResolver = deps.resolveTxt ?? ((d) => resolveTxt(d));
  const recheckMs = deps.recheckMs ?? DNS_RECHECK_MS;
  const now = deps.now ?? Date.now;
  /** Last DNS answer per brand (one web instance; see README). */
  const lastCheck = new Map<string, { at: number; result: DnsCheckResult }>();

  const brandOf = (req: FastifyRequest) => req.auth.brandUser!;
  const owner = { onRequest: app.guards.requireBrandUser('OWNER') };
  const anyRole = { onRequest: app.guards.requireBrandUser() };

  // --- Read ----------------------------------------------------------------------------------

  app.get('/api/brands/me/settings', anyRole, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const me = brandOf(req);
    const { rows } = await db.pool.query<{
      id: string;
      name: string;
      domain: string | null;
      payoutEmail: string;
      verificationStatus: string;
      verifiedAt: Date | null;
      authorizedDomains: string[];
    }>(
      `SELECT id, name, domain, payout_email AS "payoutEmail",
              verification_status AS "verificationStatus", verified_at AS "verifiedAt",
              authorized_domains AS "authorizedDomains"
         FROM brands WHERE id = $1`,
      [me.brandId],
    );
    const brand = rows[0];
    if (!brand) throw new ApiError('NOT_FOUND', 'Brand not found.');
    const [team, notifications] = await Promise.all([
      loadTeam(db.pool, me.brandId),
      loadNotificationPrefs(db.pool, me.id),
    ]);
    const isOwner = me.role === 'OWNER';
    const reauth = isOwner ? sessions.payoutReauth(req) : null;
    const last = lastCheck.get(me.brandId);
    return {
      me: { id: me.id, email: me.email, role: me.role },
      brand: {
        id: brand.id,
        name: brand.name,
        domain: brand.domain,
        verificationStatus: brand.verificationStatus,
        verifiedAt: brand.verifiedAt,
        dnsTxtRecord: dnsTxtRecord(config.SESSION_SECRET, brand.id),
        lastDnsCheckAt: last ? new Date(last.at).toISOString() : null,
      },
      payout: {
        email: brand.payoutEmail,
        // The fresh re-login waiting to be confirmed (OWNER only, this user only).
        pendingEmail: reauth && reauth.brandUserId === me.id ? reauth.email : null,
      },
      authorizedDomains: brand.authorizedDomains,
      maxAuthorizedDomains: MAX_AUTHORIZED_DOMAINS,
      // Open invites are an OWNER tool; everyone sees who is on the team.
      team: { members: team.members, invites: isOwner ? team.invites : [] },
      notifications,
    };
  });

  // --- Team (OWNER) ----------------------------------------------------------------------------

  app.post('/api/brands/me/invites', owner, async (req, reply) => {
    const body = parse(
      z.object({
        role: role.default('VIEWER'),
        email: z.string().trim().toLowerCase().email().max(254).optional(),
      }),
      req.body ?? {},
      'body',
    );
    const me = brandOf(req);
    const r = await createInvite(db, {
      brandId: me.brandId,
      actorUserId: me.id,
      role: body.role,
      email: body.email ?? null,
    });
    if (!r.ok) {
      if (r.error.code === 'FORBIDDEN') throw teamError({ ok: false, error: r.error });
      throw new ApiError('DUPLICATE', 'That person is already on your team.', {
        reason: r.error.reason,
      });
    }
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send({
      invite: r.invite,
      // Shown once: the token is not stored, only its hash.
      url: `${origin(config, req)}${INVITE_JOIN_PATH}#${r.token}`,
    });
  });

  app.delete<{ Params: { id: string } }>(
    '/api/brands/me/invites/:id',
    owner,
    app.idempotent(async (req) => {
      const { id } = (req as FastifyRequest<{ Params: { id: string } }>).params;
      const me = brandOf(req);
      if (!isUuid(id)) return { status: 404, body: errorBody('NOT_FOUND', 'Invite not found.') };
      const r = await revokeInvite(db, { brandId: me.brandId, actorUserId: me.id, inviteId: id });
      if (r.ok) return { status: 200, body: { revoked: true } };
      if (r.error.code === 'NOT_FOUND') {
        return { status: 404, body: errorBody('NOT_FOUND', 'Invite not found or already used.') };
      }
      const e = teamError({ ok: false, error: r.error });
      return { status: e.status, body: errorBody(e.code, e.message, e.details) };
    }),
  );

  const teamResponse = (r: TeamChangeResult) => {
    if (r.ok) return { status: 200, body: { changed: r.changed } };
    const e = teamError(r);
    return { status: e.status, body: errorBody(e.code, e.message, e.details) };
  };

  app.patch<{ Params: { userId: string } }>(
    '/api/brands/me/team/:userId',
    owner,
    app.idempotent(async (req) => {
      const { userId } = (req as FastifyRequest<{ Params: { userId: string } }>).params;
      const body = parse(z.object({ role }), req.body, 'body');
      const me = brandOf(req);
      if (!isUuid(userId)) return teamResponse({ ok: false, error: { code: 'NOT_FOUND' } });
      return teamResponse(
        await changeMemberRole(db, {
          brandId: me.brandId,
          actorUserId: me.id,
          userId,
          role: body.role,
        }),
      );
    }),
  );

  app.delete<{ Params: { userId: string } }>(
    '/api/brands/me/team/:userId',
    owner,
    app.idempotent(async (req) => {
      const { userId } = (req as FastifyRequest<{ Params: { userId: string } }>).params;
      const me = brandOf(req);
      if (!isUuid(userId)) return teamResponse({ ok: false, error: { code: 'NOT_FOUND' } });
      return teamResponse(
        await removeMember(db, { brandId: me.brandId, actorUserId: me.id, userId }),
      );
    }),
  );

  // --- Authorized retailers (MANAGER+) ---------------------------------------------------------

  app.put(
    '/api/brands/me/authorized-domains',
    { onRequest: app.guards.requireBrandUser('MANAGER') },
    app.idempotent(async (req) => {
      const body = parse(
        z.object({ domains: z.array(z.string().max(260)).max(100) }),
        req.body,
        'body',
      );
      const me = brandOf(req);
      const r = await setAuthorizedDomains(db, {
        brandId: me.brandId,
        actorUserId: me.id,
        domains: body.domains,
      });
      if (r.ok) {
        return {
          status: 200,
          body: {
            authorizedDomains: r.domains,
            changed: r.changed,
            added: r.added,
            removed: r.removed,
          },
        };
      }
      const e = r.error;
      return {
        status: 400,
        body:
          e.reason === 'TOO_MANY'
            ? errorBody('VALIDATION_ERROR', `Up to ${e.max} retailers.`, {
                field: 'domains',
                reason: e.reason,
                max: e.max,
                count: e.count,
              })
            : errorBody('VALIDATION_ERROR', 'Enter retailer domains like bestbuy.com.', {
                field: 'domains',
                reason: e.reason,
                invalid: e.invalid,
              }),
      };
    }),
  );

  // --- Notifications (any role, own switches) -------------------------------------------------

  app.put('/api/brands/me/notifications', anyRole, async (req) => {
    const body = parse(z.object({ prefs: prefsPatch }), req.body, 'body');
    return {
      notifications: await updateNotificationPrefs(db, brandOf(req).id, body.prefs),
    };
  });

  // --- Payout account (OWNER + re-login) -------------------------------------------------------

  app.post(
    '/api/brands/me/payout-account',
    owner,
    app.idempotent(async (req, reply) => {
      const me = brandOf(req);
      const reauth = sessions.payoutReauth(req);
      if (!reauth || reauth.brandUserId !== me.id) {
        return {
          status: 403,
          body: errorBody(
            'FORBIDDEN',
            'Sign in with PayPal as the new payout account first (valid 10 minutes).',
            { reason: 'REAUTH_REQUIRED' },
          ),
        };
      }
      const r = await changePayoutEmail(db, {
        brandId: me.brandId,
        actorUserId: me.id,
        payoutEmail: reauth.email,
        via: 'paypal_relogin',
      });
      if (!r.ok) {
        return {
          status: 403,
          body: errorBody('FORBIDDEN', 'Only a brand owner can change the payout account.', {
            reason: r.error.reason,
          }),
        };
      }
      // One change per re-login.
      sessions.clear(req, reply, 'payout-reauth');
      return { status: 200, body: { payoutEmail: r.payoutEmail, changed: r.changed } };
    }),
  );

  // --- DNS verification check ------------------------------------------------------------------

  app.post('/api/brands/verification/check', anyRole, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const me = brandOf(req);
    const t = now();
    for (const [k, v] of lastCheck) if (t - v.at >= recheckMs) lastCheck.delete(k);
    const cached = lastCheck.get(me.brandId);
    const fresh = !cached;
    const at = cached?.at ?? t;
    const result =
      cached?.result ??
      (await checkDnsVerification(db, {
        brandId: me.brandId,
        actorUserId: me.id,
        secret: config.SESSION_SECRET,
        resolve,
      }));
    if (!result.ok) {
      if (result.error.code === 'NOT_FOUND') throw new ApiError('NOT_FOUND', 'Brand not found.');
      throw new ApiError(
        'STATE_CONFLICT',
        result.error.reason === 'NO_DOMAIN'
          ? 'Add your website domain first.'
          : 'This brand was rejected. Contact us to review it.',
        { reason: result.error.reason },
      );
    }
    // Only a still-PENDING answer is held for 30 s; VERIFIED is final.
    if (fresh && result.verificationStatus === 'PENDING') {
      lastCheck.set(me.brandId, { at, result });
    }
    return {
      verificationStatus: result.verificationStatus,
      verified: result.verificationStatus === 'VERIFIED',
      lookup: result.lookup,
      domain: result.domain,
      checkedAt: new Date(at).toISOString(),
      nextCheckAt:
        result.verificationStatus === 'PENDING' ? new Date(at + recheckMs).toISOString() : null,
      cached: !fresh,
    };
  });

  // --- Invite links (public preview; accept as the signed-in / PayPal identity) ---------------

  app.post('/api/invites/preview', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = parse(z.object({ token }), req.body, 'body');
    const preview = await previewInvite(db.pool, body.token);
    if (!preview) throw new ApiError('NOT_FOUND', 'This invite link is not valid.');
    return preview;
  });

  /**
   * Who is joining: the brand session's user, else the Log in with PayPal identity (HF-010's
   * pending cookie), else (`DEMO_MODE` only) the email typed on the join page.
   */
  async function joiner(req: FastifyRequest, reply: FastifyReply, demoEmail?: string) {
    const claims = sessions.brandClaims(req);
    const user = claims && isUuid(claims.sub) ? await loadBrandUser(db.pool, claims.sub) : null;
    if (user) return { email: user.email, displayName: user.displayName, payerId: null };
    if (claims) sessions.clear(req, reply, 'brand');
    const pending = sessions.pendingBrand(req);
    if (pending)
      return { email: pending.email, displayName: pending.name, payerId: pending.payerId };
    if (config.DEMO_MODE && demoEmail)
      return { email: demoEmail, displayName: null, payerId: null };
    throw new ApiError('UNAUTHENTICATED', 'Sign in with PayPal to join this brand.');
  }

  app.post('/api/invites/accept', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = parse(
      z.object({ token, email: z.string().trim().toLowerCase().email().max(254).optional() }),
      req.body,
      'body',
    );
    const who = await joiner(req, reply, body.email);
    const r = await acceptInvite(db, { token: body.token, ...who });
    if (!r.ok) {
      switch (r.error.code) {
        case 'NOT_FOUND':
          throw new ApiError('NOT_FOUND', 'This invite link is not valid.');
        case 'STATE_CONFLICT':
          throw new ApiError(
            'STATE_CONFLICT',
            r.error.reason === 'INVITE_USED'
              ? 'This invite link was already used. Ask for a new one.'
              : r.error.reason === 'INVITE_REVOKED'
                ? 'This invite link was cancelled. Ask for a new one.'
                : 'This invite link has expired. Ask for a new one.',
            { reason: r.error.reason },
          );
        case 'FORBIDDEN':
          throw new ApiError('FORBIDDEN', 'This invite is for a different email address.', {
            reason: r.error.reason,
          });
        case 'DUPLICATE':
          throw new ApiError('DUPLICATE', 'This account already belongs to another brand.', {
            reason: r.error.reason,
          });
      }
    }
    const user = (await brandUserByEmail(db.pool, who.email))!;
    sessions.setBrand(req, reply, user.id);
    sessions.clear(req, reply, 'brand-pending');
    return {
      brandUser: {
        id: user.id,
        email: user.email,
        role: user.role,
        brand: { id: user.brandId, name: user.brandName },
      },
      alreadyMember: r.alreadyMember,
    };
  });
}
