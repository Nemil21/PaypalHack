import { audit } from './audit.js';
import type { Queryable, Tx } from './db.js';
import type { Actor, MandateCheck, MandateRefusal, MoneyDeps } from './money/deps.js';
import type { BidRow, MandateRow } from './money/rows.js';
import { SQL_NOW, transition } from './money/transition.js';
import { emitVoided, voidBid, voidKey, type VoidBidResult } from './money/void.js';

/**
 * Mandates core (HF-017a; features/05-mandates-rolling.md §Logic 1–3, 6–7, data-model §mandates,
 * §Locking rules 3–4, D12). A mandate is the shopper's standing permission for an agent; this
 * module is the code that enforces its limits on every money path:
 *
 * - `authorize(tx, mandateId, …)`: the placement check. Locks the mandate `FOR UPDATE`; the caller
 *   inserts the PENDING_APPROVAL bid in the **same transaction**, so a parallel placement waits on
 *   the lock and then sees that bid in its sum.
 * - `landingMandateCheck`: the same rules re-checked inside `landHold` (HF-003a's default hook);
 *   a refusal there voids the new hold (`MANDATE_PAUSED`).
 * - `pauseMandate`: PAUSED, then void every **HELD** bid under it. WON / LOST bids belong to a
 *   running settlement and are left alone.
 * - `onCaptured(tx, bidId)`: called after a capture succeeds; FULFILLED once the mandate's
 *   quantity is met, and its other HELD bids are released (`FULFILLED`). `capturedMandateHook`
 *   adapts it to HF-029's `SettleBidDeps.onCaptured` (called after the capture commits).
 * - `createMandate`: ACTIVE, flagged `needs_payment_method` when the shopper has no vaulted method.
 *
 * Lock order is listing → mandate → bids by id (data-model §Locking rule 3). `onCaptured` is the
 * one caller that already holds a bid lock (the captured bid) when it takes the mandate lock. That
 * is deadlock-free because no path that locks a mandate first ever locks a WON / CAPTURED bid:
 * `landHold` locks its PENDING_APPROVAL bid and a HELD replaced bid, pause and fulfilment lock
 * HELD bids only.
 */

/** Bid statuses whose amounts count toward `total_hold_cap_cents` (D12). */
export const MANDATE_CAP_STATUSES = ['PENDING_APPROVAL', 'HELD', 'WON', 'LOST'] as const;

/** Statuses of a bid whose capture succeeded (it counts toward the mandate's quantity). */
const CAPTURED_STATUSES = ['CAPTURED', 'SHIPPED'] as const;

/** Items a mandate buys before it is FULFILLED. There is no column yet: one item (05 §Logic 7). */
export const DEFAULT_MANDATE_QUANTITY = 1;

/** Default lifetime of a new mandate (05 §Logic 1). */
export const DEFAULT_MANDATE_DAYS = 30;

/** How many PayPal voids a pause / fulfilment fan-out runs at once. */
const RELEASE_CONCURRENCY = 5;

/**
 * Why a mandate refuses a hold. `ABOVE_MANDATE_MAX` and `MANDATE_EXCEEDED` are API error codes
 * (api.md); the rest map to `MANDATE_PAUSED` / `MANDATE_EXCEEDED` with a reason.
 */
export type MandateDenial =
  /** No such mandate, or it belongs to another shopper. */
  | 'MANDATE_NOT_FOUND'
  /** PAUSED, FULFILLED or EXPIRED. */
  | 'MANDATE_INACTIVE'
  /** ACTIVE but past `expires_at` (DB time). */
  | 'MANDATE_EXPIRED'
  /** The new hold is above `max_price_cents` (per item). */
  | 'ABOVE_MANDATE_MAX'
  /** Live holds + the new hold would pass `total_hold_cap_cents`. */
  | 'MANDATE_EXCEEDED'
  /** The listing's product is not in `allowed_product_ids`. */
  | 'PRODUCT_NOT_ALLOWED';

export interface MandateLimitsInput {
  /** The amount of the hold being placed. */
  newHoldCents: number;
  /** Sum of the mandate's live holds (D12), excluding the new bid and any bid it replaces. */
  liveCents: number;
  productId: string;
  now: Date;
}

/**
 * The mandate rules as a pure function (05 §Logic 3). Null means the hold is allowed.
 * An empty `allowed_product_ids` means the mandate is not restricted to a product set.
 */
export function checkMandateLimits(
  mandate: Pick<
    MandateRow,
    'status' | 'expires_at' | 'max_price_cents' | 'total_hold_cap_cents'
  > & { allowed_product_ids?: readonly string[] | null },
  { newHoldCents, liveCents, productId, now }: MandateLimitsInput,
): MandateDenial | null {
  if (mandate.status !== 'ACTIVE') return 'MANDATE_INACTIVE';
  if (mandate.expires_at && new Date(mandate.expires_at).getTime() <= now.getTime()) {
    return 'MANDATE_EXPIRED';
  }
  if (newHoldCents > mandate.max_price_cents) return 'ABOVE_MANDATE_MAX';
  if (liveCents + newHoldCents > mandate.total_hold_cap_cents) return 'MANDATE_EXCEEDED';
  const allowed = mandate.allowed_product_ids ?? [];
  if (allowed.length > 0 && !allowed.includes(productId)) return 'PRODUCT_NOT_ALLOWED';
  return null;
}

/**
 * D12 live holds: `SUM(amount_cents) WHERE mandate_id=$1 AND status IN ('PENDING_APPROVAL',
 * 'HELD','WON','LOST') AND id NOT IN (excluded)`. Exclude the bid a raise replaces, and (at
 * landing) the bid being landed, which is counted as the new hold instead.
 */
export async function liveHoldCents(
  q: Queryable,
  mandateId: string,
  excludeBidIds: readonly (string | null | undefined)[] = [],
): Promise<number> {
  const excluded = excludeBidIds.filter((id): id is string => !!id);
  const res = await q.query(
    `SELECT coalesce(sum(amount_cents), 0)::bigint AS live
       FROM bids
      WHERE mandate_id = $1 AND status = ANY($2::text[]) AND NOT (id = ANY($3::uuid[]))`,
    [mandateId, MANDATE_CAP_STATUSES, excluded],
  );
  return Number((res.rows[0] as { live: string }).live);
}

export type LockedMandate = MandateRow & {
  allowed_product_ids: string[];
  needs_payment_method: boolean;
  db_now: Date;
};

/** `SELECT … FROM mandates WHERE id=$1 FOR UPDATE`, with the database clock. */
async function lockMandateRow(tx: Queryable, mandateId: string): Promise<LockedMandate | null> {
  const res = await tx.query(
    `SELECT m.*, clock_timestamp() AS db_now FROM mandates m WHERE m.id = $1 FOR UPDATE`,
    [mandateId],
  );
  return (res.rows[0] as LockedMandate | undefined) ?? null;
}

export interface AuthorizeInput {
  newHoldCents: number;
  /** A raise / roll: the bid being replaced does not count toward the cap (D12). */
  replacedBidId?: string | null;
  /** The product of the listing the hold is for. */
  productId: string;
  /** When set, a mandate owned by another shopper is `MANDATE_NOT_FOUND`. */
  shopperId?: string;
}

export type AuthorizeResult =
  | {
      ok: true;
      mandate: LockedMandate;
      /** Live holds before the new one (replaced bid excluded). */
      liveCents: number;
      /**
       * No vaulted payment method yet: agent / MCP money tools must not hold on their own, they
       * fall back to a shopper-confirmed hold (05 §Logic 2).
       */
      confirmRequired: boolean;
    }
  | { ok: false; denial: MandateDenial; mandate: LockedMandate | null };

/**
 * Check a new hold against a mandate (05 §Logic 3, D12). **Call inside the transaction that
 * inserts the PENDING_APPROVAL bid, before the insert**: the mandate stays locked `FOR UPDATE`
 * until that transaction commits, so concurrent placements under one mandate are serialized and
 * each one counts the others' PENDING_APPROVAL rows. Only call it when the bid has a mandate.
 */
export async function authorize(
  tx: Tx | Queryable,
  mandateId: string,
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  const mandate = await lockMandateRow(tx, mandateId);
  if (!mandate || (input.shopperId && mandate.shopper_id !== input.shopperId)) {
    return { ok: false, denial: 'MANDATE_NOT_FOUND', mandate: null };
  }
  const liveCents = await liveHoldCents(tx, mandateId, [input.replacedBidId]);
  const denial = checkMandateLimits(mandate, {
    newHoldCents: input.newHoldCents,
    liveCents,
    productId: input.productId,
    now: mandate.db_now,
  });
  if (denial) return { ok: false, denial, mandate };
  return { ok: true, mandate, liveCents, confirmRequired: mandate.needs_payment_method };
}

/** How `landHold` records a denial (it voids the hold with `void_reason = MANDATE_PAUSED`). */
export function landingRefusal(denial: MandateDenial): MandateRefusal {
  switch (denial) {
    case 'ABOVE_MANDATE_MAX':
    case 'MANDATE_EXCEEDED':
    case 'PRODUCT_NOT_ALLOWED':
      return 'MANDATE_CAP';
    default:
      return 'MANDATE_PAUSED';
  }
}

/**
 * The re-check inside `landHold` (data-model §Locking rule 3), run with the mandate locked
 * `FOR UPDATE` and the PENDING_APPROVAL bid already in the table: the bid is counted as the new
 * hold, the bid a raise replaces is excluded. HF-003a's `landHold` uses it by default.
 */
export const landingMandateCheck: MandateCheck = async (
  tx,
  { mandate, bid, replacesBidId, now },
) => {
  const res = await tx.query(`SELECT product_id FROM listings WHERE id = $1`, [bid.listing_id]);
  const productId = (res.rows[0] as { product_id: string } | undefined)?.product_id ?? '';
  const liveCents = await liveHoldCents(tx, mandate.id, [bid.id, replacesBidId]);
  const denial = checkMandateLimits(mandate as LockedMandate, {
    newHoldCents: bid.amount_cents,
    liveCents,
    productId,
    now,
  });
  return denial ? landingRefusal(denial) : null;
};

/**
 * In the caller's transaction (mandate already locked): every HELD bid under the mandate, in id
 * order, HELD → VOIDING with `void-<bidId>`, `bid.voided` emitted on COMMIT. Returns their ids;
 * the PayPal voids run after COMMIT (`releaseMandateHolds`), and the sweeper (HF-034) finishes any
 * left VOIDING. WON / LOST bids are never touched.
 */
async function flipHeldBids(
  deps: Pick<MoneyDeps, 'audit'>,
  tx: Queryable,
  mandateId: string,
  reason: 'MANDATE_PAUSED' | 'FULFILLED',
  actor: Actor,
  exceptBidId: string | null = null,
): Promise<string[]> {
  const res = await tx.query(
    `SELECT id FROM bids WHERE mandate_id = $1 AND status = 'HELD' AND id IS DISTINCT FROM $2
      ORDER BY id FOR UPDATE`,
    [mandateId, exceptBidId],
  );
  const ids: string[] = [];
  for (const { id } of res.rows as { id: string }[]) {
    const bid = await transition<'bids', BidRow>(tx, 'bids', id, 'HELD', 'VOIDING', {
      void_reason: reason,
      void_request_id: voidKey(id),
    });
    if (!bid) continue;
    await emitVoided(tx, bid);
    await deps.audit?.(tx, {
      actor,
      action: 'BID_VOID_REQUESTED',
      entity: 'bid',
      entityId: bid.id,
      listingId: bid.listing_id,
      paypalId: bid.paypal_authorization_id,
      requestId: voidKey(bid.id),
      data: { reason, mandateId },
    });
    ids.push(bid.id);
  }
  return ids;
}

export interface ReleaseResult {
  voided: string[];
  /** PayPal kept failing: left VOIDING for the sweeper. */
  leftVoiding: string[];
}

/**
 * Run the PayPal voids for bids `flipHeldBids` moved to VOIDING (outside any transaction, INV-1),
 * a few at a time. Each uses `void-<bidId>`, so a retry or the sweeper never voids twice.
 */
export async function releaseMandateHolds(
  deps: MoneyDeps,
  bidIds: readonly string[],
  reason: 'MANDATE_PAUSED' | 'FULFILLED',
  actor: Actor,
): Promise<ReleaseResult> {
  const out: ReleaseResult = { voided: [], leftVoiding: [] };
  const queue = [...bidIds];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      let r: VoidBidResult;
      try {
        r = await voidBid(deps, id, reason, actor, { resume: true });
      } catch {
        out.leftVoiding.push(id);
        continue;
      }
      if (r.outcome === 'VOIDED' || r.outcome === 'ALREADY_VOIDED') out.voided.push(id);
      else if (r.outcome === 'LEFT_VOIDING') out.leftVoiding.push(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RELEASE_CONCURRENCY, queue.length) }, worker));
  return out;
}

async function auditMandate(
  tx: Queryable,
  actor: Actor,
  mandateId: string,
  action: string,
  data: Record<string, unknown>,
): Promise<void> {
  await audit(tx, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    entity: 'mandate',
    entityId: mandateId,
    action,
    data,
  });
}

export interface PauseMandateOptions {
  actor: Actor;
  /** When set, a mandate owned by another shopper is NOT_FOUND. */
  shopperId?: string;
  /** Recorded in the audit row; revoke and pause both end PAUSED (05 §Logic 6). */
  revoke?: boolean;
}

export type PauseMandateResult =
  | { ok: true; mandate: MandateRow; alreadyPaused: boolean; release: ReleaseResult }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'STATE_CONFLICT'; status: string };

/**
 * Pause or revoke (05 §Logic 6): ACTIVE → PAUSED and every HELD bid under the mandate → VOIDING
 * (`MANDATE_PAUSED`) in one transaction, audit `MANDATE_PAUSED`; then the PayPal voids. A hold in
 * flight (PENDING_APPROVAL) is refused by `landHold`, which sees PAUSED, and voided there.
 * Pausing a PAUSED mandate is a no-op that re-releases any HELD bid left over.
 */
export async function pauseMandate(
  deps: MoneyDeps,
  mandateId: string,
  opts: PauseMandateOptions,
): Promise<PauseMandateResult> {
  const step = await deps.db.tx(async (tx) => {
    const current = await lockMandateRow(tx, mandateId);
    if (!current || (opts.shopperId && current.shopper_id !== opts.shopperId)) {
      return { ok: false as const, code: 'NOT_FOUND' as const };
    }
    if (current.status !== 'ACTIVE' && current.status !== 'PAUSED') {
      return { ok: false as const, code: 'STATE_CONFLICT' as const, status: current.status };
    }
    let mandate: MandateRow = current;
    const alreadyPaused = current.status === 'PAUSED';
    if (!alreadyPaused) {
      const paused = await transition<'mandates', MandateRow>(
        tx,
        'mandates',
        mandateId,
        'ACTIVE',
        'PAUSED',
        { paused_at: SQL_NOW },
      );
      if (!paused) throw new Error(`pauseMandate: ${mandateId} left ACTIVE under its own lock`);
      mandate = paused;
    }
    const bidIds = await flipHeldBids(deps, tx, mandateId, 'MANDATE_PAUSED', opts.actor);
    if (!alreadyPaused) {
      await auditMandate(tx, opts.actor, mandateId, 'MANDATE_PAUSED', {
        revoke: opts.revoke ?? false,
        voidingBidIds: bidIds,
      });
    }
    return { ok: true as const, mandate, alreadyPaused, bidIds };
  });
  if (!step.ok) return step;
  const release = await releaseMandateHolds(deps, step.bidIds, 'MANDATE_PAUSED', opts.actor);
  return { ok: true, mandate: step.mandate, alreadyPaused: step.alreadyPaused, release };
}

export type RevokeMandateResult =
  | { ok: true; mandate: MandateRow; alreadyRevoked: boolean; release: ReleaseResult }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'STATE_CONFLICT'; status: string };

/**
 * Revoke (v4 §3.2): ACTIVE or PAUSED → REVOKED (terminal) and every HELD bid under the mandate →
 * VOIDING (`MANDATE_PAUSED`, the existing "mandate stopped" void reason) in one transaction, audit
 * `MANDATE_REVOKED`; then the PayPal voids. A hold in flight is refused by `landHold`, which sees a
 * non-ACTIVE mandate. Revoking a REVOKED mandate is a no-op that re-releases any HELD bid left
 * over; FULFILLED and EXPIRED are STATE_CONFLICT.
 */
export async function revokeMandate(
  deps: MoneyDeps,
  mandateId: string,
  opts: Omit<PauseMandateOptions, 'revoke'>,
): Promise<RevokeMandateResult> {
  const step = await deps.db.tx(async (tx) => {
    const current = await lockMandateRow(tx, mandateId);
    if (!current || (opts.shopperId && current.shopper_id !== opts.shopperId)) {
      return { ok: false as const, code: 'NOT_FOUND' as const };
    }
    const alreadyRevoked = current.status === 'REVOKED';
    if (!alreadyRevoked && current.status !== 'ACTIVE' && current.status !== 'PAUSED') {
      return { ok: false as const, code: 'STATE_CONFLICT' as const, status: current.status };
    }
    let mandate: MandateRow = current;
    if (!alreadyRevoked) {
      const revoked = await transition<'mandates', MandateRow>(
        tx,
        'mandates',
        mandateId,
        ['ACTIVE', 'PAUSED'],
        'REVOKED',
        { revoked_at: SQL_NOW },
      );
      if (!revoked) throw new Error(`revokeMandate: ${mandateId} changed under its own lock`);
      mandate = revoked;
    }
    const bidIds = await flipHeldBids(deps, tx, mandateId, 'MANDATE_PAUSED', opts.actor);
    if (!alreadyRevoked) {
      await auditMandate(tx, opts.actor, mandateId, 'MANDATE_REVOKED', {
        from: current.status,
        voidingBidIds: bidIds,
      });
    }
    return { ok: true as const, mandate, alreadyRevoked, bidIds };
  });
  if (!step.ok) return step;
  const release = await releaseMandateHolds(deps, step.bidIds, 'MANDATE_PAUSED', opts.actor);
  return { ok: true, mandate: step.mandate, alreadyRevoked: step.alreadyRevoked, release };
}

export interface OnCapturedResult {
  mandateId: string | null;
  /** The mandate is FULFILLED (by this call or before it). */
  fulfilled: boolean;
  /** Bids moved HELD → VOIDING(`FULFILLED`); pass them to `releaseMandateHolds` after COMMIT. */
  releaseBidIds: string[];
}

/**
 * Fulfilment hook (05 §Logic 7, M8). HF-029 calls it in the transaction that records a successful
 * capture of `bidId`, then, after COMMIT, `releaseMandateHolds(deps, releaseBidIds, 'FULFILLED')`.
 * When the mandate's quantity of captured bids is met it becomes FULFILLED (from ACTIVE or PAUSED)
 * and its other HELD bids move to VOIDING(`FULFILLED`). No PayPal call here (INV-1).
 */
export async function onCaptured(
  tx: Tx | Queryable,
  bidId: string,
  {
    actor = { type: 'WORKFLOW' },
    audit: auditHook,
  }: { actor?: Actor } & Pick<MoneyDeps, 'audit'> = {},
): Promise<OnCapturedResult> {
  const res = await tx.query(`SELECT mandate_id FROM bids WHERE id = $1`, [bidId]);
  const mandateId = (res.rows[0] as { mandate_id: string | null } | undefined)?.mandate_id ?? null;
  if (!mandateId) return { mandateId: null, fulfilled: false, releaseBidIds: [] };

  const mandate = await lockMandateRow(tx, mandateId);
  if (!mandate) return { mandateId, fulfilled: false, releaseBidIds: [] };

  let fulfilled = mandate.status === 'FULFILLED';
  if (!fulfilled && (mandate.status === 'ACTIVE' || mandate.status === 'PAUSED')) {
    const count = await tx.query(
      `SELECT count(*)::int AS n FROM bids
        WHERE mandate_id = $1 AND (status = ANY($2::text[]) OR id = $3)`,
      [mandateId, CAPTURED_STATUSES, bidId],
    );
    const captured = (count.rows[0] as { n: number }).n;
    const quantity = Number(mandate.quantity ?? DEFAULT_MANDATE_QUANTITY);
    if (captured >= quantity) {
      const done = await transition<'mandates', MandateRow>(
        tx,
        'mandates',
        mandateId,
        ['ACTIVE', 'PAUSED'],
        'FULFILLED',
        { fulfilled_at: SQL_NOW },
      );
      fulfilled = !!done;
      if (done) {
        await auditMandate(tx, actor, mandateId, 'MANDATE_FULFILLED', { bidId, captured });
      }
    }
  }
  if (!fulfilled) return { mandateId, fulfilled, releaseBidIds: [] };
  const releaseBidIds = await flipHeldBids(
    { audit: auditHook },
    tx,
    mandateId,
    'FULFILLED',
    actor,
    bidId,
  );
  return { mandateId, fulfilled, releaseBidIds };
}

/**
 * `SettleBidDeps.onCaptured` for HF-029's `settleBid`, which calls it after the capture commits:
 * runs `onCaptured` in its own transaction, then releases the mandate's other holds. Wire it as
 * `{ ...settleDeps, onCaptured: capturedMandateHook(moneyDeps) }`.
 */
export function capturedMandateHook(
  deps: MoneyDeps,
  actor: Actor = { type: 'WORKFLOW' },
): (bidId: string) => Promise<void> {
  return async (bidId) => {
    const result = await deps.db.tx((tx) => onCaptured(tx, bidId, { actor, audit: deps.audit }));
    if (result.releaseBidIds.length) {
      await releaseMandateHolds(deps, result.releaseBidIds, 'FULFILLED', actor);
    }
  };
}

export interface CreateMandateInput {
  shopperId: string;
  maxPriceCents: number;
  /** Default = `maxPriceCents` (one item at a time, 05 edge cases). */
  totalHoldCapCents?: number;
  allowedProductIds?: readonly string[];
  autoRoll?: boolean;
  notifyEveryAction?: boolean;
  /** Default: 30 days from now. */
  expiresAt?: Date | null;
  actor?: Actor;
}

export type MandateRecord = MandateRow & {
  allowed_product_ids: string[];
  auto_roll: boolean;
  notify_every_action: boolean;
  needs_payment_method: boolean;
};

/**
 * Create an ACTIVE mandate (05 §Logic 1–2) and audit `MANDATE_CREATED`. A shopper with no vaulted
 * payment method gets `needs_payment_method = true`: the mandate still sets limits, but money
 * tools fall back to confirm-required holds until a hold vaults a method (ON_SUCCESS).
 * Request validation (amount ranges, product ownership) is the API's job (HF-017b).
 */
export async function createMandate(
  q: Queryable,
  input: CreateMandateInput,
): Promise<MandateRecord> {
  const res = await q.query(
    `INSERT INTO mandates (shopper_id, max_price_cents, total_hold_cap_cents, allowed_product_ids,
                           auto_roll, notify_every_action, expires_at, needs_payment_method)
     SELECT s.id, $2, $3, $4::uuid[], $5, $6,
            COALESCE($7::timestamptz, now() + make_interval(days => $8)),
            s.paypal_vault_id IS NULL
       FROM shoppers s WHERE s.id = $1
     RETURNING *`,
    [
      input.shopperId,
      input.maxPriceCents,
      input.totalHoldCapCents ?? input.maxPriceCents,
      [...(input.allowedProductIds ?? [])],
      input.autoRoll ?? true,
      input.notifyEveryAction ?? true,
      input.expiresAt ?? null,
      DEFAULT_MANDATE_DAYS,
    ],
  );
  const mandate = res.rows[0] as MandateRecord | undefined;
  if (!mandate) throw new Error(`createMandate: shopper ${input.shopperId} not found`);
  const actor = input.actor ?? { type: 'SHOPPER', id: input.shopperId };
  await auditMandate(q, actor, mandate.id, 'MANDATE_CREATED', {
    maxPriceCents: mandate.max_price_cents,
    totalHoldCapCents: mandate.total_hold_cap_cents,
    needsPaymentMethod: mandate.needs_payment_method,
  });
  return mandate;
}

/**
 * Whether an agent / MCP money tool may place or raise a hold on its own under this mandate, or
 * must ask the shopper to confirm (05 §Logic 2; agent paths in HF-039 / HF-044a).
 */
export function mandateAutonomy(
  mandate: Pick<MandateRow, 'status'> & { needs_payment_method?: boolean },
): 'AUTONOMOUS' | 'CONFIRM_REQUIRED' {
  return mandate.status === 'ACTIVE' && !mandate.needs_payment_method
    ? 'AUTONOMOUS'
    : 'CONFIRM_REQUIRED';
}
