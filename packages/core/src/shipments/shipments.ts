import { randomUUID } from 'node:crypto';
import {
  parseShipmentCsv,
  type ShipmentRequest,
  type ShipmentRosterBody,
  type ShipmentStatus,
  type ShipmentUploadBody,
  type ShipmentUploadRowResult,
  type ShipmentView,
} from '@holdfast/shared';
import { audit, auditedCall, type AuditActorType } from '../audit.js';
import type { Db, Queryable } from '../db.js';
import { transition } from '../money/transition.js';
import { trackRequestId } from '../paypal/ids.js';
import type { PayPalClient, TrackResult } from '../paypal/types.js';
import { isUuid } from '../tenancy.js';

/**
 * Shipment tracking (HF-059b; features/12 §Logic 3, api.md §`POST /listings/:id/shipments`).
 *
 * `addShipment` = one `shipments` row per bid (`bid_id` UNIQUE) → `pp.track` on the bid's order
 * and capture with `PayPal-Request-Id: track-<shipmentId>` (D5) → SHIPPED and the bid
 * CAPTURED → SHIPPED in one transaction. The PayPal call runs outside any transaction (INV-1),
 * wrapped in a `TRACK_REQUESTED` / `_SUCCEEDED` / `_FAILED` audit pair.
 *
 * Exactly-once `track` per shipment:
 * - re-posting a SHIPPED shipment with the same carrier and number answers from the row (no call);
 * - a concurrent post while the first call is in flight gets `IN_PROGRESS` (the claim is the
 *   bid row lock + a PENDING row with no `error_code`, touched within `TRACK_LEASE_SECONDS`);
 * - a retry after a crash or a TRANSIENT failure reuses the same shipment id, hence the same
 *   request id, with the original carrier and number. PayPal also dedupes trackers by
 *   `<captureId>-<trackingNumber>` (sandbox probe), so even an overlapping retry adds no second
 *   tracker.
 *
 * Shipment statuses: PENDING (claimed, or a retryable failure with `error_code` set) →
 * SHIPPED (PayPal has the tracker) | TRACKING_FAILED (PayPal refused it: TERMINAL; the brand may
 * correct the carrier or number and post again). DELIVERED is reserved for a later carrier feed.
 */

/** A PENDING claim older than this is treated as a crashed call and may be retried. */
export const TRACK_LEASE_SECONDS = 60;
/** Parallel `pp.track` calls during a CSV upload. */
export const SHIPMENT_UPLOAD_CONCURRENCY = 5;

export interface ShipmentDeps {
  db: Db;
  paypal: Pick<PayPalClient, 'track'>;
}

export interface ShipmentActor {
  type: AuditActorType;
  id: string | null;
}

export interface AddShipmentInput extends ShipmentRequest {
  brandId: string;
  listingId: string;
  actor: ShipmentActor;
}

export type ShipmentConflictReason =
  /** The bid has not been captured (or it lost / failed): nothing to ship. */
  | 'NOT_CAPTURED'
  /** Captured but no PayPal order / capture id (simulated winner): nothing to send PayPal. */
  | 'NOT_TRACKABLE'
  /** Already shipped with a different carrier or tracking number. */
  | 'ALREADY_SHIPPED'
  /** Another request is calling PayPal for this bid right now. */
  | 'IN_PROGRESS'
  /** A previous call's outcome is unknown; retry with the original carrier and number first. */
  | 'TRACKING_PENDING';

export type ShipmentError =
  | { code: 'NOT_FOUND' }
  | { code: 'STATE_CONFLICT'; reason: ShipmentConflictReason; shipment?: ShipmentView }
  | {
      code: 'PAYPAL_ERROR';
      paypalCode: string;
      retryable: boolean;
      shipment: ShipmentView;
    };

export type ShipmentOutcome =
  | { ok: true; created: boolean; replayed: boolean; shipment: ShipmentView }
  | { ok: false; error: ShipmentError };

interface ShipmentRow {
  id: string;
  bid_id: string;
  listing_id: string | null;
  carrier: string | null;
  tracking_number: string | null;
  paypal_tracker_id: string | null;
  tracking_request_id: string | null;
  status: ShipmentStatus;
  error_code: string | null;
  shipped_at: Date | null;
  in_flight?: boolean;
}

const iso = (v: Date | string | null) =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export function shipmentView(row: ShipmentRow): ShipmentView {
  return {
    shipmentId: row.id,
    bidId: row.bid_id,
    listingId: row.listing_id ?? '',
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    status: row.status,
    paypalTrackerId: row.paypal_tracker_id,
    shippedAt: iso(row.shipped_at),
    errorCode: row.error_code,
  };
}

const SHIPMENT_COLUMNS = `id, bid_id, listing_id, carrier, tracking_number, paypal_tracker_id,
  tracking_request_id, status, error_code, shipped_at`;

interface Claimed {
  shipment: ShipmentRow;
  orderId: string;
  captureId: string;
  created: boolean;
}

type ClaimResult = { kind: 'claimed'; claim: Claimed } | { kind: 'done'; outcome: ShipmentOutcome };

const sameDetails = (row: ShipmentRow, input: ShipmentRequest) =>
  (row.carrier ?? '').toLowerCase() === input.carrier.toLowerCase() &&
  row.tracking_number === input.trackingNumber;

const conflict = (reason: ShipmentConflictReason, row?: ShipmentRow): ShipmentOutcome => ({
  ok: false,
  error: { code: 'STATE_CONFLICT', reason, ...(row ? { shipment: shipmentView(row) } : {}) },
});

/** Lock the bid (tenant-scoped), decide, and claim the shipment row. One short transaction. */
async function claim(tx: Queryable, input: AddShipmentInput): Promise<ClaimResult> {
  const bid = (
    await tx.query<{
      id: string;
      status: string;
      paypal_order_id: string | null;
      simulated: boolean;
      capture_id: string | null;
    }>(
      `SELECT b.id, b.status, b.paypal_order_id,
              (coalesce(sh.is_simulated, false) OR b.source = 'SIM') IS TRUE AS simulated,
              (SELECT s.paypal_id FROM settlements s
                WHERE s.bid_id = b.id AND s.action = 'CAPTURE' AND s.status = 'SUCCEEDED'
                LIMIT 1) AS capture_id
         FROM bids b
         JOIN listings l ON l.id = b.listing_id
         LEFT JOIN shoppers sh ON sh.id = b.shopper_id
        WHERE b.id = $1 AND b.listing_id = $2 AND l.brand_id = $3
          FOR UPDATE OF b`,
      [input.bidId, input.listingId, input.brandId],
    )
  ).rows[0];
  if (!bid) return { kind: 'done', outcome: { ok: false, error: { code: 'NOT_FOUND' } } };

  const existing = (
    await tx.query<ShipmentRow>(
      `SELECT ${SHIPMENT_COLUMNS},
              (status = 'PENDING' AND error_code IS NULL
                AND updated_at > now() - make_interval(secs => $2)) AS in_flight
         FROM shipments WHERE bid_id = $1 FOR UPDATE`,
      [bid.id, TRACK_LEASE_SECONDS],
    )
  ).rows[0];

  if (existing && (existing.status === 'SHIPPED' || existing.status === 'DELIVERED')) {
    if (sameDetails(existing, input)) {
      return {
        kind: 'done',
        outcome: { ok: true, created: false, replayed: true, shipment: shipmentView(existing) },
      };
    }
    return { kind: 'done', outcome: conflict('ALREADY_SHIPPED', existing) };
  }
  if (bid.status !== 'CAPTURED') return { kind: 'done', outcome: conflict('NOT_CAPTURED') };
  if (bid.simulated || !bid.paypal_order_id || !bid.capture_id) {
    return { kind: 'done', outcome: conflict('NOT_TRACKABLE') };
  }
  if (existing?.in_flight) return { kind: 'done', outcome: conflict('IN_PROGRESS', existing) };
  // A PENDING row that is not in flight crashed or failed TRANSIENT: PayPal may already hold its
  // tracker under this request id, so only the original details may be retried.
  if (existing?.status === 'PENDING' && !sameDetails(existing, input)) {
    return { kind: 'done', outcome: conflict('TRACKING_PENDING', existing) };
  }

  let shipment: ShipmentRow;
  if (existing) {
    // TRACKING_FAILED (PayPal refused it, so it holds nothing) or a stale PENDING: claim again.
    shipment = (
      await tx.query<ShipmentRow>(
        `UPDATE shipments
            SET status = 'PENDING', error_code = NULL, carrier = $2, tracking_number = $3
          WHERE id = $1 AND status IN ('PENDING', 'TRACKING_FAILED')
          RETURNING ${SHIPMENT_COLUMNS}`,
        [existing.id, input.carrier, input.trackingNumber],
      )
    ).rows[0]!;
  } else {
    const id = randomUUID();
    shipment = (
      await tx.query<ShipmentRow>(
        `INSERT INTO shipments (id, bid_id, listing_id, carrier, tracking_number,
                                tracking_request_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
         RETURNING ${SHIPMENT_COLUMNS}`,
        [id, bid.id, input.listingId, input.carrier, input.trackingNumber, trackRequestId(id)],
      )
    ).rows[0]!;
  }
  return {
    kind: 'claimed',
    claim: {
      shipment,
      orderId: bid.paypal_order_id,
      captureId: bid.capture_id,
      created: !existing,
    },
  };
}

/** Record PayPal's answer: SHIPPED + bid CAPTURED → SHIPPED, or the failure. */
async function settle(
  tx: Queryable,
  input: AddShipmentInput,
  c: Claimed,
  result: TrackResult,
): Promise<ShipmentOutcome> {
  if (result.ok) {
    const row = (
      await tx.query<ShipmentRow>(
        `UPDATE shipments
            SET status = 'SHIPPED', paypal_tracker_id = $2, shipped_at = now(), error_code = NULL
          WHERE id = $1 AND status = 'PENDING'
          RETURNING ${SHIPMENT_COLUMNS}`,
        [c.shipment.id, result.trackerId],
      )
    ).rows[0];
    if (!row) {
      // Someone else's retry finished first; theirs is the answer.
      const current = await loadShipment(tx, c.shipment.id);
      return { ok: true, created: false, replayed: true, shipment: shipmentView(current!) };
    }
    const bid = await transition(tx, 'bids', input.bidId, 'CAPTURED', 'SHIPPED');
    await audit(tx, {
      actorType: input.actor.type,
      actorId: input.actor.id,
      listingId: input.listingId,
      entity: 'bid',
      entityId: input.bidId,
      action: 'BID_SHIPPED',
      paypalId: result.trackerId,
      requestId: c.shipment.tracking_request_id,
      data: { shipmentId: row.id, carrier: row.carrier, from: bid ? 'CAPTURED' : null },
    });
    return { ok: true, created: c.created, replayed: result.replayed, shipment: shipmentView(row) };
  }
  const terminal = result.errorClass === 'TERMINAL';
  const row = (
    await tx.query<ShipmentRow>(
      `UPDATE shipments SET status = $2, error_code = $3
        WHERE id = $1 AND status = 'PENDING'
        RETURNING ${SHIPMENT_COLUMNS}`,
      [c.shipment.id, terminal ? 'TRACKING_FAILED' : 'PENDING', result.code],
    )
  ).rows[0];
  const current = row ?? (await loadShipment(tx, c.shipment.id))!;
  if (current.status === 'SHIPPED') {
    return { ok: true, created: false, replayed: true, shipment: shipmentView(current) };
  }
  return {
    ok: false,
    error: {
      code: 'PAYPAL_ERROR',
      paypalCode: result.code,
      retryable: !terminal,
      shipment: shipmentView(current),
    },
  };
}

async function loadShipment(q: Queryable, id: string): Promise<ShipmentRow | null> {
  return (
    (await q.query<ShipmentRow>(`SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE id = $1`, [id]))
      .rows[0] ?? null
  );
}

/** `POST /listings/:id/shipments`: track one winner's shipment (see the module comment). */
export async function addShipment(
  deps: ShipmentDeps,
  input: AddShipmentInput,
): Promise<ShipmentOutcome> {
  if (!isUuid(input.listingId) || !isUuid(input.bidId)) {
    return { ok: false, error: { code: 'NOT_FOUND' } };
  }
  const claimed = await deps.db.tx((tx) => claim(tx, input));
  if (claimed.kind === 'done') return claimed.outcome;
  const c = claimed.claim;
  const requestId = trackRequestId(c.shipment.id);

  let result: TrackResult;
  try {
    result = await auditedCall(
      deps.db,
      {
        actorType: input.actor.type,
        actorId: input.actor.id,
        listingId: input.listingId,
        entity: 'shipment',
        entityId: c.shipment.id,
        action: 'TRACK',
        requestId,
        data: { bidId: input.bidId, carrier: c.shipment.carrier },
      },
      () =>
        deps.paypal.track(c.orderId, {
          requestId,
          captureId: c.captureId,
          carrier: c.shipment.carrier ?? input.carrier,
          trackingNumber: c.shipment.tracking_number ?? input.trackingNumber,
        }),
      (r) =>
        r.ok
          ? { ok: true, paypalId: r.trackerId, data: { replayed: r.replayed } }
          : { ok: false, data: { code: r.code, errorClass: r.errorClass, http: r.http } },
    );
  } catch {
    // Not a PayPal answer (bad credentials, a bug): retryable with the same request id.
    result = { ok: false, errorClass: 'TRANSIENT', code: 'CLIENT_ERROR', http: 0 };
  }
  return deps.db.tx((tx) => settle(tx, input, c, result));
}

const ERROR_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'No such winner on this listing.',
  NOT_CAPTURED: 'This bid has not been charged, so there is nothing to ship.',
  NOT_TRACKABLE: 'This winner has no PayPal capture to attach tracking to.',
  ALREADY_SHIPPED: 'Already shipped with a different tracking number.',
  IN_PROGRESS: 'Tracking for this winner is being sent to PayPal. Try again shortly.',
  TRACKING_PENDING: 'Retry with the original carrier and tracking number first.',
};

/** Short, user-facing text for a failed shipment (W09 per-row errors). */
export function shipmentErrorMessage(error: ShipmentError): string {
  if (error.code === 'PAYPAL_ERROR') {
    return error.retryable
      ? `PayPal did not answer (${error.paypalCode}). Upload again to retry.`
      : `PayPal refused the tracking number (${error.paypalCode}).`;
  }
  if (error.code === 'NOT_FOUND') return ERROR_MESSAGES.NOT_FOUND!;
  return ERROR_MESSAGES[error.reason] ?? error.reason;
}

const errorCode = (error: ShipmentError) =>
  error.code === 'STATE_CONFLICT' ? error.reason : error.code;

/**
 * `POST /listings/:id/shipments/csv`: parse, then `addShipment` per row (concurrency
 * `SHIPMENT_UPLOAD_CONCURRENCY`). Every row gets its own result; one bad row never sinks the
 * file. Re-uploading the same file is safe: tracked rows answer `replayed` without a PayPal call.
 */
export async function uploadShipments(
  deps: ShipmentDeps,
  input: { brandId: string; listingId: string; csv: string; actor: ShipmentActor },
): Promise<ShipmentUploadBody | null> {
  if (!isUuid(input.listingId)) return null;
  const listing = await deps.db.pool.query(
    `SELECT 1 FROM listings WHERE id = $1 AND brand_id = $2`,
    [input.listingId, input.brandId],
  );
  if (listing.rowCount === 0) return null;

  const parsed = parseShipmentCsv(input.csv);
  const results: ShipmentUploadRowResult[] = parsed.errors.map((e) => ({
    row: e.row,
    bidId: e.bidId,
    ok: false,
    error: { code: 'VALIDATION_ERROR', message: e.message },
  }));
  let next = 0;
  const worker = async () => {
    while (next < parsed.rows.length) {
      const { row, input: req } = parsed.rows[next++]!;
      const out = await addShipment(deps, {
        ...req,
        brandId: input.brandId,
        listingId: input.listingId,
        actor: input.actor,
      });
      results.push(
        out.ok
          ? { row, bidId: req.bidId, ok: true, replayed: out.replayed, shipment: out.shipment }
          : {
              row,
              bidId: req.bidId,
              ok: false,
              error: { code: errorCode(out.error), message: shipmentErrorMessage(out.error) },
            },
      );
    }
  };
  await Promise.all(Array.from({ length: SHIPMENT_UPLOAD_CONCURRENCY }, worker));
  results.sort((a, b) => a.row - b.row);
  const okCount = results.filter((r) => r.ok).length;
  return { listingId: input.listingId, results, okCount, errorCount: results.length - okCount };
}

/**
 * `GET /listings/:id/shipments`: the listing's charged winners (CAPTURED / SHIPPED, best bid
 * first) and their shipments. Null for another brand's or an unknown listing.
 */
export async function shipmentRoster(
  q: Queryable,
  brandId: string,
  listingId: string,
): Promise<ShipmentRosterBody | null> {
  if (!isUuid(listingId)) return null;
  const listing = (
    await q.query<{ title: string | null }>(
      `SELECT p.title FROM listings l LEFT JOIN products p ON p.id = l.product_id
        WHERE l.id = $1 AND l.brand_id = $2`,
      [listingId, brandId],
    )
  ).rows[0];
  if (!listing) return null;
  const rows = (
    await q.query<
      ShipmentRow & {
        b_id: string;
        b_status: string;
        amount_cents: number;
        trackable: boolean;
      }
    >(
      `SELECT b.id AS b_id, b.status AS b_status, b.amount_cents,
              (b.paypal_order_id IS NOT NULL
                AND NOT ((coalesce(sp.is_simulated, false) OR b.source = 'SIM') IS TRUE)
                AND EXISTS (SELECT 1 FROM settlements s
                             WHERE s.bid_id = b.id AND s.action = 'CAPTURE'
                               AND s.status = 'SUCCEEDED' AND s.paypal_id IS NOT NULL)
              ) AS trackable,
              sh.id, sh.bid_id, sh.listing_id, sh.carrier, sh.tracking_number,
              sh.paypal_tracker_id, sh.tracking_request_id, sh.status, sh.error_code, sh.shipped_at
         FROM bids b
         LEFT JOIN shoppers sp ON sp.id = b.shopper_id
         LEFT JOIN shipments sh ON sh.bid_id = b.id
        WHERE b.listing_id = $1 AND b.status IN ('CAPTURED', 'SHIPPED')
        ORDER BY b.amount_cents DESC, b.placed_at ASC, b.id ASC`,
      [listingId],
    )
  ).rows;
  return {
    listingId,
    productTitle: listing.title ?? 'Listing',
    rows: rows.map((r, i) => ({
      bidId: r.b_id,
      winnerLabel: `Winner #${i + 1}`,
      amountCents: r.amount_cents,
      bidStatus: r.b_status,
      trackable: r.trackable,
      shipment: r.id ? shipmentView(r) : null,
    })),
  };
}

/** A bid's shipment for the shopper's won page (HF-059a reads it through its own bid route). */
export async function shipmentForBid(q: Queryable, bidId: string): Promise<ShipmentView | null> {
  if (!isUuid(bidId)) return null;
  const row = (
    await q.query<ShipmentRow>(`SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE bid_id = $1`, [
      bidId,
    ])
  ).rows[0];
  return row ? shipmentView(row) : null;
}
