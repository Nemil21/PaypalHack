import type { FastifyInstance } from 'fastify';
import { placeBid, placeBidResponse, type PlaceBidDeps } from '@holdfast/core';
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
 * CARD and PAYPAL (card fields, wallet) are HF-014b's two-step flows.
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
}
