import type { CancelListingResponse, ListingStatus, UpdateListingResponse } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Db, Queryable, Tx } from '../db.js';
import type { Actor, MoneyDeps } from '../money/deps.js';
import { emit } from '../money/emit.js';
import { lockBids, lockListing } from '../money/locks.js';
import type { BidRow, ListingRow } from '../money/rows.js';
import { transition } from '../money/transition.js';
import { emitVoided, voidBid, voidKey, type VoidBidResult } from '../money/void.js';
import { isUuid } from '../tenancy.js';

/**
 * Listing cancel and quantity raise (HF-012b; features/02 §Edge cases, api.md §`/cancel`,
 * §`PATCH /listings/:id`, data-model §Listing, §Locking rules 2, 5, 8).
 *
 *   cancelListing         one transaction with the D2 locks Clear and Expire use: the conditional
 *                         `UPDATE listings SET status='CANCELLED' WHERE status IN ('OPEN','ROUNDS')`,
 *                         then every HELD bid `FOR UPDATE` → VOIDING (`void-<bidId>`), every
 *                         PENDING_APPROVAL bid → ABANDONED. After COMMIT the voids run in-process,
 *                         at most 10 at a time, through `voidBid` (HF-003a). No VOID settlement
 *                         rows (D4). A void PayPal keeps refusing leaves its bid VOIDING for the
 *                         HF-034 sweeper; a hold still landing is voided by `landHold` (D1), since
 *                         a CANCELLED listing is not biddable.
 *   raiseListingQuantity  `quantity` up only, only while OPEN; floor and window stay locked.
 *
 * `void_reason` is `CANCELLED` (the schema's CHECK has no listing-specific value); the audit rows
 * carry `cause: 'LISTING_CANCELLED'` to tell a brand cancel from a shopper cancel.
 */

/** Concurrent PayPal voids after a cancel (M7, api.md §`/cancel`: concurrency ≤ 10). */
export const CANCEL_VOID_CONCURRENCY = 10;
const CANCEL_CAUSE = 'LISTING_CANCELLED';
/** Server-side holds: the create call itself authorizes, so an outcome may still be unknown. */
const SERVER_HOLD_METHODS = ['VAULT', 'TEST_CARD'];
/** Deadlock / serialization failure: nothing was persisted, safe to run again. */
const RETRYABLE_PG_CODES = new Set(['40P01', '40001']);
const MAX_TX_ATTEMPTS = 3;

export interface CancelListingDeps extends MoneyDeps {
  /** Concurrent voids after COMMIT (default and maximum 10). */
  voidConcurrency?: number;
  /** Test seam: runs inside the transaction after the listing and bids are locked. */
  afterLocks?: (tx: Tx) => Promise<void>;
}

export interface CancelListingInput {
  listingId: string;
  /** Tenant from the session: another brand's listing is NOT_FOUND. */
  brandId: string;
  actor: Actor;
}

export type CancelListingError =
  | { code: 'NOT_FOUND' }
  /** The listing is not OPEN or ROUNDS (DRAFT, CLEARING, already CANCELLED, …). */
  | { code: 'STATE_CONFLICT'; reason: 'NOT_CANCELLABLE'; status: ListingStatus };

export interface ReleaseSummary {
  voided: string[];
  /** PayPal kept failing (or the call threw): left VOIDING for the HF-034 sweeper. */
  leftVoiding: string[];
}

export type CancelListingOutcome =
  | {
      ok: true;
      response: CancelListingResponse;
      /** Resolves when every void has finished or been left VOIDING for the sweeper. Never rejects. */
      released: Promise<ReleaseSummary>;
    }
  | { ok: false; error: CancelListingError };

class Refused extends Error {
  constructor(readonly error: CancelListingError) {
    super(error.code);
  }
}

interface Committed {
  response: CancelListingResponse;
  voiding: string[];
}

/** `POST /api/listings/:id/cancel`: commit CANCELLED, answer at once, void in the background. */
export async function cancelListing(
  deps: CancelListingDeps,
  input: CancelListingInput,
): Promise<CancelListingOutcome> {
  if (!isUuid(input.listingId)) return { ok: false, error: { code: 'NOT_FOUND' } };
  // Tenant and existence first, without locks (brand_id never changes).
  const head = (
    await deps.db.pool.query<{ brand_id: string }>('SELECT brand_id FROM listings WHERE id = $1', [
      input.listingId,
    ])
  ).rows[0];
  if (!head || head.brand_id !== input.brandId) return { ok: false, error: { code: 'NOT_FOUND' } };

  let committed: Committed | undefined;
  for (let attempt = 1; !committed; attempt++) {
    try {
      committed = await deps.db.tx((tx) => cancelTx(deps, tx, input));
    } catch (err) {
      if (err instanceof Refused) return { ok: false, error: err.error };
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE_PG_CODES.has(code) && attempt < MAX_TX_ATTEMPTS) continue;
      throw err;
    }
  }

  const released = releaseCancelledHolds(deps, committed.voiding, input.actor);
  return { ok: true, response: committed.response, released };
}

async function cancelTx(
  deps: CancelListingDeps,
  tx: Tx,
  input: CancelListingInput,
): Promise<Committed> {
  // 1. Listing: OPEN/ROUNDS → CANCELLED. Waits for any landHold holding it FOR SHARE (D1, D2).
  const listing = await lockListing(tx, input.listingId, 'close', 'CANCELLED');
  if (!listing) {
    const res = await tx.query<{ status: ListingStatus }>(
      'SELECT status FROM listings WHERE id = $1',
      [input.listingId],
    );
    throw new Refused({
      code: 'STATE_CONFLICT',
      reason: 'NOT_CANCELLABLE',
      status: res.rows[0]!.status,
    });
  }
  // Rounds start once, from OPEN only, and set rounds_started_at: it tells ROUNDS from OPEN.
  const from = listing.rounds_started_at ? 'ROUNDS' : 'OPEN';

  // 2. Every HELD bid, in id order. Clear, the watcher, pause and raise now wait for us.
  const held = await lockBids(tx, input.listingId);
  await deps.afterLocks?.(tx);

  // 3. HELD → VOIDING with void-<bidId> (D4). `bid.voided` goes out on COMMIT.
  const voiding: string[] = [];
  for (const row of held) {
    const bid = await transition<'bids', BidRow>(tx, 'bids', row.id, 'HELD', 'VOIDING', {
      void_reason: 'CANCELLED',
      void_request_id: voidKey(row.id),
    });
    if (!bid) continue; // Unreachable while locked; `transition` is the only status writer.
    await emitVoided(tx, bid);
    await deps.audit?.(tx, {
      actor: input.actor,
      action: 'BID_VOID_REQUESTED',
      entity: 'bid',
      entityId: bid.id,
      listingId: bid.listing_id,
      paypalId: bid.paypal_authorization_id,
      requestId: voidKey(bid.id),
      data: { reason: 'CANCELLED', cause: CANCEL_CAUSE },
    });
    voiding.push(bid.id);
  }

  // 4. PENDING_APPROVAL → ABANDONED: no hold exists yet. A hold that lands later meets a
  //    CANCELLED listing in landHold and is voided there. Server-side holds (VAULT / TEST_CARD)
  //    may have a create call in flight, so they also get needs_reconcile for the sweeper.
  const pending = await tx.query<{ id: string }>(
    `SELECT id FROM bids WHERE listing_id = $1 AND status = 'PENDING_APPROVAL' ORDER BY id FOR UPDATE`,
    [input.listingId],
  );
  let abandoned = 0;
  for (const { id } of pending.rows) {
    const bid = await transition<'bids', BidRow>(tx, 'bids', id, 'PENDING_APPROVAL', 'ABANDONED', {
      void_reason: 'CANCELLED',
    });
    if (!bid) continue;
    if (SERVER_HOLD_METHODS.includes(String(bid.payment_method))) {
      await tx.query(`UPDATE bids SET needs_reconcile = true WHERE id = $1`, [id]);
    }
    await deps.audit?.(tx, {
      actor: input.actor,
      action: 'BID_ABANDONED',
      entity: 'bid',
      entityId: bid.id,
      listingId: bid.listing_id,
      paypalId: bid.paypal_order_id,
      data: { reason: 'CANCELLED', cause: CANCEL_CAUSE, paymentMethod: bid.payment_method },
    });
    abandoned++;
  }

  const response: CancelListingResponse = {
    listingId: listing.id,
    status: 'CANCELLED',
    from,
    voiding: voiding.length,
    abandoned,
  };
  await audit(tx, {
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    brandId: listing.brand_id,
    listingId: listing.id,
    entity: 'listing',
    entityId: listing.id,
    action: 'LISTING_CANCELLED',
    data: { from, to: 'CANCELLED', voiding: voiding.length, abandoned },
  });
  await emit(tx, listing.id, {
    type: 'listing.status',
    listingId: listing.id,
    at: listing.db_now.toISOString(),
    from,
    to: 'CANCELLED',
  });
  return { response, voiding };
}

/**
 * Run the PayPal voids for bids the cancel moved to VOIDING, outside any transaction (INV-1), at
 * most `voidConcurrency` (≤ 10) at a time. `voidBid(…, { resume: true })` makes the one call with
 * `void-<bidId>`, retries TRANSIENT failures (D11), writes `BID_VOIDED` with the authorization id
 * and emits `bid.voided`. A bid PayPal keeps refusing stays VOIDING (never HELD) for the sweeper.
 */
export async function releaseCancelledHolds(
  deps: CancelListingDeps,
  bidIds: readonly string[],
  actor: Actor,
): Promise<ReleaseSummary> {
  const out: ReleaseSummary = { voided: [], leftVoiding: [] };
  const queue = [...bidIds];
  const limit = Math.max(
    1,
    Math.min(deps.voidConcurrency ?? CANCEL_VOID_CONCURRENCY, CANCEL_VOID_CONCURRENCY),
  );
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      let r: VoidBidResult;
      try {
        r = await voidBid(deps, id, 'CANCELLED', actor, { resume: true });
      } catch {
        out.leftVoiding.push(id);
        continue;
      }
      if (r.outcome === 'VOIDED' || r.outcome === 'ALREADY_VOIDED') out.voided.push(id);
      else out.leftVoiding.push(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  return out;
}

// --- Quantity raise -------------------------------------------------------------------------------

export interface RaiseQuantityInput {
  listingId: string;
  brandId: string;
  quantity: number;
  actor: Actor;
}

export type RaiseQuantityError =
  | { code: 'NOT_FOUND' }
  | {
      code: 'VALIDATION_ERROR';
      field: 'quantity';
      reason: 'QUANTITY_NOT_INCREASED';
      currentQuantity: number;
    }
  | { code: 'STATE_CONFLICT'; reason: 'NOT_OPEN'; status: ListingStatus };

export type RaiseQuantityResult =
  { ok: true; value: UpdateListingResponse } | { ok: false; error: RaiseQuantityError };

/**
 * `PATCH /api/listings/:id {quantity}`: raise only, while OPEN (02 §Edge cases). A DRAFT has no
 * bids yet, so its quantity can be set either way (v4 §2.2 "Edit" on a draft; audited
 * `LISTING_DRAFT_UPDATED`, no event). The listing row is
 * locked `FOR UPDATE`, so a concurrent cancel, Clear or rounds start either waits for this or wins
 * first and this answers STATE_CONFLICT. Audits `LISTING_QUANTITY_RAISED`, emits `listing.updated`.
 */
export async function raiseListingQuantity(
  db: Db,
  input: RaiseQuantityInput,
): Promise<RaiseQuantityResult> {
  if (!isUuid(input.listingId)) return { ok: false, error: { code: 'NOT_FOUND' } };
  return db.tx(async (tx): Promise<RaiseQuantityResult> => {
    const { rows } = await tx.query<ListingRow & { db_now: Date }>(
      `SELECT l.*, clock_timestamp() AS db_now FROM listings l
        WHERE l.id = $1 AND l.brand_id = $2 FOR UPDATE`,
      [input.listingId, input.brandId],
    );
    const listing = rows[0];
    if (!listing) return { ok: false, error: { code: 'NOT_FOUND' } };
    if (listing.status === 'DRAFT') {
      await tx.query(`UPDATE listings SET quantity = $2 WHERE id = $1 AND status = 'DRAFT'`, [
        listing.id,
        input.quantity,
      ]);
      await audit(tx, {
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        brandId: listing.brand_id,
        listingId: listing.id,
        entity: 'listing',
        entityId: listing.id,
        action: 'LISTING_DRAFT_UPDATED',
        data: { from: listing.quantity, to: input.quantity },
      });
      return {
        ok: true,
        value: {
          listingId: listing.id,
          status: 'DRAFT',
          previousQuantity: listing.quantity,
          quantity: input.quantity,
        },
      };
    }
    if (listing.status !== 'OPEN') {
      return {
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'NOT_OPEN', status: listing.status },
      };
    }
    if (input.quantity <= listing.quantity) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          field: 'quantity',
          reason: 'QUANTITY_NOT_INCREASED',
          currentQuantity: listing.quantity,
        },
      };
    }
    await tx.query(`UPDATE listings SET quantity = $2 WHERE id = $1 AND status = 'OPEN'`, [
      listing.id,
      input.quantity,
    ]);
    await auditRaise(tx, listing, input);
    await emit(tx, listing.id, {
      type: 'listing.updated',
      listingId: listing.id,
      at: listing.db_now.toISOString(),
      previousQuantity: listing.quantity,
      quantity: input.quantity,
    });
    return {
      ok: true,
      value: {
        listingId: listing.id,
        status: 'OPEN',
        previousQuantity: listing.quantity,
        quantity: input.quantity,
      },
    };
  });
}

async function auditRaise(
  tx: Queryable,
  listing: ListingRow,
  input: RaiseQuantityInput,
): Promise<void> {
  await audit(tx, {
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    brandId: listing.brand_id,
    listingId: listing.id,
    entity: 'listing',
    entityId: listing.id,
    action: 'LISTING_QUANTITY_RAISED',
    data: { from: listing.quantity, to: input.quantity },
  });
}
