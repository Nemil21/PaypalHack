import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  NotFoundError,
  isUuid,
  loadRoundsActivity,
  nextRound,
  setRoundsTarget,
  startRounds,
  stopRounds,
  type IdempotentResponse,
  type RoundsActor,
  type RoundsDeps,
  type RoundsError,
  type RoundsOutcome,
} from '@holdfast/core';
import {
  roundsNextRequestSchema,
  roundsTargetRequestSchema,
  type RoundsConflictReason,
} from '@holdfast/shared';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { parseCookies } from '../auth/tokens.js';
import { ApiError, envelope, parse } from '../http/errors.js';

/**
 * Live rounds, basic part (HF-036a; api.md §rounds, features/19):
 *   POST  /api/listings/:id/rounds/start  {targetQuantity}
 *   POST  /api/listings/:id/rounds/next   {fromRound?}      ("Next round")
 *   POST  /api/listings/:id/rounds/stop
 *   PATCH /api/listings/:id/rounds        {targetQuantity}
 * Brand OWNER/MANAGER only. Every response is the floor-blind `RoundsState`.
 *
 *   GET   /api/listings/:id/rounds/activity  (HF-037b: the console's raises feed; any brand role)
 */

export type RoundsRouteDeps = RoundsDeps;

const CONFLICT_MESSAGES: Record<RoundsConflictReason, string> = {
  NOT_OPEN: 'Live rounds can only start on an open listing.',
  ROUNDS_ALREADY_STARTED: 'Live rounds already ran on this listing; they start once.',
  ROUNDS_WINDOW_PASSED: 'It is too late to start live rounds on this listing.',
  NOT_IN_ROUNDS: 'This listing is not in live rounds.',
  ROUNDS_ENDED: 'Live rounds have ended; the book is frozen until you clear.',
  ROUND_ADVANCED: 'This round already moved on. Refresh to see the current round.',
};

function errorResponse(error: RoundsError): IdempotentResponse {
  switch (error.code) {
    case 'NOT_FOUND':
      return { status: 404, body: envelope('NOT_FOUND', 'Listing not found.') };
    case 'FORBIDDEN':
      return { status: 403, body: envelope('FORBIDDEN', FORBIDDEN_MESSAGE) };
    case 'VALIDATION_ERROR':
      return {
        status: 422,
        body: envelope('VALIDATION_ERROR', error.message, {
          field: 'targetQuantity',
          maxQuantity: error.maxQuantity,
        }),
      };
    case 'STATE_CONFLICT': {
      const { code: _code, reason, ...details } = error;
      return {
        status: 409,
        body: envelope('STATE_CONFLICT', CONFLICT_MESSAGES[reason], { reason, ...details }),
      };
    }
  }
}

function respond(outcome: RoundsOutcome): IdempotentResponse {
  return outcome.ok ? { status: 200, body: outcome.state } : errorResponse(outcome.error);
}

const FORBIDDEN_MESSAGE = 'Only a brand owner or manager can run live rounds.';

type Req = FastifyRequest<{ Params: { id: string } }>;

export function registerRoundsRoutes(app: FastifyInstance, deps: RoundsRouteDeps): void {
  const brandManager = app.guards.requireBrandUser('MANAGER');

  /**
   * Brand OWNER/MANAGER session (HF-006). A caller holding some other credential (a shopper
   * session, which is also how the buyer agent acts, or an MCP bearer token) is refused with 403
   * rather than 401: they are signed in, just not allowed. Any brand session cookie, even an
   * expired or invalid one, keeps the 401 so the console sends a brand manager back to sign in
   * (one browser often holds both a brand and a shopper session). The brand agent never reaches
   * HTTP; the core refuses any actor that is not a brand OWNER/MANAGER.
   */
  async function requireRoundsRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await brandManager(req, reply);
    } catch (err) {
      const cookies = parseCookies(req.headers.cookie);
      const otherCredential =
        cookies[BRAND_COOKIE] === undefined &&
        (!!req.headers.authorization || !!cookies[SHOPPER_COOKIE]);
      if (err instanceof ApiError && err.code === 'UNAUTHENTICATED' && otherCredential) {
        throw new ApiError('FORBIDDEN', FORBIDDEN_MESSAGE);
      }
      throw err;
    }
  }

  function context(req: Req) {
    if (!isUuid(req.params.id)) return null;
    const user = req.auth.brandUser!;
    const actor: RoundsActor = { type: 'BRAND_USER', id: user.id, role: user.role };
    return { listingId: req.params.id, brandId: user.brandId, actor };
  }

  const notFound: IdempotentResponse = {
    status: 404,
    body: envelope('NOT_FOUND', 'Listing not found.'),
  };

  app.post<{ Params: { id: string } }>(
    '/api/listings/:id/rounds/start',
    { onRequest: requireRoundsRole },
    app.idempotent(async (req) => {
      const ctx = context(req as Req);
      if (!ctx) return notFound;
      const body = parse(roundsTargetRequestSchema, req.body, 'rounds request');
      return respond(await startRounds(deps, { ...ctx, targetQuantity: body.targetQuantity }));
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/listings/:id/rounds/next',
    { onRequest: requireRoundsRole },
    app.idempotent(async (req) => {
      const ctx = context(req as Req);
      if (!ctx) return notFound;
      const body = parse(roundsNextRequestSchema, req.body ?? {}, 'rounds request');
      return respond(await nextRound(deps, { ...ctx, fromRound: body.fromRound }));
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/listings/:id/rounds/stop',
    { onRequest: requireRoundsRole },
    app.idempotent(async (req) => {
      const ctx = context(req as Req);
      if (!ctx) return notFound;
      return respond(await stopRounds(deps, ctx));
    }),
  );

  app.patch<{ Params: { id: string } }>(
    '/api/listings/:id/rounds',
    { onRequest: requireRoundsRole },
    app.idempotent(async (req) => {
      const ctx = context(req as Req);
      if (!ctx) return notFound;
      const body = parse(roundsTargetRequestSchema, req.body, 'rounds request');
      return respond(await setRoundsTarget(deps, { ...ctx, targetQuantity: body.targetQuantity }));
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/listings/:id/rounds/activity',
    { onRequest: app.guards.requireBrandUser() },
    async (req) => {
      const notFoundError = new ApiError('NOT_FOUND', 'Listing not found.');
      if (!isUuid(req.params.id)) throw notFoundError;
      try {
        return await loadRoundsActivity(deps.db, req.auth.brandUser!.brandId, req.params.id, {
          timing: deps.timing,
        });
      } catch (err) {
        if (err instanceof NotFoundError) throw notFoundError;
        throw err;
      }
    },
  );
}
