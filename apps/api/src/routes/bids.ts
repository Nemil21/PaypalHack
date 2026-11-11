import type { FastifyInstance } from 'fastify';
import {
  authorizeAndLand,
  bidErrorResponse,
  findBidByOrderId,
  placeBid,
  placeBidResponse,
  recordApprovalCancelled,
  type AuthorizeBidResult,
  type IdempotentResponse,
  type PlaceBidDeps,
} from '@holdfast/core';
import { placeBidRequestSchema } from '@holdfast/shared';
import { parse } from '../http/errors.js';

export interface BidRoutesDeps {
  /** HF-014a bid service: database, PayPal client, audit hook, test-card policy. */
  money: PlaceBidDeps;
}

/**
 * `POST /api/bids` (api.md, features/03 §Logic 4, HF-014a). Shopper session required; the
 * `Idempotency-Key` is scoped to the shopper by HF-003b's store, so a double submit replays the
 * first answer and makes one PayPal order. Declines (`HOLD_FAILED`) and `PAYPAL_ERROR` are not
 * stored: the client mints a new key for a new bid (M3).
 *
 * Offer-page bids: `source = OFFER_PAGE`, the customer is present (`payment_initiator=CUSTOMER`).
 * CARD and PAYPAL (card fields, wallet) are HF-014b's two-step flows: `POST /api/bids` answers
 * `201 PENDING_APPROVAL` with `orderId` (and `approveUrl` for PAYPAL); the browser submits card
 * fields then calls `POST /api/bids/:id/authorize`, or PayPal sends the buyer back to
 * `GET /api/bids/return?token=<orderId>`. Both run `authorizeAndLand`.
 */
export function registerBidRoutes(app: FastifyInstance, deps: BidRoutesDeps): void {
  app.post(
    '/api/bids',
    { onRequest: app.guards.requireShopper },
    app.idempotent(async (req) => {
      const body = parse(placeBidRequestSchema, req.body, 'bid');
      const result = await placeBid(deps.money, {
        shopperId: req.auth.shopper!.id,
        listingId: body.listingId,
        amountCents: body.amountCents,
        paymentMethod: body.paymentMethod,
        releaseIfCheaper: body.releaseIfCheaper ?? true,
        intentId: body.intentId ?? null,
        mandateId: body.mandateId ?? null,
        utmSource: body.utmSource ?? null,
        source: 'OFFER_PAGE',
        initiator: 'CUSTOMER',
        idempotencyKey: req.idempotencyKey!,
      });
      return placeBidResponse(result);
    }),
  );

  app.post(
    '/api/bids/:id/authorize',
    { onRequest: app.guards.requireShopper },
    app.idempotent(async (req) => {
      const { id } = req.params as { id: string };
      const result = await authorizeAndLand(deps.money, {
        bidId: id,
        shopperId: req.auth.shopper!.id,
        via: 'AUTHORIZE',
      });
      return authorizeResponse(result);
    }),
  );

  /**
   * PayPal's `return_url` / `cancel_url` (`?cancelled=1`); PayPal appends `token=<orderId>`. A
   * top-level navigation from PayPal, so no session is required: the unguessable order id names
   * the bid, and authorizing an order its buyer just approved is safe to repeat (`authz-<bidId>`).
   * Always redirects to the bid page: `?held=1`, `?cancelled=1` or `?error=<code>`.
   */
  app.get('/api/bids/return', async (req, reply) => {
    const q = req.query as { token?: unknown; cancelled?: unknown };
    const token = typeof q.token === 'string' && ORDER_ID_RE.test(q.token) ? q.token : null;
    const bid = token ? await findBidByOrderId(deps.money.db.pool, token) : null;
    if (!bid) return reply.redirect('/bids?error=NOT_FOUND', 302);
    const page = `/bids/${encodeURIComponent(bid.id)}`;
    if (q.cancelled !== undefined) {
      await recordApprovalCancelled(deps.money, bid);
      return reply.redirect(`${page}?cancelled=1`, 302);
    }
    const result = await authorizeAndLand(deps.money, { bidId: bid.id, via: 'RETURN' });
    if (result.ok) return reply.redirect(`${page}?held=1`, 302);
    const { body } = bidErrorResponse(result.error);
    const code = (body as { error: { code: string } }).error.code;
    return reply.redirect(`${page}?error=${encodeURIComponent(code)}`, 302);
  });
}

/** PayPal order ids are short upper-case alphanumerics; anything else is not looked up. */
const ORDER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** `200 { bidId, status: "HELD", authorizationId }` (api.md §`POST /bids/:id/authorize`). */
export function authorizeResponse(result: AuthorizeBidResult): IdempotentResponse {
  if (!result.ok) return bidErrorResponse(result.error);
  const { bid } = result;
  return {
    status: 200,
    body: {
      bidId: bid.id,
      status: bid.status,
      amountCents: bid.amount_cents,
      authorizationId: bid.paypal_authorization_id,
      authorizedAt: bid.authorized_at ? bid.authorized_at.toISOString() : null,
    },
  };
}
