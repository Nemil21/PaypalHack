import { audit } from '../audit.js';
import { placeBid, type PlaceBidDeps, type PlaceBidInput, type PlaceBidResult } from '../bids.js';
import type { Queryable } from '../db.js';
import type { Actor, AuditHook } from '../money/deps.js';

/**
 * Auto-roll (HF-053; features/05-mandates-rolling.md §Logic 5, §Edge cases). Every 5 min, under
 * its advisory lock: a bid that lost, under an ACTIVE mandate with `auto_roll`, is re-placed by the
 * shopper's agent in a newly OPEN listing for an allowed product, with nobody present.
 *
 * - Only terminal **VOIDED** bids with `void_reason IN ('LOST','WINDOW_EXPIRED')` roll. A LOST bid
 *   is never rolled before its void: promotion (HF-031) can still flip LOST → WON.
 * - The roll is a vaulted merchant-initiated hold (`card.vault_id` + `stored_credential
 *   {MERCHANT, UNSCHEDULED, SUBSEQUENT}`, S2 / S7 step 4) placed by `placeBid(source=BUYER_AGENT)`,
 *   so `mandates.authorize` checks the mandate at placement and `landHold` (D1) re-checks ACTIVE,
 *   the D12 cap and one live bid per shopper on the target (D3) when it lands.
 * - Dedupe: the new bid carries `replaces_bid_id = lostBid.id` (UNIQUE) and the idempotency key
 *   `roll:<lostBidId>`, so a second run (or a second instance) replays instead of holding again.
 * - `BID_ROLLED` is audited in the same transaction that makes the roll HELD.
 * - The vault declined, expired or missing → `mandates.needs_payment_method = true` (the mandate
 *   stays ACTIVE; agents ask the shopper from then on) and `MANDATE_NEEDS_PAYMENT_METHOD` is
 *   audited for the notifier (HF-054a: "Update your payment method").
 * - A create PayPal did not answer leaves the roll PENDING_APPROVAL + `needs_reconcile`; the next
 *   run replays it with the same request id (and the sweeper abandons it if it never lands).
 *
 * The roll bids the lost amount (the shopper's own price), on a listing whose floor it meets.
 */

export const AUTO_ROLL_INTERVAL_MS = 5 * 60_000;
/** Newest losses first, so a backlog of bids waiting for a window never starves a fresh one. */
const AUTO_ROLL_LIMIT = 200;

export interface AutoRollResult {
  /** New holds that landed HELD. */
  rolled: number;
  /** Vault declined / missing: the mandate was flagged `needs_payment_method`. */
  paymentMethodFailed: number;
  /** PayPal gave no answer: left for the next run / the sweeper. */
  pending: number;
  /**
   * Passes that changed nothing. Nested so the scheduler's `didWork` ignores them and an idle
   * run (lost bids waiting for a new window) is not audited every 5 min.
   */
  idle: {
    /** Refused without a hold (cap, window, already bid) or a duplicate of another run. */
    skipped: number;
    /** Lost bids with nowhere to roll yet (no OPEN listing for an allowed product). */
    waiting: number;
  };
}

export interface AutoRollOptions {
  limit?: number;
  onError?: (err: unknown, lostBidId: string) => void;
}

/** A lost bid that may roll, plus its in-flight roll (a create PayPal didn't answer), if any. */
export interface RollCandidate {
  id: string;
  shopper_id: string;
  listing_id: string;
  amount_cents: number;
  mandate_id: string;
  intent_id: string | null;
  release_if_cheaper: boolean;
  product_ids: string[];
  vaulted: boolean;
  roll_listing_id: string | null;
  roll_amount_cents: number | null;
}

export type RollOutcome =
  | { outcome: 'ROLLED'; bidId: string; listingId: string }
  | { outcome: 'PAYMENT_METHOD_FAILED'; code: string }
  | { outcome: 'PENDING'; bidId: string }
  | { outcome: 'SKIPPED'; reason: string }
  | { outcome: 'WAITING' };

/** The idempotency key of a lost bid's roll. */
export function rollKey(lostBidId: string): string {
  return `roll:${lostBidId}`;
}

export async function rollCandidates(
  q: Queryable,
  limit = AUTO_ROLL_LIMIT,
): Promise<RollCandidate[]> {
  const res = await q.query(
    `SELECT b.id, b.shopper_id, b.listing_id, b.amount_cents, b.mandate_id, b.intent_id,
            b.release_if_cheaper,
            CASE WHEN cardinality(m.allowed_product_ids) > 0 THEN m.allowed_product_ids
                 ELSE ARRAY[l.product_id] END AS product_ids,
            s.paypal_vault_id IS NOT NULL AS vaulted,
            r.listing_id AS roll_listing_id, r.amount_cents AS roll_amount_cents
       FROM bids b
       JOIN mandates m ON m.id = b.mandate_id
       JOIN shoppers s ON s.id = b.shopper_id
       JOIN listings l ON l.id = b.listing_id
       LEFT JOIN bids r ON r.replaces_bid_id = b.id
      WHERE b.status = 'VOIDED' AND b.void_reason IN ('LOST', 'WINDOW_EXPIRED')
        AND m.status = 'ACTIVE' AND m.auto_roll AND NOT m.needs_payment_method
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND m.shopper_id = b.shopper_id
        AND NOT s.is_simulated AND b.source IS DISTINCT FROM 'SIM'
        AND (r.id IS NULL
             OR (r.status = 'PENDING_APPROVAL' AND r.needs_reconcile
                 AND r.shopper_id = b.shopper_id AND r.idempotency_key = 'roll:' || b.id))
        AND (b.intent_id IS NULL
             OR EXISTS (SELECT 1 FROM intents i WHERE i.id = b.intent_id AND i.status = 'OPEN'))
      ORDER BY b.voided_at DESC NULLS LAST, b.id
      LIMIT $1`,
    [limit],
  );
  return res.rows as RollCandidate[];
}

/**
 * The listing a lost bid rolls into: OPEN and inside its window, for an allowed product (the lost
 * listing's product when the mandate allows any), not the lost listing, floor at or under the
 * amount, and no live bid of this shopper there (D3). Newest window first.
 */
export async function rollTarget(
  q: Queryable,
  c: Pick<RollCandidate, 'shopper_id' | 'listing_id' | 'amount_cents' | 'product_ids'>,
): Promise<{ id: string; brand_name: string } | null> {
  const res = await q.query(
    `SELECT l.id, br.name AS brand_name
       FROM listings l JOIN brands br ON br.id = l.brand_id
      WHERE l.status = 'OPEN' AND l.id <> $1
        AND l.product_id = ANY($2::uuid[])
        AND l.window_opens_at <= now() AND l.window_closes_at > now()
        AND l.floor_cents <= $3
        AND NOT EXISTS (SELECT 1 FROM bids x
                         WHERE x.listing_id = l.id AND x.shopper_id = $4
                           AND x.status IN ('PENDING_APPROVAL', 'HELD', 'WON', 'LOST'))
      ORDER BY l.window_opens_at DESC, l.id
      LIMIT 1`,
    [c.listing_id, c.product_ids, c.amount_cents, c.shopper_id],
  );
  return (res.rows[0] as { id: string; brand_name: string } | undefined) ?? null;
}

/** Roll one lost bid. Safe to call twice: the second call replays `roll:<id>`. */
export async function rollLostBid(deps: PlaceBidDeps, c: RollCandidate): Promise<RollOutcome> {
  const actor: Actor = { type: 'BUYER_AGENT', id: c.shopper_id };
  if (!c.vaulted) {
    await flagPaymentMethod(deps, c, actor, 'NO_VAULT');
    return { outcome: 'PAYMENT_METHOD_FAILED', code: 'NO_VAULT' };
  }

  let listingId = c.roll_listing_id;
  let amountCents = c.roll_amount_cents ?? c.amount_cents;
  if (!listingId) {
    const target = await rollTarget(deps.db.pool, c);
    if (!target) return { outcome: 'WAITING' };
    listingId = target.id;
    amountCents = c.amount_cents;
  }

  const input: PlaceBidInput = {
    shopperId: c.shopper_id,
    listingId,
    amountCents,
    paymentMethod: 'VAULT',
    vaultKind: 'card',
    initiator: 'MERCHANT',
    mandateId: c.mandate_id,
    intentId: c.intent_id,
    releaseIfCheaper: c.release_if_cheaper,
    source: 'BUYER_AGENT',
    idempotencyKey: rollKey(c.id),
    replacesBidId: c.id,
    actor,
  };
  let landedHere = false;
  const audited = rolledAudit(deps.audit, c, () => (landedHere = true));
  const result = await placeBid({ ...deps, audit: audited }, input);
  return outcomeOf(deps, c, actor, result, landedHere);
}

/**
 * `BID_ROLLED` rides on the roll's `BID_HELD`, inside `landHold`'s transaction: written exactly
 * when the roll becomes HELD, never for a refused one or a replay of a landed one.
 */
function rolledAudit(
  inner: AuditHook | undefined,
  c: RollCandidate,
  onRolled: () => void,
): AuditHook {
  return async (tx, entry) => {
    await inner?.(tx, entry);
    if (entry.action !== 'BID_HELD') return;
    const brand = await tx.query(
      `SELECT br.name FROM listings l JOIN brands br ON br.id = l.brand_id WHERE l.id = $1`,
      [entry.listingId],
    );
    await audit(tx, {
      actorType: 'BUYER_AGENT',
      actorId: c.shopper_id,
      listingId: entry.listingId,
      entity: 'bid',
      entityId: entry.entityId,
      action: 'BID_ROLLED',
      paypalId: entry.paypalId ?? null,
      data: {
        fromBidId: c.id,
        fromListingId: c.listing_id,
        mandateId: c.mandate_id,
        shopperId: c.shopper_id,
        amountCents: entry.data?.amountCents ?? null,
        brandName: (brand.rows[0] as { name: string } | undefined)?.name ?? null,
        initiator: 'MERCHANT',
      },
    });
    onRolled();
  };
}

async function outcomeOf(
  deps: PlaceBidDeps,
  c: RollCandidate,
  actor: Actor,
  result: PlaceBidResult,
  landedHere: boolean,
): Promise<RollOutcome> {
  if (result.ok) {
    // A replay that landed a create PayPal had not answered counts; a replay of a roll another
    // pass already landed does not.
    if (!landedHere || result.bid.status !== 'HELD') {
      return { outcome: 'SKIPPED', reason: `REPLAYED_${result.bid.status}` };
    }
    return { outcome: 'ROLLED', bidId: result.bid.id, listingId: result.bid.listing_id };
  }
  const { error } = result;
  switch (error.code) {
    case 'HOLD_FAILED':
      // Vault declined or expired (S2 / S7: a vault_id hold authorizes at create or is refused).
      await flagPaymentMethod(deps, c, actor, error.paypalCode);
      return { outcome: 'PAYMENT_METHOD_FAILED', code: error.paypalCode };
    case 'VALIDATION_ERROR':
      if (error.field === 'paymentMethod') {
        await flagPaymentMethod(deps, c, actor, 'NO_VAULT');
        return { outcome: 'PAYMENT_METHOD_FAILED', code: 'NO_VAULT' };
      }
      return { outcome: 'SKIPPED', reason: `VALIDATION_ERROR:${error.field}` };
    case 'PAYPAL_ERROR':
      return { outcome: 'PENDING', bidId: error.bidId };
    case 'IN_PROGRESS':
      return { outcome: 'SKIPPED', reason: 'IN_PROGRESS' };
    case 'STATE_CONFLICT':
      return { outcome: 'SKIPPED', reason: error.reason };
    default:
      return { outcome: 'SKIPPED', reason: error.code };
  }
}

/** 05 §Edge cases: the roll failed on the payment method; the mandate stays ACTIVE. */
async function flagPaymentMethod(
  deps: PlaceBidDeps,
  c: RollCandidate,
  actor: Actor,
  code: string,
): Promise<void> {
  await deps.db.tx(async (tx) => {
    const res = await tx.query(
      `UPDATE mandates SET needs_payment_method = true, updated_at = now()
        WHERE id = $1 AND NOT needs_payment_method RETURNING id`,
      [c.mandate_id],
    );
    if (!res.rowCount) return;
    await audit(tx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      entity: 'mandate',
      entityId: c.mandate_id,
      action: 'MANDATE_NEEDS_PAYMENT_METHOD',
      data: { shopperId: c.shopper_id, lostBidId: c.id, code },
    });
  });
}

/** One cron pass over every lost bid that may roll. */
export async function autoRollBids(
  deps: PlaceBidDeps,
  opts: AutoRollOptions = {},
): Promise<AutoRollResult> {
  const out: AutoRollResult = {
    rolled: 0,
    paymentMethodFailed: 0,
    pending: 0,
    idle: { skipped: 0, waiting: 0 },
  };
  for (const c of await rollCandidates(deps.db.pool, opts.limit ?? AUTO_ROLL_LIMIT)) {
    let r: RollOutcome;
    try {
      r = await rollLostBid(deps, c);
    } catch (err) {
      opts.onError?.(err, c.id);
      continue;
    }
    switch (r.outcome) {
      case 'ROLLED':
        out.rolled++;
        break;
      case 'PAYMENT_METHOD_FAILED':
        out.paymentMethodFailed++;
        break;
      case 'PENDING':
        out.pending++;
        break;
      case 'SKIPPED':
        out.idle.skipped++;
        break;
      case 'WAITING':
        out.idle.waiting++;
        break;
    }
  }
  return out;
}
