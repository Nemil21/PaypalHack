import type { SettlementCounts, SettlementRow } from '@holdfast/shared';
import type { Queryable } from '../db.js';
import { emit } from '../money/emit.js';

/**
 * Settlement rows and counts in the `SettlementView` shapes (packages/shared). `settleBid`
 * (HF-029) publishes them as `settlement.updated`; HF-030a's `GET /listings/:id/settlement` and
 * W08 (HF-035) read the same shapes.
 */

interface RowSql {
  id: string;
  bid_id: string;
  seq: string;
  is_simulated: boolean;
  action: SettlementRow['action'];
  status: SettlementRow['status'];
  amount_cents: number | null;
  bid_amount_cents: number;
  is_reserve: boolean;
  paypal_id: string | null;
  paypal_status: string | null;
  error_class: SettlementRow['errorClass'];
  error_code: string | null;
  attempts: number;
  unit_root_bid_id: string | null;
  promoted_from_bid_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

const ROW_SQL = `
  SELECT s.id, s.bid_id, b.seq, sh.is_simulated, s.action, s.status, s.amount_cents,
         b.amount_cents AS bid_amount_cents, s.is_reserve, s.paypal_id, s.paypal_status,
         s.error_class, s.error_code, s.attempts, b.unit_root_bid_id, s.started_at, s.finished_at,
         CASE WHEN s.action = 'CAPTURE' AND b.unit_root_bid_id IS DISTINCT FROM b.id THEN
           (SELECT f.id FROM bids f
             WHERE f.unit_root_bid_id = b.unit_root_bid_id AND f.id <> b.id
               AND (f.status = 'CAPTURE_FAILED' OR f.void_reason = 'CAPTURE_FAILED')
             ORDER BY f.updated_at DESC, f.id LIMIT 1)
         END AS promoted_from_bid_id
    FROM settlements s
    JOIN bids b ON b.id = s.bid_id
    JOIN shoppers sh ON sh.id = b.shopper_id`;

function toRow(r: RowSql): SettlementRow {
  return {
    settlementId: r.id,
    bidId: r.bid_id,
    // Same label as `bid.held` (money/land-hold.ts): no names or emails on the stream.
    shopperLabel: `Shopper #${r.seq}`,
    isSimulated: r.is_simulated,
    action: r.action,
    status: r.status,
    amountCents: r.amount_cents ?? r.bid_amount_cents,
    isReserve: r.is_reserve,
    paypalId: r.paypal_id,
    paypalStatus: r.paypal_status,
    errorClass: r.error_class,
    errorCode: r.error_code,
    attempts: r.attempts,
    unitRootBidId: r.unit_root_bid_id,
    promotedFromBidId: r.promoted_from_bid_id,
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export async function settlementRow(q: Queryable, settlementId: string): Promise<SettlementRow> {
  const res = await q.query(`${ROW_SQL} WHERE s.id = $1`, [settlementId]);
  const row = res.rows[0] as RowSql | undefined;
  if (!row) throw new Error(`settlement ${settlementId} not found`);
  return toRow(row);
}

export async function settlementRows(q: Queryable, listingId: string): Promise<SettlementRow[]> {
  const res = await q.query(`${ROW_SQL} WHERE s.listing_id = $1 ORDER BY s.created_at, s.id`, [
    listingId,
  ]);
  return (res.rows as RowSql[]).map(toRow);
}

export async function settlementCounts(q: Queryable, listingId: string): Promise<SettlementCounts> {
  const res = await q.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE s.status = 'QUEUED')::int AS queued,
            count(*) FILTER (WHERE s.status IN ('RUNNING', 'RETRY'))::int AS running,
            count(*) FILTER (WHERE s.action = 'CAPTURE' AND s.status = 'SUCCEEDED'
                               AND s.paypal_status IS DISTINCT FROM 'PENDING')::int AS captured,
            count(*) FILTER (WHERE s.action = 'CAPTURE' AND s.status = 'SUCCEEDED'
                               AND s.paypal_status = 'PENDING')::int AS capture_pending,
            count(*) FILTER (WHERE s.action = 'VOID' AND s.status = 'SUCCEEDED')::int AS released,
            count(*) FILTER (WHERE s.status = 'FAILED')::int AS failed,
            count(*) FILTER (WHERE s.action = 'CAPTURE'
                               AND b.unit_root_bid_id IS DISTINCT FROM b.id)::int AS promoted,
            count(*) FILTER (WHERE s.status = 'CANCELLED')::int AS cancelled
       FROM settlements s JOIN bids b ON b.id = s.bid_id
      WHERE s.listing_id = $1`,
    [listingId],
  );
  const c = res.rows[0] as Record<string, number>;
  return {
    total: c.total ?? 0,
    queued: c.queued ?? 0,
    running: c.running ?? 0,
    captured: c.captured ?? 0,
    capturePending: c.capture_pending ?? 0,
    released: c.released ?? 0,
    failed: c.failed ?? 0,
    promoted: c.promoted ?? 0,
    cancelled: c.cancelled ?? 0,
  };
}

/** Publish `settlement.updated` for one row, inside the transaction that changed it. */
export async function emitSettlementUpdated(
  tx: Queryable,
  listingId: string,
  settlementId: string,
): Promise<void> {
  const row = await settlementRow(tx, settlementId);
  const counts = await settlementCounts(tx, listingId);
  await emit(tx, listingId, {
    type: 'settlement.updated',
    listingId,
    at: new Date().toISOString(),
    row,
    counts,
  });
}
