import type { BidStatus, ListingStatus, VoidReason } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Actor, MoneyDeps } from '../money/deps.js';
import { callVoid, voidBid, voidKey } from '../money/void.js';
import type { PayPalClient } from '../paypal/types.js';
import { runLimited } from '../settlement/settle-listing.js';

/**
 * `reconcile:holds` (HF-034, D19, P0; data-model rule 11). For every bid with an authorization id
 * that isn't CAPTURED, GET the authorization from PayPal; if it is still CREATED and the bid isn't
 * live, void it with `void-<bidId>`. This is the backstop that catches what the DB got wrong
 * (e.g. a row that says VOIDED while PayPal still holds the money). `demo:reset` (HF-046) runs
 * sweep → `reconcileHolds` → checks `stillCreated` is empty → truncates.
 *
 * Live (never voided here): HELD on an OPEN / ROUNDS listing, WON, LOST on a CLEARING listing
 * (reserve for promotion), and PENDING_APPROVAL younger than 30 min (a landing in flight).
 */

const SYSTEM: Actor = { type: 'SYSTEM', id: 'reconcile:holds' };
export const RECONCILE_CONCURRENCY = 5;
const PENDING_LIVE_SECONDS = 30 * 60;

export interface ReconcileHoldsDeps extends MoneyDeps {
  paypal: Pick<PayPalClient, 'getAuthorization' | 'void'>;
}

export interface ReconcileHoldsOptions {
  concurrency?: number;
  /** Only these listings (default: every listing). */
  listingIds?: readonly string[];
  /** GET only; never void (report what would be voided). */
  dryRun?: boolean;
  onError?: (err: unknown, bidId: string) => void;
}

export interface ReconciledHold {
  bidId: string;
  listingId: string;
  authorizationId: string;
  bidStatus: BidStatus;
}

export interface ReconcileHoldsResult {
  /** Authorizations GET-checked. */
  checked: number;
  /** CREATED at PayPal (live and dead). */
  created: number;
  /** CREATED but live: left alone. */
  live: number;
  /** CREATED, not live, voided now. */
  voided: number;
  /** GET or void failed. */
  failed: number;
  /** CREATED, not live, and not voided (failed or dry run). Empty means nothing dangles. */
  stillCreated: ReconciledHold[];
}

interface Candidate {
  id: string;
  listing_id: string;
  status: BidStatus;
  void_reason: VoidReason | null;
  paypal_authorization_id: string;
  listing_status: ListingStatus;
  pending_fresh: boolean;
}

export function isLiveHold(
  c: Pick<Candidate, 'status' | 'listing_status' | 'pending_fresh'>,
): boolean {
  switch (c.status) {
    case 'HELD':
      return c.listing_status === 'OPEN' || c.listing_status === 'ROUNDS';
    case 'WON':
      return true;
    case 'LOST':
      return c.listing_status === 'CLEARING';
    case 'PENDING_APPROVAL':
      return c.pending_fresh;
    default:
      return false;
  }
}

export async function reconcileHolds(
  deps: ReconcileHoldsDeps,
  opts: ReconcileHoldsOptions = {},
): Promise<ReconcileHoldsResult> {
  const rows = (
    await deps.db.pool.query(
      `SELECT b.id, b.listing_id, b.status, b.void_reason, b.paypal_authorization_id,
              l.status AS listing_status,
              (b.updated_at > now() - make_interval(secs => $2)) AS pending_fresh
         FROM bids b JOIN listings l ON l.id = b.listing_id
        WHERE b.paypal_authorization_id IS NOT NULL
          AND b.status NOT IN ('CAPTURED', 'SHIPPED')
          AND ($1::uuid[] IS NULL OR b.listing_id = ANY($1::uuid[]))
        ORDER BY b.id`,
      [opts.listingIds ? [...opts.listingIds] : null, PENDING_LIVE_SECONDS],
    )
  ).rows as Candidate[];

  const out: ReconcileHoldsResult = {
    checked: 0,
    created: 0,
    live: 0,
    voided: 0,
    failed: 0,
    stillCreated: [],
  };
  await runLimited(rows, opts.concurrency ?? RECONCILE_CONCURRENCY, async (c) => {
    const hold: ReconciledHold = {
      bidId: c.id,
      listingId: c.listing_id,
      authorizationId: c.paypal_authorization_id,
      bidStatus: c.status,
    };
    let status: string;
    try {
      status = (await deps.paypal.getAuthorization(c.paypal_authorization_id)).status;
      out.checked++;
    } catch (err) {
      out.failed++;
      opts.onError?.(err, c.id);
      return;
    }
    if (status !== 'CREATED') return;
    out.created++;
    if (isLiveHold(c)) {
      out.live++;
      return;
    }
    if (opts.dryRun) {
      out.stillCreated.push(hold);
      return;
    }
    try {
      if (await release(deps, c)) out.voided++;
      else {
        out.failed++;
        out.stillCreated.push(hold);
      }
    } catch (err) {
      out.failed++;
      out.stillCreated.push(hold);
      opts.onError?.(err, c.id);
    }
  });

  await audit(deps.db.pool, {
    actorType: SYSTEM.type,
    actorId: SYSTEM.id,
    entity: 'cron',
    action: 'RECONCILE_HOLDS_RUN',
    data: {
      checked: out.checked,
      created: out.created,
      live: out.live,
      voided: out.voided,
      failed: out.failed,
      stillCreated: out.stillCreated.length,
      dryRun: !!opts.dryRun,
    },
  });
  return out;
}

/** Void a dead hold. Statuses with a void path use `voidBid`; end states call PayPal directly. */
async function release(deps: ReconcileHoldsDeps, c: Candidate): Promise<boolean> {
  if (
    c.status === 'HELD' ||
    c.status === 'LOST' ||
    c.status === 'CAPTURE_FAILED' ||
    c.status === 'VOIDING'
  ) {
    const reason: VoidReason =
      c.status === 'LOST'
        ? 'LOST'
        : c.status === 'CAPTURE_FAILED'
          ? 'CAPTURE_FAILED'
          : (c.void_reason ??
            (c.listing_status === 'EXPIRED'
              ? 'WINDOW_EXPIRED'
              : c.listing_status === 'CANCELLED'
                ? 'CANCELLED'
                : 'WINDOW_CLOSED'));
    const res = await voidBid(deps, c.id, reason, SYSTEM, {
      from: c.status === 'VOIDING' ? ['HELD'] : [c.status],
      resume: true,
    });
    if (res.outcome === 'VOIDED') return true;
    if (res.outcome !== 'ALREADY_VOIDED') return false;
    // The row already said VOIDED (a concurrent path): fall through and void at PayPal anyway.
  }
  // The DB says the hold is gone (VOIDED, ABANDONED, HOLD_FAILED, stale PENDING_APPROVAL), but
  // PayPal still holds it: void with the bid's own key and alert.
  const call = await callVoid(deps, c.id, c.paypal_authorization_id);
  await audit(deps.db.pool, {
    actorType: SYSTEM.type,
    actorId: SYSTEM.id,
    listingId: c.listing_id,
    entity: 'bid',
    entityId: c.id,
    action: call.done ? 'HOLD_RECONCILED' : 'HOLD_RECONCILE_FAILED',
    paypalId: c.paypal_authorization_id,
    requestId: voidKey(c.id),
    data: {
      bidStatus: c.status,
      authorizationStatus: 'CREATED',
      voided: call.done,
      ...(call.done ? {} : { code: call.code }),
      alert: true,
    },
  });
  return call.done;
}
