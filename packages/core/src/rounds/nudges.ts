import { nudgeText, type ListingEvent, type Nudge, type NudgeDraft } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Queryable } from '../db.js';
import { emit } from '../money/emit.js';

/**
 * The `nudges` table (M10, features/19 §Logic 2–3). `sendNudge` is the **only** write the brand
 * agent has (features/09, Q#26): it inserts one nudge row with numbers computed by code, plus its
 * `NUDGE_SENT` audit and `round.nudged` SSE. It cannot move money, change the listing or clear.
 */

/** Publishes a listing event inside the transaction (HF-003a `emit`); a test seam. */
export type EmitFn = (tx: Queryable, listingId: string, event: ListingEvent) => Promise<void>;

export interface NudgeRow {
  id: string;
  listing_id: string;
  round: number;
  shopper_id: string;
  bid_id: string;
  cutoff_cents: number;
  target_cents: number;
  your_bid_cents: number;
  units_left: number;
  round_ends_at: Date | null;
  text: string;
  sent_at: Date;
}

/** Row → the shared `Nudge` shape (HF-016 `my_bids`, HF-020 timeline, HF-038 consumers). */
export function nudgeFromRow(row: NudgeRow): Nudge {
  return {
    id: row.id,
    listingId: row.listing_id,
    bidId: row.bid_id,
    shopperId: row.shopper_id,
    round: row.round,
    cutoffCents: row.cutoff_cents,
    yourBidCents: row.your_bid_cents,
    targetQuantity: row.units_left,
    roundEndsAt: row.round_ends_at ? row.round_ends_at.toISOString() : null,
    suggestedCents: row.target_cents,
    text: row.text,
    sentAt: row.sent_at.toISOString(),
  };
}

export interface SendNudgeInput {
  listingId: string;
  round: number;
  draft: NudgeDraft;
  /** Defaults to the template (HF-036a). HF-036b passes Claude's phrasing, filled by code. */
  text?: string;
  /** The brand user whose action ran the round (audit `data.triggeredBy`). */
  triggeredBy?: string | null;
  emit?: EmitFn;
}

/**
 * `send_nudge(bidId)`: insert the round's nudge for one bid, once per (listing, round, shopper)
 * (`ON CONFLICT DO NOTHING`). Returns null when that shopper was already nudged this round.
 * Call it inside the round's transaction.
 */
export async function sendNudge(tx: Queryable, input: SendNudgeInput): Promise<Nudge | null> {
  const { draft } = input;
  const text = input.text ?? nudgeText(draft);
  const res = await tx.query(
    `INSERT INTO nudges (listing_id, round, shopper_id, bid_id, cutoff_cents, target_cents,
                         your_bid_cents, units_left, round_ends_at, text, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT ON CONSTRAINT nudges_listing_round_shopper_key DO NOTHING
     RETURNING *`,
    [
      input.listingId,
      input.round,
      draft.shopperId,
      draft.bidId,
      draft.cutoffCents,
      draft.suggestedCents,
      draft.yourBidCents,
      draft.targetQuantity,
      draft.roundEndsAt,
      text,
    ],
  );
  const row = res.rows[0] as NudgeRow | undefined;
  if (!row) return null;
  const nudge = nudgeFromRow(row);

  await audit(tx, {
    actorType: 'BRAND_AGENT',
    listingId: input.listingId,
    entity: 'bid',
    entityId: draft.bidId,
    action: 'NUDGE_SENT',
    data: {
      nudgeId: nudge.id,
      round: nudge.round,
      shopperId: nudge.shopperId,
      cutoffCents: nudge.cutoffCents,
      yourBidCents: nudge.yourBidCents,
      targetQuantity: nudge.targetQuantity,
      suggestedCents: nudge.suggestedCents,
      roundEndsAt: nudge.roundEndsAt,
      text: nudge.text,
      triggeredBy: input.triggeredBy ?? null,
    },
  });

  const seq = (await tx.query(`SELECT seq::text AS seq FROM bids WHERE id = $1`, [draft.bidId]))
    .rows[0] as { seq: string };
  await (input.emit ?? emit)(tx, input.listingId, {
    type: 'round.nudged',
    listingId: input.listingId,
    at: nudge.sentAt,
    round: nudge.round,
    bidId: nudge.bidId,
    // Same opaque label as landHold's bid.held (HF-022 owns the per-listing sequence).
    shopperLabel: `Shopper #${seq.seq}`,
    isSimulated: draft.isSimulated,
    cutoffCents: nudge.cutoffCents,
    targetCents: nudge.suggestedCents,
    text: nudge.text,
  });
  return nudge;
}

/**
 * Nudges for one shopper (newest round first), optionally on one listing. HF-016 reads the
 * latest one for `belowCutoff` / `cutoffCents` in `GET /bids/mine` during ROUNDS.
 */
export async function listShopperNudges(
  q: Queryable,
  shopperId: string,
  opts: { listingId?: string } = {},
): Promise<Nudge[]> {
  const res = await q.query(
    `SELECT * FROM nudges
      WHERE shopper_id = $1 AND ($2::uuid IS NULL OR listing_id = $2)
      ORDER BY round DESC, created_at DESC`,
    [shopperId, opts.listingId ?? null],
  );
  return (res.rows as NudgeRow[]).map(nudgeFromRow);
}
