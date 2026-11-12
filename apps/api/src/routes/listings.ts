import type { FastifyInstance } from 'fastify';
import {
  cancelListing,
  createListing,
  errorBody,
  isUuid,
  listBrandListings,
  publishListing,
  raiseListingQuantity,
  type CancelListingDeps,
  type CancelListingError,
  type IdempotentResponse,
  type ListingDeps,
  type ListingError,
  type RaiseQuantityError,
} from '@holdfast/core';
import {
  createListingRequestSchema,
  updateListingRequestSchema,
  LISTING_STATUSES,
  listingConsolePathOf,
  listListingsQuerySchema,
} from '@holdfast/shared';
import { ApiError, parse } from '../http/errors.js';

/**
 * Brand listings API (HF-012a; api.md §`POST /listings`, §`/publish`, features/02 §Logic 5).
 *
 *   POST /api/listings               OWNER/MANAGER, Idempotency-Key → 201 DRAFT + slug
 *   POST /api/listings/:id/publish   OWNER/MANAGER, Idempotency-Key → 200 OPEN + every D6 deadline
 *   GET  /api/listings               any brand user; the session brand's listings (`forBrand`)
 *   POST /api/listings/:id/cancel    OWNER/MANAGER, Idempotency-Key → 202 CANCELLED; voids run in
 *                                    the background (HF-012b; mounted when `money` is set)
 *   PATCH /api/listings/:id          OWNER/MANAGER, Idempotency-Key → 200; quantity up while OPEN,
 *                                    either way while DRAFT (v4 draft Edit)
 *
 * The brand id always comes from the session. Another brand's listing answers 404.
 */
export interface ListingRouteDeps extends ListingDeps {
  /** PayPal void port + audit for cancel (HF-012b). Without it the cancel route is not mounted. */
  money?: CancelListingDeps;
}

export function cancelErrorResponse(error: CancelListingError): IdempotentResponse {
  if (error.code === 'NOT_FOUND') {
    return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
  }
  return {
    status: 409,
    body: errorBody(
      'STATE_CONFLICT',
      'Only an open listing or one in live rounds can be cancelled.',
      {
        reason: error.reason,
        status: error.status,
      },
    ),
  };
}

export function raiseQuantityErrorResponse(error: RaiseQuantityError): IdempotentResponse {
  switch (error.code) {
    case 'NOT_FOUND':
      return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
    case 'VALIDATION_ERROR': {
      const { code, ...details } = error;
      return {
        status: 400,
        body: errorBody(
          code,
          `Quantity can only go up (currently ${error.currentQuantity}).`,
          details,
        ),
      };
    }
    case 'STATE_CONFLICT':
      return {
        status: 409,
        body: errorBody(
          'STATE_CONFLICT',
          'Quantity can only change while the listing is a draft or open.',
          {
            reason: error.reason,
            status: error.status,
          },
        ),
      };
  }
}

export function listingErrorResponse(error: ListingError): IdempotentResponse {
  switch (error.code) {
    case 'VALIDATION_ERROR': {
      const { code, message, ...details } = error;
      return { status: 400, body: errorBody(code, message, details) };
    }
    case 'PRODUCT_MISMATCH':
      return {
        status: 422,
        body: errorBody('PRODUCT_MISMATCH', error.message, { reason: error.reason }),
      };
    case 'DUPLICATE':
      return {
        status: 409,
        body: errorBody('DUPLICATE', 'This product already has a live listing.', {
          existingListingId: error.existingListingId,
          existingSlug: error.existingSlug,
          link: listingConsolePathOf(error.existingListingId),
        }),
      };
    case 'NOT_FOUND':
      return { status: 404, body: errorBody('NOT_FOUND', 'Listing not found.') };
    case 'BRAND_NOT_VERIFIED':
      return {
        status: 403,
        body: errorBody(
          'BRAND_NOT_VERIFIED',
          'Your brand must be verified before you can publish listings.',
          { verificationStatus: error.verificationStatus },
        ),
      };
    case 'STATE_CONFLICT':
      return {
        status: 409,
        body: errorBody('STATE_CONFLICT', 'Only a draft can be published.', {
          reason: error.reason,
          status: error.status,
        }),
      };
  }
}

export function registerListingRoutes(app: FastifyInstance, deps: ListingRouteDeps): void {
  const manager = app.guards.requireBrandUser('MANAGER');

  app.post(
    '/api/listings',
    { onRequest: manager },
    app.idempotent(async (req) => {
      const body = parse(createListingRequestSchema, req.body, 'listing');
      const user = req.auth.brandUser!;
      const result = await createListing(deps, {
        brandId: user.brandId,
        actor: { type: 'BRAND_USER', id: user.id },
        channel3Id: body.channel3Id,
        variant: body.variant,
        gtin: body.gtin,
        mpn: body.mpn,
        title: body.title,
        quantity: body.quantity,
        floorCents: body.floorCents,
        liquidationQuoteCents: body.liquidationQuoteCents,
        windowHours: body.windowHours,
      });
      if (!result.ok) return listingErrorResponse(result.error);
      return { status: 201, body: result.value };
    }),
  );

  app.post(
    '/api/listings/:id/publish',
    { onRequest: manager },
    app.idempotent(async (req) => {
      const { id } = req.params as { id: string };
      const user = req.auth.brandUser!;
      const result = await publishListing(deps, {
        brandId: user.brandId,
        listingId: id,
        actor: { type: 'BRAND_USER', id: user.id },
      });
      if (!result.ok) {
        if (result.error.code === 'BRAND_NOT_VERIFIED') {
          req.log.info({ listingId: id }, 'publish refused: brand not verified');
        }
        return listingErrorResponse(result.error);
      }
      if (!result.value.priceWatch) {
        req.log.warn({ listingId: id }, 'published with price watch off; subscribe will retry');
      }
      return { status: 200, body: result.value };
    }),
  );

  const money = deps.money;
  if (money) {
    app.post(
      '/api/listings/:id/cancel',
      { onRequest: manager },
      app.idempotent(async (req) => {
        const { id } = req.params as { id: string };
        const user = req.auth.brandUser!;
        const result = await cancelListing(money, {
          brandId: user.brandId,
          listingId: id,
          actor: { type: 'BRAND_USER', id: user.id },
        });
        if (!result.ok) return cancelErrorResponse(result.error);
        // In-process runner: never rejects; anything left VOIDING is finished by the sweeper.
        void result.released.then((r) => {
          if (r.leftVoiding.length) {
            req.log.warn(
              { listingId: id, leftVoiding: r.leftVoiding.length },
              'listing cancel: voids left for the sweeper',
            );
          }
        });
        return { status: 202, body: result.response };
      }),
    );
  }

  app.patch(
    '/api/listings/:id',
    { onRequest: manager },
    app.idempotent(async (req) => {
      const { id } = req.params as { id: string };
      if (!isUuid(id)) return raiseQuantityErrorResponse({ code: 'NOT_FOUND' });
      const body = parse(updateListingRequestSchema, req.body, 'listing');
      const user = req.auth.brandUser!;
      const result = await raiseListingQuantity(deps.db, {
        brandId: user.brandId,
        listingId: id,
        quantity: body.quantity,
        actor: { type: 'BRAND_USER', id: user.id },
      });
      if (!result.ok) return raiseQuantityErrorResponse(result.error);
      return { status: 200, body: result.value };
    }),
  );

  app.get('/api/listings', { onRequest: app.guards.requireBrandUser() }, async (req) => {
    const { status } = parse(listListingsQuerySchema, req.query, 'query');
    const statuses = status?.split(',');
    if (statuses?.some((s) => !(LISTING_STATUSES as readonly string[]).includes(s))) {
      throw new ApiError('VALIDATION_ERROR', 'Unknown listing status.', { field: 'status' });
    }
    const listings = await listBrandListings(deps.db.pool, req.auth.brandUser!.brandId, {
      ...(statuses ? { status: statuses } : {}),
    });
    return { listings };
  });
}
