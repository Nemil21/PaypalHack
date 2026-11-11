import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  clearListing,
  errorBody,
  idempotent,
  isUuid,
  shouldStoreResponse,
  type ClearListingDeps,
  type ClearListingError,
  type IdempotentResponse,
} from '@holdfast/core';
import { clearListingRequestSchema } from '@holdfast/shared';

/**
 * Who is calling. HF-006 owns sessions and guards; this route only needs the resolved principal.
 * Clear is a brand-only money decision: never a shopper, an agent, an MCP client or a VIEWER.
 */
export interface SessionPrincipal {
  type: 'BRAND_USER' | 'SHOPPER' | 'MCP_CLIENT' | 'BUYER_AGENT' | 'BRAND_AGENT' | 'SYSTEM';
  id: string;
  brandId?: string | null;
  role?: 'OWNER' | 'MANAGER' | 'VIEWER' | null;
}

export interface ClearRouteDeps {
  money: ClearListingDeps;
  /**
   * Resolve the session principal; null when unauthenticated. Default: the HF-006 brand session
   * (`requireBrandUser()` runs first; the role check below turns a VIEWER away with 403).
   */
  authenticate?(req: FastifyRequest): Promise<SessionPrincipal | null> | SessionPrincipal | null;
}

/** The brand session HF-006's `requireBrandUser()` loaded onto the request. */
function sessionPrincipal(req: FastifyRequest): SessionPrincipal | null {
  const user = req.auth?.brandUser;
  return user ? { type: 'BRAND_USER', id: user.id, brandId: user.brandId, role: user.role } : null;
}

type ClearRequest = FastifyRequest<{ Params: { id: string } }>;

const CLEAR_ROLES = new Set(['OWNER', 'MANAGER']);

const CONFLICT_MESSAGES: Record<string, string> = {
  NOT_CLEARABLE: 'This listing can no longer be cleared.',
  BOOK_CHANGED: 'The book changed since you reviewed it. Check the new numbers and confirm again.',
  HOLDS_TOO_OLD: "A winner's hold is too old to capture safely.",
  AMOUNT_MISMATCH: "A winner's hold does not match their bid.",
  CONCURRENT_UPDATE: 'A bid changed while clearing. Try again.',
};

function errorResponse(error: ClearListingError): IdempotentResponse {
  switch (error.code) {
    case 'NOT_FOUND':
      return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
    case 'VALIDATION_ERROR':
      return {
        status: 422,
        body: errorBody('VALIDATION_ERROR', error.message, {
          field: 'quantity',
          maxQuantity: error.maxQuantity,
        }),
      };
    case 'STATE_CONFLICT': {
      const { code: _code, reason, ...details } = error;
      return {
        status: 409,
        body: errorBody('STATE_CONFLICT', CONFLICT_MESSAGES[reason] ?? reason, {
          reason,
          ...details,
        }),
      };
    }
  }
}

/**
 * 409s depend on the book at that moment (BOOK_CHANGED, a concurrent update), so they are not
 * stored: a retry runs again. A 202 is stored and replayed (M3).
 */
const storeClearResponse = (r: IdempotentResponse) => r.status !== 409 && shouldStoreResponse(r);

/** `POST /api/listings/:id/clear` (api.md, features/10, HF-027). */
export function registerClearRoute(app: FastifyInstance, deps: ClearRouteDeps): void {
  const principals = new WeakMap<ClearRequest, SessionPrincipal>();

  const handler = idempotent<ClearRequest, FastifyReply>(
    {
      db: deps.money.db,
      principal: (req) => {
        const p = principals.get(req);
        return p ? { type: 'BRAND_USER', id: p.id } : null;
      },
      store: storeClearResponse,
    },
    async (req) => {
      const principal = principals.get(req)!;
      if (!isUuid(req.params.id)) {
        return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
      }
      const body = clearListingRequestSchema.safeParse(req.body);
      if (!body.success) {
        return {
          status: 400,
          body: errorBody('VALIDATION_ERROR', 'Invalid clear request.', {
            issues: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          }),
        };
      }
      const key = req.headers['idempotency-key'];
      const outcome = await clearListing(deps.money, {
        listingId: req.params.id,
        brandId: principal.brandId!,
        quantity: body.data.quantity,
        expectedGrossCents: body.data.expectedGrossCents,
        actor: { type: 'BRAND_USER', id: principal.id },
        idempotencyKey: typeof key === 'string' ? key : null,
      });
      if (!outcome.ok) return errorResponse(outcome.error);
      outcome.released.catch((err: unknown) =>
        req.log.warn({ err: (err as Error).message }, 'HOLD_AGED release failed; left for sweeper'),
      );
      return { status: 202, body: outcome.response };
    },
  );

  const authenticate = deps.authenticate ?? sessionPrincipal;
  // Without a custom `authenticate`, the session guard answers 401 before the body is parsed.
  const opts = deps.authenticate ? {} : { onRequest: app.guards.requireBrandUser() };

  app.post<{ Params: { id: string } }>('/api/listings/:id/clear', opts, async (req, reply) => {
    const principal = await authenticate(req);
    if (!principal) {
      return reply.code(401).send(errorBody('UNAUTHENTICATED', 'Sign in to continue.'));
    }
    if (
      principal.type !== 'BRAND_USER' ||
      !principal.brandId ||
      !principal.role ||
      !CLEAR_ROLES.has(principal.role)
    ) {
      return reply
        .code(403)
        .send(errorBody('FORBIDDEN', 'Only a brand owner or manager can clear.'));
    }
    principals.set(req, principal);
    return handler(req, reply);
  });
}
