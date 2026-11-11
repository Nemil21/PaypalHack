import type { ListingStatus, PayoutStatus } from './status.js';

/**
 * The order-status timeline (HF-060 part 2; HOLDFAST-SPEC §5, HOLDFAST.md §4): window → price
 * watch → live rounds → lock (Clear) → capture fan-out → payout → shipping, with a "Now" marker.
 * One model for every placement: the console (W06), payouts (W09) and the shopper's bid detail
 * (W15). The server sends facts only (listing timestamps plus counts and times from settlements,
 * payouts, shipments and audit events, `OrderTimelineFacts`); `orderTimeline()` turns them into
 * phases against a ticking clock, so the Now marker moves without a refetch.
 *
 * No money amounts travel here: the shopper's copy never shows the brand's payout figures, and the
 * brand's never shows a shopper's identity.
 */

export const ORDER_PHASE_KEYS = [
  'window',
  'priceWatch',
  'rounds',
  'lock',
  'capture',
  'payout',
  'shipping',
] as const;
export type OrderPhaseKey = (typeof ORDER_PHASE_KEYS)[number];

/** done / active / upcoming, or skipped (did not apply) / failed (did not complete). */
export type OrderPhaseState = 'done' | 'active' | 'upcoming' | 'skipped' | 'failed';

export interface OrderTimelineFacts {
  /** Brand (W06, W09) or the shopper who owns the bid (W15). */
  audience: 'brand' | 'shopper';
  listingStatus: ListingStatus;
  windowOpensAt: string | null;
  windowClosesAt: string | null;
  roundsStartedAt: string | null;
  roundsEndAt: string | null;
  /** min(clear deadline, oldest hold + 66 h): when the listing must be cleared by (D6). */
  clearByAt: string | null;
  clearedAt: string | null;
  cancelledAt: string | null;
  priceWatch: {
    /** Brand: the product has a Channel3 price subscription. Shopper: "Release if cheaper" is on. */
    on: boolean;
    /** Price events the watcher handled for this listing (audit). */
    events: number;
    /** Holds released because a store was cheaper (brand: count; shopper: 0 or 1). */
    released: number;
    lastEventAt: string | null;
  };
  /** Settlement rows (brand: every row; shopper: their own). Null before Clear. */
  settlement: {
    total: number;
    finished: number;
    failed: number;
    /** SUCCEEDED captures. */
    charged: number;
    firstStartedAt: string | null;
    lastFinishedAt: string | null;
  } | null;
  payout: { status: PayoutStatus; createdAt: string; completedAt: string | null } | null;
  /** Brand: every winner's shipment; shopper: their own. Null when nothing ships. */
  shipping: {
    /** Units expected to ship (brand: charged winners; shopper: 1). */
    expected: number;
    shipped: number;
    firstShippedAt: string | null;
    lastShippedAt: string | null;
  } | null;
  /**
   * Shopper only, once known: won (charged or being charged), declined (won, but PayPal declined
   * the capture: never charged), lost (below the cutoff) or released (price drop).
   */
  outcome?: 'won' | 'declined' | 'lost' | 'released' | null;
  /** Database clock when the facts were read. */
  asOf: string;
}

export interface OrderPhase {
  key: OrderPhaseKey;
  label: string;
  state: OrderPhaseState;
  /** ISO; null = not known yet. A milestone has `startAt === endAt`. */
  startAt: string | null;
  endAt: string | null;
  milestone: boolean;
  /** `endAt` (or the milestone time) is a deadline still ahead, not a recorded fact. */
  planned: boolean;
  /** One plain line, e.g. "8 of 9 settled" or "Closes Nov 13, 5:00 PM". */
  detail: string;
}

const TERMINAL_EARLY: ReadonlySet<ListingStatus> = new Set(['CANCELLED', 'EXPIRED']);
const CLEARED: ReadonlySet<ListingStatus> = new Set([
  'CLEARING',
  'SETTLED',
  'PAID_OUT',
  'PAYOUT_FAILED',
]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
const past = (iso: string | null, now: number) => iso !== null && ms(iso) <= now;

/** "Nov 13, 5:00 PM" in the viewer's zone. */
export function timelineDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function orderTimeline(f: OrderTimelineFacts, nowDate: Date): OrderPhase[] {
  const now = nowDate.getTime();
  const shopper = f.audience === 'shopper';
  const stopped = TERMINAL_EARLY.has(f.listingStatus);
  const cleared = CLEARED.has(f.listingStatus) || f.clearedAt !== null;
  const stoppedAt = f.cancelledAt ?? (stopped ? (f.windowClosesAt ?? f.asOf) : null);
  const lostOut =
    shopper && (f.outcome === 'lost' || f.outcome === 'released' || f.outcome === 'declined');
  const phases: OrderPhase[] = [];

  const skipped = (key: OrderPhaseKey, label: string, detail: string): OrderPhase => ({
    key,
    label,
    state: 'skipped',
    startAt: null,
    endAt: null,
    milestone: false,
    planned: false,
    detail,
  });

  // 1. Bidding window: published → window_closes_at (a deadline until it passes).
  {
    const closed = past(f.windowClosesAt, now) || f.listingStatus !== 'OPEN';
    const end = stopped && f.cancelledAt ? f.cancelledAt : f.windowClosesAt;
    phases.push({
      key: 'window',
      label: 'Bidding window',
      state:
        f.listingStatus === 'DRAFT' ? 'upcoming' : stopped ? 'failed' : closed ? 'done' : 'active',
      startAt: f.windowOpensAt,
      endAt: end,
      milestone: false,
      planned: !closed && !stopped,
      detail:
        f.listingStatus === 'CANCELLED'
          ? 'Cancelled. Every hold is released.'
          : f.listingStatus === 'EXPIRED'
            ? 'Expired without a Clear. Every hold is released.'
            : !f.windowOpensAt
              ? 'Not published yet'
              : closed
                ? `Closed ${timelineDate(f.windowClosesAt ?? f.asOf)}`
                : `Holds placed on PayPal. Closes ${timelineDate(f.windowClosesAt!)}`,
    });
  }

  // 2. Price watch: runs alongside the window until the lock.
  {
    const lockAt = f.clearedAt ?? stoppedAt;
    const label = 'Price watch';
    if (!f.priceWatch.on && f.priceWatch.released === 0) {
      phases.push(
        skipped(
          'priceWatch',
          label,
          shopper ? '"Release if cheaper" is off for this bid' : 'No public price to watch',
        ),
      );
    } else {
      const ended = lockAt !== null || stopped || cleared;
      const released = f.priceWatch.released;
      phases.push({
        key: 'priceWatch',
        label,
        state: f.windowOpensAt === null ? 'upcoming' : ended ? 'done' : 'active',
        startAt: f.windowOpensAt,
        endAt: lockAt ?? f.roundsEndAt ?? f.windowClosesAt,
        milestone: false,
        planned: !ended,
        detail: shopper
          ? released > 0
            ? 'A store sold it for less, so your hold was released'
            : 'Your hold is released if a store sells it for less'
          : `${plural(f.priceWatch.events, 'price check')} · ${plural(released, 'hold')} released`,
      });
    }
  }

  // 3. Live rounds (feature 19): optional.
  if (f.roundsStartedAt) {
    const over = past(f.roundsEndAt, now) || f.listingStatus !== 'ROUNDS';
    phases.push({
      key: 'rounds',
      label: 'Live rounds',
      state: over ? 'done' : 'active',
      startAt: f.roundsStartedAt,
      endAt: f.roundsEndAt,
      milestone: false,
      planned: !over,
      detail: over
        ? `Ended ${timelineDate(f.roundsEndAt ?? f.asOf)}`
        : `Bidders can raise until ${timelineDate(f.roundsEndAt!)}`,
    });
  } else {
    phases.push(
      skipped(
        'rounds',
        'Live rounds',
        cleared || stopped ? 'No live rounds' : 'Optional, before the Clear',
      ),
    );
  }

  // 4. Lock: the brand clears; winners are fixed (milestone).
  if (stopped) {
    phases.push(skipped('lock', 'Clear', 'Never cleared'));
  } else {
    const at = f.clearedAt ?? f.clearByAt;
    phases.push({
      key: 'lock',
      label: 'Clear',
      state: cleared
        ? 'done'
        : f.listingStatus === 'ROUNDS' || past(f.windowClosesAt, now)
          ? 'active'
          : 'upcoming',
      startAt: at,
      endAt: at,
      milestone: true,
      planned: !cleared,
      detail: cleared
        ? shopper
          ? f.outcome === 'won' || f.outcome === 'declined'
            ? 'You won at your own bid'
            : f.outcome
              ? 'Your bid was below the cutoff'
              : `Cleared ${timelineDate(f.clearedAt!)}`
          : `Winners locked ${timelineDate(f.clearedAt!)}. Each pays their own bid.`
        : f.clearByAt
          ? `Clear by ${timelineDate(f.clearByAt)}`
          : 'Waiting for the brand to clear',
    });
  }

  // 5. Capture fan-out: settlement rows from the first PayPal call to the last answer.
  {
    const s = f.settlement;
    const label = shopper ? 'Charge or release' : 'Capture fan-out';
    if (stopped) {
      phases.push(skipped('capture', label, 'Nothing charged'));
    } else if (!s || s.total === 0) {
      phases.push({
        key: 'capture',
        label,
        state: cleared ? 'active' : 'upcoming',
        startAt: null,
        endAt: null,
        milestone: false,
        planned: true,
        detail: shopper
          ? "Winners pay their own bid. Everyone else's hold is released."
          : 'One capture per winner, one release per other hold',
      });
    } else {
      const done = s.finished >= s.total && f.listingStatus !== 'CLEARING';
      const ownFailed = shopper && s.failed > 0;
      phases.push({
        key: 'capture',
        label,
        state: ownFailed ? 'failed' : done ? 'done' : 'active',
        startAt: s.firstStartedAt ?? f.clearedAt,
        endAt: done ? s.lastFinishedAt : null,
        milestone: false,
        planned: !done,
        detail: shopper
          ? ownFailed
            ? 'Your payment did not go through. You were not charged.'
            : f.outcome === 'won'
              ? done
                ? 'Charged your own bid'
                : 'Charging your own bid'
              : done
                ? 'Hold released, never charged'
                : 'Releasing your hold'
          : `${s.finished} of ${plural(s.total, 'PayPal call')} settled${
              s.failed > 0 ? ` · ${plural(s.failed, 'decline')}` : ''
            }`,
      });
    }
  }

  // 6. Payout to the brand (milestone).
  {
    const p = f.payout;
    const label = 'Payout';
    if (stopped || lostOut) {
      phases.push(
        skipped('payout', label, lostOut ? 'Not part of your order' : 'Nothing to pay out'),
      );
    } else if (!p) {
      const nothing =
        !shopper && f.listingStatus !== 'CLEARING' && cleared && (f.settlement?.charged ?? 0) === 0;
      phases.push({
        key: 'payout',
        label,
        state: nothing ? 'skipped' : 'upcoming',
        startAt: null,
        endAt: null,
        milestone: true,
        planned: true,
        detail: nothing ? 'Nothing was charged, so nothing is paid out' : 'After every capture',
      });
    } else {
      const at = p.completedAt ?? p.createdAt;
      const state: OrderPhaseState =
        p.status === 'SUCCESS' ? 'done' : p.status === 'FAILED' ? 'failed' : 'active';
      phases.push({
        key: 'payout',
        label,
        state,
        startAt: at,
        endAt: at,
        milestone: true,
        planned: false,
        detail: shopper
          ? state === 'done'
            ? 'The brand was paid'
            : 'Paying the brand'
          : state === 'done'
            ? `Paid ${timelineDate(at)}`
            : state === 'failed'
              ? 'Payout failed. An admin can retry.'
              : 'Sent to PayPal',
      });
    }
  }

  // 7. Shipping: first to last tracking number.
  {
    const sh = f.shipping;
    const label = 'Shipping';
    if (stopped || lostOut) {
      phases.push(skipped('shipping', label, lostOut ? 'Nothing ships to you' : 'Nothing ships'));
    } else if (!sh || sh.shipped === 0) {
      phases.push({
        key: 'shipping',
        label,
        state: 'upcoming',
        startAt: null,
        endAt: null,
        milestone: false,
        planned: true,
        detail: shopper ? 'Tracking appears here once the brand ships' : 'Add tracking on Payouts',
      });
    } else {
      const all = sh.shipped >= sh.expected;
      phases.push({
        key: 'shipping',
        label,
        state: all ? 'done' : 'active',
        startAt: sh.firstShippedAt,
        endAt: all ? sh.lastShippedAt : null,
        milestone: false,
        planned: !all,
        detail: shopper ? 'Shipped' : `${sh.shipped} of ${plural(sh.expected, 'unit')} shipped`,
      });
    }
  }

  return phases;
}

/** Where "Now" falls in the list: after the last phase that has started. */
export function nowIndex(phases: OrderPhase[], nowDate: Date): number {
  const now = nowDate.getTime();
  let at = 0;
  phases.forEach((p, i) => {
    if (p.state === 'skipped') return;
    if (p.state === 'done' || p.state === 'failed' || (p.startAt && ms(p.startAt) <= now)) {
      at = i + 1;
    }
  });
  return at;
}
