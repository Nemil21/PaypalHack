import type { FastifyInstance } from 'fastify';
import {
  errorBody,
  isUuid,
  loadBrandBidView,
  loadSettlementView,
  retrySettlement,
  type Actor,
  type Db,
  type IdempotentResponse,
  type KickSettlement,
  type RetryPayoutOutcome,
} from '@holdfast/core';
import { ApiError } from '../http/errors.js';

/** HF-032 `retryPayout` bound to the PayPal client. */
export type RetryPayout = (input: {
  listingId: string;
  actor: Actor;
}) => Promise<RetryPayoutOutcome>;

export interface SettlementRoutesDeps {
  db: Db;
  /** The settlement runner's kick (HF-030a in-process; HF-030b Workflows). */
  kickSettlement?: KickSettlement;
  /** HF-032 admin payout retry; without it `retry-payout` answers 500. */
  retryPayout?: RetryPayout;
}

type ListingParams = { Params: { id: string } };

/**
 * HF-030a routes (api.md):
 * - `GET /api/listings/:id/settlement`: the `SettlementView` payload (W08, HF-035). Brand users of
 *   the listing's brand, any role; admins (`ADMIN_EMAILS`) read any listing. Otherwise 404.
 * - `GET /api/listings/:id/bids/:bidId` (HF-035): the W08 drawer's brand-scoped bid view
 *   (`forBrand`, no shopper PII). Same access as the settlement view; otherwise 404.
 * - `POST /api/admin/listings/:id/retry-settlement`: admin only, audited; makes RETRY rows due and
 *   re-kicks the run. 409 once the listing has left CLEARING (SETTLED and later).
 * - `POST /api/admin/listings/:id/retry-payout` (HF-032): admin only, audited; a new payout
 *   attempt (attempt + 1, new `sender_batch_id`) for a PAYOUT_FAILED listing. 202 with the
 *   attempt; 409 when the listing isn't PAYOUT_FAILED or an attempt is still in flight.
 * - `POST /api/listings/:id/retry-payout` (v4 §3.1): the same retry for the listing brand's OWNER,
 *   rate-limited (`payoutRetry`) and audited as the brand user. Another brand's listing is 404.
 */
export function registerSettlementRoutes(app: FastifyInstance, deps: SettlementRoutesDeps): void {
  const notFound = () => new ApiError('NOT_FOUND', 'Listing not found.');

  app.get<ListingParams>(
    '/api/listings/:id/settlement',
    { onRequest: app.guards.requireBrandUser() },
    async (req) => {
      if (!isUuid(req.params.id)) throw notFound();
      const brandId = req.auth.isAdmin ? null : req.auth.brandUser!.brandId;
      const view = await loadSettlementView(deps.db.pool, req.params.id, brandId);
      if (!view) throw notFound();
      return view;
    },
  );

  app.get<{ Params: { id: string; bidId: string } }>(
    '/api/listings/:id/bids/:bidId',
    { onRequest: app.guards.requireBrandUser() },
    async (req) => {
      const view = await loadBrandBidView(deps.db.pool, {
        brandId: req.auth.isAdmin ? null : req.auth.brandUser!.brandId,
        listingId: req.params.id,
        bidId: req.params.bidId,
      });
      if (!view) throw new ApiError('NOT_FOUND', 'Bid not found.');
      return view;
    },
  );

  app.post(
    '/api/admin/listings/:id/retry-settlement',
    { onRequest: app.guards.requireAdmin },
    app.idempotent(async (req) => {
      const id = (req.params as { id?: string }).id ?? '';
      if (!isUuid(id)) return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
      const out = await retrySettlement(
        { db: deps.db, kickSettlement: deps.kickSettlement },
        { listingId: id, actor: { type: 'ADMIN', id: req.auth.principal?.id } },
      );
      if (out.ok) {
        const { ok: _ok, ...body } = out;
        return { status: 202, body };
      }
      if (out.code === 'NOT_FOUND') {
        return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
      }
      return {
        status: 409,
        body: errorBody('STATE_CONFLICT', 'Settlement can only be retried while clearing.', {
          reason: out.reason,
          status: out.status,
        }),
      };
    }),
  );

  const retryPayoutAs = async (listingId: string, actor: Actor): Promise<IdempotentResponse> => {
    if (!deps.retryPayout) {
      return { status: 500, body: errorBody('INTERNAL_ERROR', 'Payouts are not configured.') };
    }
    const out = await deps.retryPayout({ listingId, actor });
    if (out.ok) {
      const { ok: _ok, ...body } = out;
      return { status: 202, body };
    }
    if (out.code === 'NOT_FOUND') {
      return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
    }
    return {
      status: 409,
      body: errorBody(
        'STATE_CONFLICT',
        out.reason === 'PAYOUT_IN_FLIGHT'
          ? 'A payout for this listing is still in flight or already paid.'
          : out.reason === 'NOTHING_TO_PAY'
            ? 'Nothing was captured, so there is nothing to pay.'
            : 'Only a failed payout can be retried.',
        { reason: out.reason, status: out.status },
      ),
    };
  };

  app.post(
    '/api/admin/listings/:id/retry-payout',
    { onRequest: app.guards.requireAdmin },
    app.idempotent(async (req) => {
      const id = (req.params as { id?: string }).id ?? '';
      if (!isUuid(id)) return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
      return retryPayoutAs(id, { type: 'ADMIN', id: req.auth.principal?.id });
    }),
  );

  app.post(
    '/api/listings/:id/retry-payout',
    {
      onRequest: [app.guards.requireBrandUser('OWNER'), app.guards.rateLimit('payoutRetry')],
    },
    app.idempotent(async (req) => {
      const id = (req.params as { id?: string }).id ?? '';
      const user = req.auth.brandUser!;
      const owned =
        isUuid(id) &&
        (
          await deps.db.pool.query(`SELECT 1 FROM listings WHERE id = $1 AND brand_id = $2`, [
            id,
            user.brandId,
          ])
        ).rowCount === 1;
      if (!owned) return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
      return retryPayoutAs(id, { type: 'BRAND_USER', id: user.id });
    }),
  );
}
