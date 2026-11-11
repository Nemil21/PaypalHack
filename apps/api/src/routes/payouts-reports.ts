import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addShipment,
  brandPayouts,
  brandReport,
  errorBody,
  shipmentErrorMessage,
  shipmentRoster,
  uploadShipments,
  type Db,
  type PayPalClient,
  type ShipmentError,
} from '@holdfast/core';
import {
  brandReportQuerySchema,
  MAX_SHIPMENT_CSV_ROWS,
  SHIPMENT_CSV_COLUMNS,
  shipmentRequestSchema,
  statementsCsv,
  toCsv,
  type ShipmentResponseBody,
} from '@holdfast/shared';
import { ApiError, parse } from '../http/errors.js';

/**
 * W09 payouts, reports and shipment tracking (HF-059b; api.md §`/brands/me/payouts`,
 * §`/brands/me/reports`, §`POST /listings/:id/shipments`). Brand session only; the brand always
 * comes from the session, and another brand's listing or bid is a 404.
 *
 *   GET  /api/brands/me/payouts                  every payout attempt, newest first (any role)
 *   GET  /api/brands/me/reports?from&to          statements; `Accept: text/csv` → CSV (any role)
 *   GET  /api/listings/:id/shipments             charged winners + shipments; `text/csv` → the
 *                                                upload template (bidId,carrier,trackingNumber)
 *   POST /api/listings/:id/shipments             { bidId, carrier, trackingNumber } → `pp.track`
 *   POST /api/listings/:id/shipments/csv         { csv } → per-row results (never fails whole)
 *
 * The POSTs are OWNER/MANAGER. Single POST goes through the idempotency store; a re-post with a
 * new key is still safe (the shipment row answers it without calling PayPal).
 */

export interface PayoutsReportsRouteDeps {
  db: Db;
  /** `pp.track`. Without it the shipment POSTs are not mounted. */
  paypal?: Pick<PayPalClient, 'track'> | undefined;
}

const csvUploadSchema = z.object({
  csv: z
    .string()
    .min(1, 'the file is empty')
    .max(MAX_SHIPMENT_CSV_ROWS * 200, 'file too large'),
});

const wantsCsv = (accept: string | undefined) => !!accept && /\btext\/csv\b/i.test(accept);

/** `YYYY-MM-DD` is a UTC day; `to` as a bare date includes that whole day. */
function bound(value: string | undefined, end: boolean): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  return new Date(value);
}

function shipmentError(error: ShipmentError) {
  const message = shipmentErrorMessage(error);
  switch (error.code) {
    case 'NOT_FOUND':
      return { status: 404, body: errorBody('NOT_FOUND', message) };
    case 'PAYPAL_ERROR':
      return {
        status: 502,
        body: errorBody('PAYPAL_ERROR', message, {
          paypalCode: error.paypalCode,
          retryable: error.retryable,
          shipment: error.shipment,
        }),
      };
    case 'STATE_CONFLICT':
      // IN_PROGRESS is its own (retryable, never stored) code; the rest carry a reason.
      if (error.reason === 'IN_PROGRESS') {
        return { status: 409, body: errorBody('IN_PROGRESS', message) };
      }
      return {
        status: 409,
        body: errorBody('STATE_CONFLICT', message, {
          reason: error.reason,
          ...(error.shipment ? { shipment: error.shipment } : {}),
        }),
      };
  }
}

export function registerPayoutsReportsRoutes(
  app: FastifyInstance,
  deps: PayoutsReportsRouteDeps,
): void {
  const { db } = deps;

  app.get(
    '/api/brands/me/payouts',
    { onRequest: app.guards.requireBrandUser() },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return brandPayouts(db.pool, req.auth.brandUser!.brandId);
    },
  );

  app.get(
    '/api/brands/me/reports',
    { onRequest: app.guards.requireBrandUser() },
    async (req, reply) => {
      const q = parse(brandReportQuerySchema, req.query, 'report range');
      const report = await brandReport(db.pool, req.auth.brandUser!.brandId, {
        from: bound(q.from, false),
        to: bound(q.to, true),
      });
      reply.header('cache-control', 'no-store');
      if (wantsCsv(req.headers.accept)) {
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="holdfast-statements.csv"')
          .send(statementsCsv(report.statements));
      }
      return report;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/listings/:id/shipments',
    { onRequest: app.guards.requireBrandUser() },
    async (req, reply) => {
      const roster = await shipmentRoster(db.pool, req.auth.brandUser!.brandId, req.params.id);
      if (!roster) throw new ApiError('NOT_FOUND', 'Listing not found.');
      reply.header('cache-control', 'no-store');
      if (wantsCsv(req.headers.accept)) {
        // The upload template: one row per trackable winner, tracking columns pre-filled if known.
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="holdfast-shipments.csv"')
          .send(
            toCsv(
              [...SHIPMENT_CSV_COLUMNS, 'winner', 'status'],
              roster.rows
                .filter((r) => r.trackable)
                .map((r) => [
                  r.bidId,
                  r.shipment?.carrier ?? '',
                  r.shipment?.trackingNumber ?? '',
                  r.winnerLabel,
                  r.shipment?.status ?? 'NOT_SHIPPED',
                ]),
            ),
          );
      }
      return roster;
    },
  );

  const paypal = deps.paypal;
  if (!paypal) return;

  app.post<{ Params: { id: string } }>(
    '/api/listings/:id/shipments',
    { onRequest: app.guards.requireBrandUser('MANAGER') },
    app.idempotent(async (req) => {
      const user = req.auth.brandUser!;
      const input = parse(shipmentRequestSchema, req.body, 'shipment');
      const out = await addShipment(
        { db, paypal },
        {
          ...input,
          brandId: user.brandId,
          listingId: (req.params as { id: string }).id,
          actor: { type: 'BRAND_USER', id: user.id },
        },
      );
      if (!out.ok) return shipmentError(out.error);
      const body: ShipmentResponseBody = { shipment: out.shipment, replayed: !out.created };
      return { status: out.created ? 201 : 200, body };
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/listings/:id/shipments/csv',
    { onRequest: app.guards.requireBrandUser('MANAGER') },
    async (req) => {
      const user = req.auth.brandUser!;
      const { csv } = parse(csvUploadSchema, req.body, 'upload');
      const out = await uploadShipments(
        { db, paypal },
        {
          brandId: user.brandId,
          listingId: req.params.id,
          csv,
          actor: { type: 'BRAND_USER', id: user.id },
        },
      );
      if (!out) throw new ApiError('NOT_FOUND', 'Listing not found.');
      return out;
    },
  );
}
