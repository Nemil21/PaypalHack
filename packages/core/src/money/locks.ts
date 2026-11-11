import type { Queryable } from '../db.js';
import type { BidRow, ListingRow, MandateRow } from './rows.js';

/**
 * Row locks for money paths (D1, D2, INV-3).
 *
 * **Lock order everywhere: listing → mandate → bids by id.** Take them in that order, in one
 * transaction, and never take a listing or mandate lock after a bid lock. Two listings (a move)
 * are locked in id order. Following this order is what keeps `landHold`, Clear, Cancel, Expire,
 * mandate pause and the sweeper free of deadlocks.
 */

/** The listing statuses Clear, Cancel and Expire may start from (D2). */
export const CLOSABLE_LISTING_STATUSES = ['OPEN', 'ROUNDS'] as const;
export type ListingCloseTarget = 'CLEARING' | 'CANCELLED' | 'EXPIRED';

export type LockedListing = ListingRow & { db_now: Date };

/**
 * Lock a listing.
 *
 * - `'share'` (bid landing, D1): `SELECT … FOR SHARE`. Many holds can land at once; any of them
 *   blocks a concurrent Clear / Cancel / Expire until it commits, and vice versa. Returns the
 *   row (with `db_now`, the database clock) or null if it does not exist. The caller re-checks
 *   `isBiddable` / `isRaisable`.
 * - `'close'` (Clear / Cancel / Expire, D2): the conditional
 *   `UPDATE listings SET status=$to WHERE id=$1 AND status IN ('OPEN','ROUNDS') RETURNING *`.
 *   Null means the listing already left OPEN/ROUNDS: ROLLBACK and answer 409.
 */
export async function lockListing(
  tx: Queryable,
  listingId: string,
  mode: 'share',
): Promise<LockedListing | null>;
export async function lockListing(
  tx: Queryable,
  listingId: string,
  mode: 'close',
  to: ListingCloseTarget,
): Promise<LockedListing | null>;
export async function lockListing(
  tx: Queryable,
  listingId: string,
  mode: 'share' | 'close',
  to?: ListingCloseTarget,
): Promise<LockedListing | null> {
  if (mode === 'share') {
    const res = await tx.query(
      `SELECT l.*, clock_timestamp() AS db_now FROM listings l WHERE l.id = $1 FOR SHARE`,
      [listingId],
    );
    return (res.rows[0] as LockedListing | undefined) ?? null;
  }
  if (!to) throw new Error('lockListing: close mode needs a target status');
  const res = await tx.query(
    `UPDATE listings SET status = $2
      WHERE id = $1 AND status = ANY($3::text[])
      RETURNING *, clock_timestamp() AS db_now`,
    [listingId, to, CLOSABLE_LISTING_STATUSES],
  );
  return (res.rows[0] as LockedListing | undefined) ?? null;
}

/** `SELECT … FROM mandates WHERE id=$1 FOR UPDATE` (D12): take after the listing, before bids. */
export async function lockMandate(tx: Queryable, mandateId: string): Promise<MandateRow | null> {
  const res = await tx.query(`SELECT * FROM mandates WHERE id = $1 FOR UPDATE`, [mandateId]);
  return (res.rows[0] as MandateRow | undefined) ?? null;
}

/**
 * Lock every HELD bid on a listing, in id order (D2):
 * `SELECT … FROM bids WHERE listing_id=$1 AND status='HELD' ORDER BY id FOR UPDATE`.
 * Use wherever one decision covers many bids (Clear, Cancel, Expire), after `lockListing`.
 */
export async function lockBids(tx: Queryable, listingId: string): Promise<BidRow[]> {
  const res = await tx.query(
    `SELECT * FROM bids WHERE listing_id = $1 AND status = 'HELD' ORDER BY id FOR UPDATE`,
    [listingId],
  );
  return res.rows as BidRow[];
}

/** Lock specific bids in id order (the raise swap locks the old and new bid together). */
export async function lockBidsById(tx: Queryable, bidIds: readonly string[]): Promise<BidRow[]> {
  const res = await tx.query(
    `SELECT * FROM bids WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...new Set(bidIds)]],
  );
  return res.rows as BidRow[];
}
