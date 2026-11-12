import { HOLD_MAX_AGE_HOURS, clear, type ClearBid } from '@holdfast/shared';
import { audit, loadClearInput, type Db, type Queryable } from '@holdfast/core';
import { STUB_AUTH_PREFIX } from '../dev/sim-bids.js';

/**
 * `npm run demo:decline` (HF-046, features/17 §Demo script hooks). Sets
 * `listings.demo_decline_rank`, the only way that column is written (script / admin, never request
 * input). At Clear, HF-027 copies it onto that rank's winner (`bids.test_decline` + the CAPTURE
 * settlement's `mock_response`), and HF-029 sends `PayPal-Mock-Response INSTRUMENT_DECLINED` only
 * with `DEMO_MODE` + `ALLOW_MOCK_DECLINE` on a sandbox base (`mockDeclinesAllowed`).
 *
 * The rank is picked so the beat produces exactly one promotion:
 * - eligible > Q at the planned quantity, so a reserve exists (HF-031: otherwise UNFILLED_UNIT);
 * - the winner at the rank is a SIM bidder with a real hold (never a foreground shopper), so the
 *   requested rank moves to the nearest rank that qualifies;
 * - the reserve bid `promoteWithin` will pick (rank order, skipping release-if-cheaper bids above
 *   the public price, paused / fulfilled mandates and holds ≥ 66 h) has a real hold too.
 *
 * Run it right before Clear (after rounds and with `sim:stream` paused): ranks are re-read at
 * Clear, so new bids above the chosen one shift who sits at that rank.
 */

export const DECLINE_ACTOR = { type: 'SYSTEM', id: 'demo:decline' } as const;

export interface DemoDeclineInput {
  listingId: string;
  /** Preferred winner rank (1-based). */
  rank: number;
  /** The quantity the brand will Clear (the video uses 240). */
  quantity: number;
}

export type DemoDeclineRefusal =
  | { code: 'NOT_FOUND' }
  | { code: 'NOT_CLEARABLE_YET'; status: string }
  | { code: 'INVALID_QUANTITY'; maxQuantity: number }
  | { code: 'NO_RESERVE'; eligible: number; quantity: number }
  | { code: 'RANK_OUT_OF_RANGE'; winners: number }
  | { code: 'NO_SIM_WINNER' }
  | { code: 'RESERVE_NOT_HELD'; reserveBidId: string | null };

export interface DemoDeclineSet {
  listingId: string;
  requestedRank: number;
  rank: number;
  quantity: number;
  /** Winners at `quantity` and the eligible count (winners + reserve). */
  winners: number;
  eligible: number;
  declined: { bidId: string; amountCents: number };
  /** The reserve bid `promoteWithin` should promote when the capture is declined. */
  promoted: { bidId: string; amountCents: number };
}

export type DemoDeclineResult =
  { ok: true; set: DemoDeclineSet } | { ok: false; error: DemoDeclineRefusal };

interface BidMeta {
  id: string;
  source: string | null;
  is_simulated: boolean;
  paypal_authorization_id: string | null;
  release_if_cheaper: boolean;
  amount_cents: number;
  mandate_status: string | null;
  aged: boolean;
}

/** A real PayPal (or FakePayPal) hold: an authorization id that is not a `dev:bids` stub id. */
export function hasRealHold(authorizationId: string | null): boolean {
  return !!authorizationId && !authorizationId.startsWith(STUB_AUTH_PREFIX);
}

/** Ranks to try, nearest first: r, r+1, r-1, r+2, r-2, … within [1, max]. */
export function ranksNearest(r: number, max: number): number[] {
  const out: number[] = [];
  for (let d = 0; out.length < max && d <= max; d++) {
    for (const x of d === 0 ? [r] : [r + d, r - d]) {
      if (x >= 1 && x <= max) out.push(x);
    }
  }
  return out;
}

export async function setDemoDeclineRank(
  db: Db,
  input: DemoDeclineInput,
): Promise<DemoDeclineResult> {
  return db.tx(async (tx) => {
    const listing = (
      await tx.query<{
        id: string;
        brand_id: string;
        status: string;
        quantity: number;
        floor_cents: number;
        best_public_price_cents: number | null;
      }>(
        `SELECT l.id, l.brand_id, l.status, l.quantity, l.floor_cents, p.best_public_price_cents
           FROM listings l JOIN products p ON p.id = l.product_id
          WHERE l.id = $1 FOR UPDATE OF l`,
        [input.listingId],
      )
    ).rows[0];
    if (!listing) return refuse({ code: 'NOT_FOUND' });
    // After Clear the settlement rows exist and capture tasks start within milliseconds.
    if (listing.status !== 'OPEN' && listing.status !== 'ROUNDS') {
      return refuse({ code: 'NOT_CLEARABLE_YET', status: listing.status });
    }
    if (
      !Number.isSafeInteger(input.quantity) ||
      input.quantity < 1 ||
      input.quantity > listing.quantity
    ) {
      return refuse({ code: 'INVALID_QUANTITY', maxQuantity: listing.quantity });
    }

    const book = (await loadClearInput(tx, listing.id))!;
    const result = clear(book.bids, input.quantity, book.floorCents);
    const eligible = result.winners.length + result.reserve.length;
    if (result.reserve.length === 0) {
      return refuse({ code: 'NO_RESERVE', eligible, quantity: input.quantity });
    }
    if (!Number.isSafeInteger(input.rank) || input.rank < 1 || input.rank > result.winners.length) {
      return refuse({ code: 'RANK_OUT_OF_RANGE', winners: result.winners.length });
    }

    const meta = await bidMeta(
      tx,
      [...result.winners, ...result.reserve].map((b) => b.id),
    );
    const promoted = nextReserve(result.reserve, meta, listing.best_public_price_cents);
    if (!promoted || !hasRealHold(meta.get(promoted.id)?.paypal_authorization_id ?? null)) {
      return refuse({ code: 'RESERVE_NOT_HELD', reserveBidId: promoted?.id ?? null });
    }

    const rank = ranksNearest(input.rank, result.winners.length).find((r) => {
      const m = meta.get(result.winners[r - 1]!.id);
      return !!m && isSimBid(m) && hasRealHold(m.paypal_authorization_id);
    });
    if (rank === undefined) return refuse({ code: 'NO_SIM_WINNER' });
    const declined = result.winners[rank - 1]!;

    await tx.query(`UPDATE listings SET demo_decline_rank = $2 WHERE id = $1`, [listing.id, rank]);
    await audit(tx, {
      actorType: DECLINE_ACTOR.type,
      actorId: DECLINE_ACTOR.id,
      brandId: listing.brand_id,
      listingId: listing.id,
      entity: 'listing',
      entityId: listing.id,
      action: 'DEMO_DECLINE_RANK_SET',
      data: {
        requestedRank: input.rank,
        rank,
        quantity: input.quantity,
        eligible,
        declinedBidId: declined.id,
        promotedBidId: promoted.id,
      },
    });
    return {
      ok: true as const,
      set: {
        listingId: listing.id,
        requestedRank: input.rank,
        rank,
        quantity: input.quantity,
        winners: result.winners.length,
        eligible,
        declined: { bidId: declined.id, amountCents: declined.amountCents },
        promoted: { bidId: promoted.id, amountCents: promoted.amountCents },
      },
    };
  });
}

/** `demo:decline --off`: clear the flag (OPEN / ROUNDS only, like setting it). */
export async function clearDemoDeclineRank(db: Db, listingId: string): Promise<boolean> {
  return db.tx(async (tx) => {
    const res = await tx.query<{ brand_id: string }>(
      `UPDATE listings SET demo_decline_rank = NULL
        WHERE id = $1 AND status IN ('OPEN', 'ROUNDS') RETURNING brand_id`,
      [listingId],
    );
    const row = res.rows[0];
    if (!row) return false;
    await audit(tx, {
      actorType: DECLINE_ACTOR.type,
      actorId: DECLINE_ACTOR.id,
      brandId: row.brand_id,
      listingId,
      entity: 'listing',
      entityId: listingId,
      action: 'DEMO_DECLINE_RANK_CLEARED',
    });
    return true;
  });
}

function refuse(error: DemoDeclineRefusal): DemoDeclineResult {
  return { ok: false, error };
}

function isSimBid(m: BidMeta): boolean {
  return m.is_simulated || m.source === 'SIM';
}

/** HF-031's candidate order and skip rules (`promote.ts` step 3), applied to the reserve. */
function nextReserve(
  reserve: readonly ClearBid[],
  meta: Map<string, BidMeta>,
  publicCents: number | null,
): ClearBid | null {
  for (const b of reserve) {
    const m = meta.get(b.id);
    if (!m) continue;
    if (m.release_if_cheaper && publicCents !== null && m.amount_cents > publicCents) continue;
    if (
      m.mandate_status === 'PAUSED' ||
      m.mandate_status === 'FULFILLED' ||
      m.mandate_status === 'REVOKED'
    )
      continue;
    if (m.aged) continue;
    return b;
  }
  return null;
}

async function bidMeta(q: Queryable, ids: string[]): Promise<Map<string, BidMeta>> {
  const { rows } = await q.query<BidMeta>(
    `SELECT b.id, b.source, s.is_simulated, b.paypal_authorization_id, b.release_if_cheaper,
            b.amount_cents, m.status AS mandate_status,
            (b.authorized_at < now() - make_interval(hours => $2)) IS TRUE AS aged
       FROM bids b JOIN shoppers s ON s.id = b.shopper_id
       LEFT JOIN mandates m ON m.id = b.mandate_id
      WHERE b.id = ANY($1::uuid[])`,
    [ids, HOLD_MAX_AGE_HOURS],
  );
  return new Map(rows.map((r) => [r.id, r]));
}
