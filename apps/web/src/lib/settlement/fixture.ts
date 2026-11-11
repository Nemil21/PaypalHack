import {
  feeCents,
  type ListingEvent,
  type ListingStatus,
  type PayoutView,
  type SettlementRow,
  type SettlementView,
} from '@holdfast/shared';
import { countsFromRows } from './model';

/**
 * A recorded W08 event stream (HF-035): the screen was built against this before HF-030a's live
 * stream existed, and `/dev/settlement` still replays it. The frames are full `settlement.updated`
 * / `listing.status` / `payout.updated` payloads from `packages/shared` (the SSE wire only carries
 * id notices; the live screen re-reads `GET /settlement` instead). Story: 8 winners each charged
 * their own bid, one charged (pending), Shopper #207 declines at capture, Shopper #241 is promoted
 * at their own $219, reserve and below-floor holds are released, the listing settles and the
 * payout goes PENDING → SUCCESS.
 */

export interface FixtureFrame {
  /** Delay before this frame, in ms at 1× speed. */
  delayMs: number;
  event: ListingEvent;
}

export interface SettlementFixture {
  initial: SettlementView;
  frames: FixtureFrame[];
}

export const FIXTURE_LISTING_ID = 'fixture-aurel-a7';

const T0 = Date.UTC(2026, 10, 11, 18, 0, 0);

interface Seat {
  seq: number;
  cents: number;
  kind: 'W' | 'R' | 'B';
  sim?: boolean;
}

// Winners from $249 down to $221 (each pays their own bid), reserve at or above the $200 floor,
// two below it.
const SEATS: Seat[] = [
  { seq: 201, cents: 24_900, kind: 'W' },
  { seq: 204, cents: 23_900, kind: 'W', sim: true },
  { seq: 207, cents: 22_900, kind: 'W' }, // declines at capture
  { seq: 212, cents: 22_900, kind: 'W' },
  { seq: 215, cents: 22_500, kind: 'W', sim: true },
  { seq: 219, cents: 22_500, kind: 'W' }, // PayPal answers PENDING: "charged (pending)"
  { seq: 223, cents: 22_100, kind: 'W' },
  { seq: 230, cents: 22_100, kind: 'W', sim: true },
  { seq: 241, cents: 21_900, kind: 'R' }, // promoted at their own $219
  { seq: 244, cents: 21_500, kind: 'R', sim: true },
  { seq: 248, cents: 20_900, kind: 'R' },
  { seq: 252, cents: 18_900, kind: 'B' },
  { seq: 255, cents: 17_500, kind: 'B', sim: true },
];
const DECLINE = 207;
const PENDING = 219;
const PROMOTED = 241;

const bidId = (seq: number) => `bid-${seq}`;

function row(seat: Seat, action: 'CAPTURE' | 'VOID', n: number): SettlementRow {
  return {
    settlementId: `stl-${n.toString().padStart(3, '0')}`,
    bidId: bidId(seat.seq),
    shopperLabel: `Shopper #${seat.seq}`,
    isSimulated: !!seat.sim,
    action,
    status: 'QUEUED',
    amountCents: seat.cents,
    isReserve: seat.kind === 'R',
    paypalId: null,
    paypalStatus: null,
    errorClass: null,
    errorCode: null,
    attempts: 0,
    unitRootBidId: seat.kind === 'W' ? bidId(seat.seq) : null,
    promotedFromBidId: null,
    startedAt: null,
    finishedAt: null,
  };
}

const fakeId = (prefix: string, n: number) =>
  `${prefix}${(0x5a17c0de + n * 7919).toString(36).toUpperCase().padStart(13, '0')}`;

export function settlementFixture(listingId = FIXTURE_LISTING_ID): SettlementFixture {
  let n = 0;
  const rows: SettlementRow[] = SEATS.map((s) => row(s, s.kind === 'W' ? 'CAPTURE' : 'VOID', ++n));
  const winners = SEATS.filter((s) => s.kind === 'W');
  const clearedCents = winners.reduce((sum, s) => sum + s.cents, 0);

  const initial: SettlementView = {
    listingId,
    listingStatus: 'CLEARING',
    quantity: winners.length,
    unfilledUnits: 0,
    clearedCents,
    capturedCents: 0,
    cutoffCents: winners.at(-1)!.cents,
    feeBps: 900,
    counts: countsFromRows(rows),
    rows: rows.map((r) => ({ ...r })),
    payout: null,
    updatedAt: new Date(T0).toISOString(),
  };

  const frames: FixtureFrame[] = [];
  let clock = T0;
  const at = (dt: number) => new Date((clock += dt)).toISOString();
  const find = (seq: number, action: 'CAPTURE' | 'VOID') =>
    rows.find((r) => r.bidId === bidId(seq) && r.action === action)!;
  const push = (delayMs: number, r: SettlementRow, patch: Partial<SettlementRow>) => {
    const when = at(delayMs);
    Object.assign(r, patch);
    if (patch.status === 'RUNNING') r.startedAt = when;
    if (patch.status === 'SUCCEEDED' || patch.status === 'FAILED' || patch.status === 'CANCELLED')
      r.finishedAt = when;
    frames.push({
      delayMs,
      event: {
        type: 'settlement.updated',
        listingId,
        at: when,
        row: { ...r },
        counts: countsFromRows(rows),
      },
    });
  };
  const status = (delayMs: number, from: ListingStatus, to: ListingStatus) =>
    frames.push({
      delayMs,
      event: { type: 'listing.status', listingId, at: at(delayMs), from, to },
    });
  const payout = (delayMs: number, p: PayoutView) =>
    frames.push({
      delayMs,
      event: { type: 'payout.updated', listingId, at: at(delayMs), payout: p },
    });

  // Phase 1: captures for every winner plus below-floor voids (D9).
  let k = 0;
  for (const s of [...winners, ...SEATS.filter((x) => x.kind === 'B')]) {
    const action = s.kind === 'W' ? 'CAPTURE' : 'VOID';
    const r = find(s.seq, action);
    push(180, r, { status: 'RUNNING', attempts: 1 });
    k++;
    if (s.seq === DECLINE) {
      push(420, r, {
        status: 'FAILED',
        errorClass: 'TERMINAL',
        errorCode: 'INSTRUMENT_DECLINED',
        paypalStatus: null,
      });
      // promoteWithin: claim #241's reserve VOID and insert a CAPTURE at their own bid.
      push(160, find(PROMOTED, 'VOID'), { status: 'CANCELLED' });
      const seat = SEATS.find((x) => x.seq === PROMOTED)!;
      const promo: SettlementRow = {
        ...row(seat, 'CAPTURE', ++n),
        isReserve: false,
        unitRootBidId: bidId(DECLINE),
        promotedFromBidId: bidId(DECLINE),
      };
      rows.push(promo);
      push(60, promo, { status: 'QUEUED' });
      continue;
    }
    push(320 + (k % 3) * 90, r, {
      status: 'SUCCEEDED',
      paypalId: action === 'CAPTURE' ? fakeId('CAP', k) : fakeId('AUTH', k),
      paypalStatus: action === 'VOID' ? 'VOIDED' : s.seq === PENDING ? 'PENDING' : 'COMPLETED',
    });
  }

  // Phase 2: the promotion's capture, at the promoted bidder's own bid.
  const promo = find(PROMOTED, 'CAPTURE');
  push(500, promo, { status: 'RUNNING', attempts: 1 });
  push(700, promo, { status: 'SUCCEEDED', paypalId: fakeId('CAP', 99), paypalStatus: 'COMPLETED' });

  // Phase 3: reserve voids, only after every capture finished.
  for (const s of SEATS.filter((x) => x.kind === 'R' && x.seq !== PROMOTED)) {
    const r = find(s.seq, 'VOID');
    push(240, r, { status: 'RUNNING', attempts: 1 });
    push(380, r, { status: 'SUCCEEDED', paypalId: fakeId('AUTH', s.seq), paypalStatus: 'VOIDED' });
  }

  // Phase 4: SETTLED, then the payout.
  const gross = rows
    .filter((r) => r.action === 'CAPTURE' && r.status === 'SUCCEEDED')
    .reduce((sum, r) => sum + r.amountCents, 0);
  const fee = feeCents(gross, 900);
  status(600, 'CLEARING', 'SETTLED');
  const p: PayoutView = {
    payoutId: 'payout-fixture',
    attempt: 1,
    status: 'PENDING',
    grossCents: gross,
    feeCents: fee,
    netCents: gross - fee,
    paypalBatchId: 'FIXTUREBATCH7Q',
    itemStatus: 'PENDING',
    failureReason: null,
  };
  payout(500, p);
  payout(2_500, { ...p, status: 'SUCCESS', itemStatus: 'SUCCESS' });
  status(100, 'SETTLED', 'PAID_OUT');

  return { initial, frames };
}

/**
 * Fold one event into a view: what the server would answer to the next `GET /settlement`. Used
 * for the fixture replay; the live screen simply re-reads.
 */
export function applySettlementEvent(view: SettlementView, e: ListingEvent): SettlementView {
  if (e.listingId !== view.listingId) return view;
  switch (e.type) {
    case 'settlement.updated': {
      const i = view.rows.findIndex((r) => r.settlementId === e.row.settlementId);
      const rows =
        i === -1 ? [...view.rows, e.row] : view.rows.map((r, j) => (j === i ? e.row : r));
      return {
        ...view,
        rows,
        counts: e.counts,
        capturedCents: rows
          .filter((r) => r.action === 'CAPTURE' && r.status === 'SUCCEEDED')
          .reduce((sum, r) => sum + r.amountCents, 0),
        updatedAt: e.at,
      };
    }
    case 'listing.status':
      return { ...view, listingStatus: e.to, updatedAt: e.at };
    case 'payout.updated':
      return {
        ...view,
        payout: e.payout,
        listingStatus:
          e.payout.status === 'FAILED' && view.listingStatus === 'SETTLED'
            ? 'PAYOUT_FAILED'
            : view.listingStatus,
        updatedAt: e.at,
      };
    default:
      return view;
  }
}

/** Replay the fixture into a view up to (and including) frame `index`. */
export function fixtureViewAt(fx: SettlementFixture, index: number): SettlementView {
  let v = fx.initial;
  for (let i = 0; i <= index && i < fx.frames.length; i++)
    v = applySettlementEvent(v, fx.frames[i]!.event);
  return v;
}
