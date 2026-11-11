import {
  feeCents,
  formatUsd,
  type PayoutView,
  type SettlementCounts,
  type SettlementRow,
  type SettlementView,
} from '@holdfast/shared';

/**
 * W08 settlement live view (HF-035): everything the screen shows, derived from one
 * `SettlementView` (`GET /api/listings/:id/settlement`). Pure, so the copy rules are testable:
 *   - "Charged" only for a SUCCEEDED capture; "Charged (pending)" when PayPal said PENDING;
 *   - "Released" only for a SUCCEEDED void (D14);
 *   - pay-your-bid wording only: every amount is that bidder's own bid, never a common price.
 */

export type SettlementPhase = 'running' | 'promoting' | 'done';

export type BarKey = 'captured' | 'released' | 'failed' | 'promoted';

export interface ProgressBar {
  key: BarKey;
  label: string;
  value: number;
  /** Bar length; 0 means "nothing expected yet". */
  total: number;
  caption: string;
  tone: 'success' | 'neutral' | 'danger' | 'held';
}

/** What a log row says happened to this bidder's money. */
export type LogKind =
  | 'charged'
  | 'charged-pending'
  | 'capturing'
  | 'capture-failed'
  | 'released'
  | 'releasing'
  | 'reserve'
  | 'release-failed'
  | 'promoted-out';

export interface LogRow {
  settlementId: string;
  bidId: string;
  shopperLabel: string;
  isSimulated: boolean;
  kind: LogKind;
  /** "Charged", "Charged (pending)", "Released", "Capture declined", … */
  action: string;
  amountCents: number;
  paypalId: string | null;
  /** ISO; finished, else started, else null (still queued). */
  at: string | null;
  /** Promotion highlight (D10), e.g. "Decline → promoted Shopper #241 at their own bid $219". */
  note: string | null;
  /** The other side of a promotion: the failed winner (on the promoted row) or the promoted bid. */
  linkedBidId: string | null;
  highlight: boolean;
  isReserve: boolean;
  promoted: boolean;
  status: SettlementRow['status'];
  errorCode: string | null;
}

export type LogFilter = 'all' | 'charges' | 'releases' | 'problems' | 'promotions';

export const LOG_FILTERS: { key: LogFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'charges', label: 'Charges' },
  { key: 'releases', label: 'Releases' },
  { key: 'promotions', label: 'Promotions' },
  { key: 'problems', label: 'Failed' },
];

export const RESERVE_HINT = 'Reserve holds release after captures finish.';

const isPromotedCapture = (r: SettlementRow) =>
  r.action === 'CAPTURE' && r.unitRootBidId !== null && r.unitRootBidId !== r.bidId;

/** The counts the server sends, re-derived from rows (fixture replay, and the AC check). */
export function countsFromRows(rows: SettlementRow[]): SettlementCounts {
  const n = (f: (r: SettlementRow) => boolean) => rows.filter(f).length;
  const ok = (r: SettlementRow) => r.status === 'SUCCEEDED';
  return {
    total: rows.length,
    queued: n((r) => r.status === 'QUEUED'),
    running: n((r) => r.status === 'RUNNING' || r.status === 'RETRY'),
    captured: n((r) => r.action === 'CAPTURE' && ok(r) && r.paypalStatus !== 'PENDING'),
    capturePending: n((r) => r.action === 'CAPTURE' && ok(r) && r.paypalStatus === 'PENDING'),
    released: n((r) => r.action === 'VOID' && ok(r)),
    failed: n((r) => r.status === 'FAILED'),
    promoted: n(isPromotedCapture),
    cancelled: n((r) => r.status === 'CANCELLED'),
  };
}

export function settlementPhase(view: SettlementView): SettlementPhase {
  if (view.listingStatus !== 'CLEARING') return 'done';
  // A failed winner whose unit is still being refilled: its replacement capture is open.
  const promoting = view.rows.some(
    (r) =>
      isPromotedCapture(r) &&
      (r.status === 'QUEUED' || r.status === 'RUNNING' || r.status === 'RETRY'),
  );
  return promoting ? 'promoting' : 'running';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function progressBars(view: SettlementView): ProgressBar[] {
  const c = view.counts;
  const captures = view.rows.filter((r) => r.action === 'CAPTURE');
  const voids = view.rows.filter((r) => r.action === 'VOID' && r.status !== 'CANCELLED');
  const charged = c.captured + c.capturePending;
  const promotedCharged = captures.filter(
    (r) => isPromotedCapture(r) && r.status === 'SUCCEEDED',
  ).length;
  return [
    {
      key: 'captured',
      label: 'Captured',
      value: charged,
      total: view.quantity,
      caption:
        c.capturePending > 0
          ? `${c.captured} charged · ${c.capturePending} charged (pending) of ${plural(view.quantity, 'unit')}`
          : `${c.captured} of ${plural(view.quantity, 'unit')} charged`,
      tone: 'success',
    },
    {
      key: 'released',
      label: 'Released',
      value: c.released,
      total: voids.length,
      caption: `${c.released} of ${plural(voids.length, 'hold')} released`,
      tone: 'neutral',
    },
    {
      key: 'failed',
      label: 'Failed',
      value: c.failed,
      total: captures.length,
      caption:
        c.failed === 0 ? 'No declines' : `${plural(c.failed, 'capture')} failed, nothing charged`,
      tone: 'danger',
    },
    {
      key: 'promoted',
      label: 'Promoted',
      value: c.promoted,
      total: Math.max(c.promoted, c.failed),
      caption:
        c.promoted === 0
          ? 'No units reassigned'
          : `${promotedCharged} of ${plural(c.promoted, 'promoted bid')} charged at their own bid`,
      tone: 'held',
    },
  ];
}

/** Share of settlement rows that reached a final state (the ring). */
export function doneFraction(view: SettlementView): number {
  const { total, queued, running } = view.counts;
  return total === 0 ? 0 : (total - queued - running) / total;
}

function actionFor(r: SettlementRow): { kind: LogKind; action: string } {
  if (r.action === 'CAPTURE') {
    switch (r.status) {
      case 'SUCCEEDED':
        return r.paypalStatus === 'PENDING'
          ? { kind: 'charged-pending', action: 'Charged (pending)' }
          : { kind: 'charged', action: 'Charged' };
      case 'FAILED':
        return {
          kind: 'capture-failed',
          action: r.errorClass === 'TERMINAL' ? 'Capture declined' : 'Capture failed',
        };
      case 'CANCELLED':
        return { kind: 'capture-failed', action: 'Capture cancelled' };
      case 'RETRY':
        return { kind: 'capturing', action: 'Capture retrying' };
      case 'RUNNING':
        return { kind: 'capturing', action: 'Capturing' };
      default:
        return { kind: 'capturing', action: 'Capture queued' };
    }
  }
  switch (r.status) {
    case 'SUCCEEDED':
      return { kind: 'released', action: 'Released' };
    case 'FAILED':
      return { kind: 'release-failed', action: 'Release failed' };
    case 'CANCELLED':
      // promoteWithin claimed this reserve VOID: the hold is being charged instead.
      return { kind: 'promoted-out', action: 'Kept for promotion' };
    case 'RUNNING':
    case 'RETRY':
      return { kind: 'releasing', action: 'Releasing' };
    default:
      return r.isReserve
        ? { kind: 'reserve', action: 'On the reserve list' }
        : { kind: 'releasing', action: 'Release queued' };
  }
}

/** Every settlement row as a log line, newest activity first; promotions linked both ways. */
export function logRows(view: SettlementView): LogRow[] {
  const byBid = new Map<string, SettlementRow>();
  for (const r of view.rows) if (r.action === 'CAPTURE') byBid.set(r.bidId, r);

  // failed winner bid id → its replacement capture (D10: same unit root).
  const replacement = new Map<string, SettlementRow>();
  for (const r of view.rows) {
    if (!isPromotedCapture(r)) continue;
    const from = r.promotedFromBidId ?? failedInUnit(view.rows, r)?.bidId ?? null;
    if (from) replacement.set(from, r);
  }

  const out = view.rows.map((r): LogRow => {
    const { kind, action } = actionFor(r);
    let note: string | null = null;
    let linkedBidId: string | null = null;
    if (isPromotedCapture(r)) {
      const failed = r.promotedFromBidId
        ? (byBid.get(r.promotedFromBidId) ?? null)
        : failedInUnit(view.rows, r);
      linkedBidId = failed?.bidId ?? r.promotedFromBidId;
      note = `Decline → promoted ${r.shopperLabel} at their own bid ${formatUsd(r.amountCents)}`;
      if (failed) note += ` (replaces ${failed.shopperLabel})`;
    } else if (r.action === 'CAPTURE' && r.status === 'FAILED') {
      const next = replacement.get(r.bidId);
      if (next) {
        linkedBidId = next.bidId;
        note = `Decline → promoted ${next.shopperLabel} at their own bid ${formatUsd(next.amountCents)}`;
      } else if (view.listingStatus !== 'CLEARING') {
        note = 'Declined. No reserve bid could take this unit.';
      }
    }
    return {
      settlementId: r.settlementId,
      bidId: r.bidId,
      shopperLabel: r.shopperLabel,
      isSimulated: r.isSimulated,
      kind,
      action,
      amountCents: r.amountCents,
      paypalId: r.paypalId,
      at: r.finishedAt ?? r.startedAt,
      note,
      linkedBidId,
      highlight: note !== null,
      isReserve: r.isReserve,
      promoted: isPromotedCapture(r),
      status: r.status,
      errorCode: r.errorCode,
    };
  });
  // Newest activity first; queued rows (no time) last, in server order.
  return out
    .map((r, i) => [r, i] as const)
    .sort(([a, ai], [b, bi]) => {
      if (a.at && b.at) return b.at.localeCompare(a.at) || ai - bi;
      if (a.at) return -1;
      if (b.at) return 1;
      return ai - bi;
    })
    .map(([r]) => r);
}

function failedInUnit(rows: SettlementRow[], promoted: SettlementRow): SettlementRow | null {
  return (
    rows.find(
      (r) =>
        r.action === 'CAPTURE' &&
        r.status === 'FAILED' &&
        r.bidId !== promoted.bidId &&
        r.unitRootBidId === promoted.unitRootBidId,
    ) ?? null
  );
}

export function matchesFilter(row: LogRow, filter: LogFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'charges':
      return row.kind === 'charged' || row.kind === 'charged-pending' || row.kind === 'capturing';
    case 'releases':
      return (
        row.kind === 'released' ||
        row.kind === 'releasing' ||
        row.kind === 'reserve' ||
        row.kind === 'promoted-out'
      );
    case 'promotions':
      return row.highlight || row.promoted || row.kind === 'promoted-out';
    case 'problems':
      return row.kind === 'capture-failed' || row.kind === 'release-failed';
  }
}

// ---------------------------------------------------------------------------------------------
// Payout card
// ---------------------------------------------------------------------------------------------

export type PayoutState = 'waiting' | 'nothing' | 'pending' | 'succeeded' | 'failed';

export interface PayoutCard {
  /** "Cleared $X · Captured $Y". */
  headline: string;
  clearedCents: number;
  capturedCents: number;
  /** From the payout attempt once it exists; an estimate from the captures until then. */
  feeCents: number;
  netCents: number;
  feeLabel: string;
  estimate: boolean;
  state: PayoutState;
  statusLabel: string;
  detail: string | null;
  /** Admin retry (HF-032 `retry-payout`) applies. */
  retryable: boolean;
  attempt: number | null;
  paypalBatchId: string | null;
}

export function payoutCard(view: SettlementView): PayoutCard {
  const p: PayoutView | null = view.payout;
  const headline = `Cleared ${formatUsd(view.clearedCents)} · Captured ${formatUsd(view.capturedCents)}`;
  const pct = (view.feeBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const estFee = feeCents(view.capturedCents, view.feeBps);
  const base = {
    headline,
    clearedCents: view.clearedCents,
    capturedCents: view.capturedCents,
    feeLabel: `Holdfast fee (${pct}%)`,
    attempt: p?.attempt ?? null,
    paypalBatchId: p?.paypalBatchId ?? null,
  };
  if (!p) {
    const nothing = view.listingStatus !== 'CLEARING' && view.capturedCents === 0;
    return {
      ...base,
      feeCents: estFee,
      netCents: view.capturedCents - estFee,
      estimate: true,
      state: nothing ? 'nothing' : 'waiting',
      statusLabel: nothing ? 'Nothing to pay' : 'Waiting for captures',
      detail: nothing
        ? 'No winner was charged, so there is no payout.'
        : 'The payout is sent once every winner is charged.',
      retryable: false,
    };
  }
  const paid = { ...base, feeCents: p.feeCents, netCents: p.netCents, estimate: false };
  switch (p.status) {
    case 'SUCCESS':
      return {
        ...paid,
        state: 'succeeded',
        statusLabel: 'Paid',
        detail: 'PayPal paid out the net amount.',
        retryable: false,
      };
    case 'FAILED':
      return {
        ...paid,
        state: 'failed',
        statusLabel: 'Failed',
        detail: p.failureReason ?? p.itemStatus ?? 'PayPal did not complete the payout.',
        retryable: view.listingStatus === 'PAYOUT_FAILED',
      };
    default:
      return {
        ...paid,
        state: 'pending',
        statusLabel: 'Pending',
        detail:
          p.status === 'PENDING_UNKNOWN'
            ? 'Checking with PayPal whether the payout went through.'
            : 'Sent to PayPal. Waiting for the payout to complete.',
        retryable: false,
      };
  }
}

/** Partial state: units with no successful capture and nobody left to promote. */
export function partialNote(view: SettlementView): string | null {
  if (view.unfilledUnits <= 0) return null;
  const sold = view.quantity - view.unfilledUnits;
  return `${plural(view.unfilledUnits, 'unit')} went unfilled: ${sold} of ${view.quantity} sold. The payout covers only what was charged.`;
}
