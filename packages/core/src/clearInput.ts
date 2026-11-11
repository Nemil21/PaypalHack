import { createHash } from 'node:crypto';
import type { ClearBid, ClearInput } from '@holdfast/shared';

/** Anything that can run a query: a pg Pool, PoolClient or Client (inside a transaction for Clear). */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface LoadClearInputOptions {
  /**
   * Lock the eligible bids `FOR UPDATE` (Clear, Cancel, Expire; D2). Bids are locked in id order,
   * after the caller has locked the listing (lock order: listing → mandate → bids by id).
   */
  forUpdate?: boolean;
}

interface BidRow {
  id: string;
  shopper_id: string;
  amount_cents: number;
  seq: string;
  placed_at: string;
  status: ClearBid['status'];
  paypal_authorization_id: string | null;
  authorized_at: string | null;
  is_simulated: boolean;
}

// µs-precision UTC ISO strings straight from Postgres: JS Dates would drop the microseconds.
const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * The one query for "the eligible book" (D8): HELD bids with a PayPal authorization id, in the
 * `ClearInput` shape `clear()` takes. Used by Clear (HF-027), `/book` and `/simulate` (HF-022),
 * the slider (HF-024 via `/book`) and the rounds runner (HF-036a). Returns null when the
 * listing does not exist. Callers pass the chosen Q to `clear()` separately.
 */
export async function loadClearInput(
  db: Queryable,
  listingId: string,
  opts: LoadClearInputOptions = {},
): Promise<ClearInput | null> {
  const listing = (
    await db.query<{ floor_cents: number; quantity: number }>(
      'SELECT floor_cents, quantity FROM listings WHERE id = $1',
      [listingId],
    )
  ).rows[0];
  if (!listing) return null;

  // Eligibility must match isEligibleBid in @holdfast/shared. FOR UPDATE cannot lock the
  // outer-joined side, so shoppers is joined inner (shopper_id is NOT NULL) and only bids are locked.
  const { rows } = await db.query<BidRow>(
    `SELECT b.id, b.shopper_id, b.amount_cents, b.seq::text AS seq, b.status,
            b.paypal_authorization_id,
            to_char(b.placed_at AT TIME ZONE 'UTC', ${ISO_US}) AS placed_at,
            to_char(b.authorized_at AT TIME ZONE 'UTC', ${ISO_US}) AS authorized_at,
            (s.is_simulated OR b.source = 'SIM') IS TRUE AS is_simulated
       FROM bids b
       JOIN shoppers s ON s.id = b.shopper_id
      WHERE b.listing_id = $1
        AND b.status = 'HELD'
        AND b.paypal_authorization_id IS NOT NULL
        AND b.paypal_authorization_id <> ''
      ORDER BY b.id
      ${opts.forUpdate ? 'FOR UPDATE OF b' : ''}`,
    [listingId],
  );

  const bids: ClearBid[] = rows.map((r) => {
    const seq = Number(r.seq);
    if (!Number.isSafeInteger(seq))
      throw new RangeError(`bid ${r.id}: seq ${r.seq} exceeds safe integer range`);
    return {
      id: r.id,
      shopperId: r.shopper_id,
      amountCents: r.amount_cents,
      seq,
      placedAt: r.placed_at,
      status: r.status,
      paypalAuthorizationId: r.paypal_authorization_id,
      authorizedAt: r.authorized_at,
      isSimulated: r.is_simulated,
    };
  });

  let oldestHoldAuthorizedAt: string | null = null;
  for (const b of bids) {
    // Same fixed-width UTC format, so string order is time order.
    if (
      b.authorizedAt &&
      (oldestHoldAuthorizedAt === null || b.authorizedAt < oldestHoldAuthorizedAt)
    ) {
      oldestHoldAuthorizedAt = b.authorizedAt;
    }
  }

  return {
    listingId,
    floorCents: listing.floor_cents,
    quantity: listing.quantity,
    bids,
    bookVersion: bookVersion(listing.floor_cents, bids),
    oldestHoldAuthorizedAt,
  };
}

/**
 * Digest of everything `clear()` reads: floor plus each eligible bid's id, shopper, amount and seq
 * (bids are already in id order). Any change to the eligible book changes it, so Clear can send it
 * back and detect `BOOK_CHANGED`.
 */
function bookVersion(floorCents: number, bids: readonly ClearBid[]): string {
  const h = createHash('sha256').update(`floor:${floorCents}\n`);
  for (const b of bids) h.update(`${b.id}|${b.shopperId}|${b.amountCents}|${b.seq}\n`);
  return h.digest('hex').slice(0, 32);
}
