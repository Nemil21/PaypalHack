import {
  BID_SOURCES,
  ROUND_END_REASONS,
  ROUNDS_ACTIVITY_MAX_RAISES,
  clear,
  type BidSource,
  type ListingStatus,
  type RoundEndReason,
  type RoundsActivity,
  type RoundsActivityExtension,
  type RoundsActivityRaise,
  type RoundsActivityRound,
} from '@holdfast/shared';
import { loadClearInput } from '../clearInput.js';
import type { Db, Tx } from '../db.js';
import { forBrand } from '../tenancy.js';
import { UNSCALED_TIMING, type RoundsTiming } from './timing.js';

/**
 * The console's raises feed (HF-037b; features/19 §Screens, screens.md W06), read in one
 * REPEATABLE READ snapshot without locks. Everything comes from rows the rounds runner already
 * writes: round starts (`ROUNDS_STARTED` / `ROUND_ADVANCED`), each round's `ROUND_SNAPSHOT`
 * (expected gross at its start), `nudges`, raises (a new bid whose replaced bid was voided
 * `REPLACED` in the `landHold` swap, as in tick.ts), `ROUND_EXTENDED` and the end
 * (`ROUNDS_ENDED` with its reason, or `ROUNDS_STOPPED`).
 *
 * Another brand's listing throws `NotFoundError` (404).
 */

/** Must match the book's labels (listings/book.ts) so feed rows and grid rows agree. */
const SHOPPER_LABEL_BASE = 1000;

interface ListingHead {
  status: ListingStatus;
  current_round: number | null;
  target_quantity: number | null;
  rounds_started_at: Date | null;
}

interface AuditRow {
  action: string;
  at: Date;
  entity_id: string | null;
  data: Record<string, unknown>;
}

interface RaiseRow {
  bid_id: string;
  replaces_bid_id: string;
  old_cents: number;
  new_cents: number;
  source: string | null;
  is_simulated: boolean;
  label: string;
  at: Date;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function sourceOf(s: string | null): BidSource {
  return (BID_SOURCES as readonly string[]).includes(s ?? '') ? (s as BidSource) : 'OFFER_PAGE';
}

export async function loadRoundsActivity(
  db: Db,
  brandId: string,
  listingId: string,
  opts: { timing?: RoundsTiming } = {},
): Promise<RoundsActivity> {
  const timing = opts.timing ?? UNSCALED_TIMING;
  return db.tx(async (tx: Tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await forBrand(tx, brandId).getListing(listingId);
    const head = (
      await tx.query<ListingHead>(
        `SELECT status, current_round, target_quantity, rounds_started_at
           FROM listings WHERE id = $1`,
        [listingId],
      )
    ).rows[0]!;

    const empty: RoundsActivity = {
      listingId,
      status: head.status,
      currentRound: head.current_round,
      targetQuantity: head.target_quantity,
      expectedGrossCents: null,
      rounds: [],
      raises: [],
      extensions: [],
      ended: null,
    };
    if (!head.rounds_started_at) return empty;
    const since = head.rounds_started_at;

    const audits = (
      await tx.query<AuditRow>(
        `SELECT action, at, entity_id::text AS entity_id, data FROM audit_events
          WHERE listing_id = $1 AND at >= $2
            AND action IN ('ROUNDS_STARTED', 'ROUND_ADVANCED', 'ROUND_SNAPSHOT',
                           'ROUND_EXTENDED', 'ROUNDS_ENDED', 'ROUNDS_STOPPED')
          ORDER BY id`,
        [listingId, since],
      )
    ).rows;

    // Round starts and their scheduled ends (before any extension).
    const starts = new Map<number, { at: Date; endsAt: number | null }>();
    const grossAtStart = new Map<number, number>();
    const extensionAudits: AuditRow[] = [];
    let ended: RoundsActivity['ended'] = null;
    /** Expected gross when rounds ended (the book is frozen from there); null for older rows. */
    let endGrossCents: number | null = null;
    for (const a of audits) {
      const startedAt = str(a.data.roundStartedAt);
      if (a.action === 'ROUNDS_STARTED' && !starts.has(1)) {
        const endsAt = str(a.data.roundEndsAt);
        starts.set(1, {
          at: startedAt ? new Date(startedAt) : a.at,
          endsAt: endsAt ? Date.parse(endsAt) : null,
        });
      } else if (a.action === 'ROUND_ADVANCED') {
        const round = num(a.data.round);
        const endsAt = str(a.data.roundEndsAt);
        if (round !== null && !starts.has(round)) {
          starts.set(round, {
            at: startedAt ? new Date(startedAt) : a.at,
            endsAt: endsAt ? Date.parse(endsAt) : null,
          });
        }
      } else if (a.action === 'ROUND_SNAPSHOT') {
        const round = num(a.data.round);
        const gross = num(a.data.grossCents);
        if (round !== null && gross !== null && !grossAtStart.has(round)) {
          grossAtStart.set(round, gross);
        }
      } else if (a.action === 'ROUND_EXTENDED') {
        extensionAudits.push(a);
      } else if (!ended) {
        const reason =
          a.action === 'ROUNDS_STOPPED' ? 'BRAND_STOPPED' : (str(a.data.reason) as RoundEndReason);
        if ((ROUND_END_REASONS as readonly string[]).includes(reason)) {
          ended = {
            round: num(a.data.round) ?? head.current_round ?? 1,
            reason,
            at: a.at.toISOString(),
          };
          endGrossCents = num(a.data.grossCents);
        }
      }
    }
    const roundNumbers = [...starts.keys()].sort((a, b) => a - b);
    const roundAt = (t: number): number => {
      let r = roundNumbers[0] ?? 1;
      for (const n of roundNumbers) if (starts.get(n)!.at.getTime() <= t) r = n;
      return r;
    };

    const nudged = new Map<number, number>(
      (
        await tx.query<{ round: number; n: number }>(
          `SELECT round, count(*)::int AS n FROM nudges WHERE listing_id = $1 GROUP BY round`,
          [listingId],
        )
      ).rows.map((r) => [r.round, r.n]),
    );

    const raiseRows = (
      await tx.query<RaiseRow>(
        `WITH labels AS (
           SELECT shopper_id, row_number() OVER (ORDER BY min(seq)) AS n
             FROM bids WHERE listing_id = $1 GROUP BY shopper_id
         )
         SELECT n.id AS bid_id, o.id AS replaces_bid_id, o.amount_cents AS old_cents,
                n.amount_cents AS new_cents, n.source,
                (s.is_simulated OR n.source = 'SIM') IS TRUE AS is_simulated,
                ($3::int + lb.n)::text AS label,
                greatest(n.placed_at, coalesce(n.authorized_at, n.placed_at)) AS at
           FROM bids n
           JOIN bids o ON o.id = n.replaces_bid_id
           JOIN shoppers s ON s.id = n.shopper_id
           JOIN labels lb ON lb.shopper_id = n.shopper_id
          WHERE n.listing_id = $1 AND o.listing_id = $1 AND o.void_reason = 'REPLACED'
            AND greatest(n.placed_at, coalesce(n.authorized_at, n.placed_at)) >= $2
          ORDER BY at DESC, n.seq DESC`,
        [listingId, since, SHOPPER_LABEL_BASE],
      )
    ).rows;
    const raised = new Map<number, number>();
    const raises: RoundsActivityRaise[] = raiseRows.map((r) => {
      const round = roundAt(r.at.getTime());
      raised.set(round, (raised.get(round) ?? 0) + 1);
      return {
        bidId: r.bid_id,
        replacesBidId: r.replaces_bid_id,
        oldCents: r.old_cents,
        newCents: r.new_cents,
        shopperLabel: `Shopper #${r.label}`,
        source: sourceOf(r.source),
        isSimulated: r.is_simulated,
        at: r.at.toISOString(),
        round,
      };
    });

    // Each extension moved the round's end from the previous one (or its scheduled end).
    const lastEnd = new Map<number, number>();
    const extensions: RoundsActivityExtension[] = [];
    for (const a of extensionAudits) {
      const round = num(a.data.round) ?? roundAt(a.at.getTime());
      const endsAtIso = str(a.data.roundEndsAt);
      if (!endsAtIso || !a.entity_id) continue;
      const endsAt = Date.parse(endsAtIso);
      const previous = str(a.data.previousRoundEndsAt);
      const before = previous
        ? Date.parse(previous)
        : (lastEnd.get(round) ?? starts.get(round)?.endsAt ?? null);
      extensions.push({
        round,
        at: a.at.toISOString(),
        bidId: a.entity_id,
        roundEndsAt: endsAtIso,
        extendedByMs: Math.max(0, before === null ? timing.extensionMs : endsAt - before),
      });
      lastEnd.set(round, endsAt);
    }
    extensions.reverse();

    let expectedGrossCents: number | null = null;
    // Once rounds ended the book is frozen: the end audit's gross is final, also after Clear,
    // expiry or cancel move the listing out of ROUNDS.
    if (ended && endGrossCents !== null) {
      expectedGrossCents = endGrossCents;
    } else if (head.status === 'ROUNDS' && head.target_quantity !== null) {
      const input = await loadClearInput(tx, listingId);
      if (input) {
        expectedGrossCents = clear(input.bids, head.target_quantity, input.floorCents).grossCents;
      }
    }

    const rounds: RoundsActivityRound[] = roundNumbers.map((round, i) => {
      const start = grossAtStart.get(round) ?? null;
      const nextRound = roundNumbers[i + 1];
      const endGross =
        nextRound !== undefined ? (grossAtStart.get(nextRound) ?? null) : expectedGrossCents;
      return {
        round,
        startedAt: starts.get(round)!.at.toISOString(),
        nudged: nudged.get(round) ?? 0,
        raised: raised.get(round) ?? 0,
        grossAtStartCents: start,
        grossDeltaCents: start !== null && endGross !== null ? endGross - start : null,
      };
    });

    return {
      ...empty,
      expectedGrossCents,
      rounds,
      raises: raises.slice(0, ROUNDS_ACTIVITY_MAX_RAISES),
      extensions,
      ended,
    };
  });
}
