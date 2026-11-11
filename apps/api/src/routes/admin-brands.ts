import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errorBody, isUuid, verifyBrand, type Db } from '@holdfast/core';

/**
 * `POST /api/admin/brands/:id/verify` (api.md §Ops, HF-011a). Admin only: the session's brand
 * user email is in `ADMIN_EMAILS` (D13); anyone else gets 401 / 403 from `requireAdmin`.
 *
 *   200 { brandId, name, domain, verificationStatus: 'VERIFIED', verifiedAt, alreadyVerified }
 *   404 NOT_FOUND · 409 STATE_CONFLICT { reason: 'BRAND_REJECTED' }
 *
 * Verifying an already VERIFIED brand answers 200 with `alreadyVerified: true` and writes no
 * second audit row. Stored under the Idempotency-Key like any other mutation.
 */
export function registerAdminBrandRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Params: { id: string } }>(
    '/api/admin/brands/:id/verify',
    { onRequest: app.guards.requireAdmin },
    app.idempotent(async (req) => {
      const { id } = (req as FastifyRequest<{ Params: { id: string } }>).params;
      if (!isUuid(id)) return { status: 404, body: errorBody('NOT_FOUND', 'Brand not found.') };

      const result = await verifyBrand(
        db,
        { brandId: id },
        { type: 'BRAND_USER', id: req.auth.brandUser!.id },
      );
      if (!result.ok) {
        if (result.error.code === 'NOT_FOUND') {
          return { status: 404, body: errorBody('NOT_FOUND', 'Brand not found.') };
        }
        return {
          status: 409,
          body: errorBody('STATE_CONFLICT', 'This brand was rejected and cannot be verified.', {
            reason: result.error.reason,
          }),
        };
      }
      const { brand, changed } = result;
      return {
        status: 200,
        body: {
          brandId: brand.id,
          name: brand.name,
          domain: brand.domain,
          verificationStatus: brand.verificationStatus,
          verifiedAt: brand.verifiedAt,
          alreadyVerified: !changed,
        },
      };
    }),
  );
}
