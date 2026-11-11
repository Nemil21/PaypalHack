import type { ListingStatus } from './status.js';

/** Holds at least this old are released at Clear (`HOLD_AGED`); PayPal guarantees 3 days. */
export const HOLD_MAX_AGE_HOURS = 66;
const HOUR_MS = 3_600_000;

export type Instant = Date | string | number;

/** The listing fields the timing rules need. Dates may be `Date`, ISO strings or epoch ms. */
export interface ListingTiming {
  status: ListingStatus;
  windowClosesAt: Instant;
  roundsStartedAt?: Instant | null;
  roundsEndAt?: Instant | null;
  clearDeadlineAt?: Instant | null;
  currentRound?: number | null;
  roundEndsAt?: Instant | null;
  /** Oldest `authorized_at` among live holds; feeds "Clear by" (features/08). */
  oldestHoldAuthorizedAt?: Instant | null;
}

export function toMs(t: Instant): number {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
  if (Number.isNaN(ms)) throw new RangeError(`invalid instant: ${String(t)}`);
  return ms;
}

function msOrNull(t: Instant | null | undefined): number | null {
  return t === null || t === undefined ? null : toMs(t);
}

/**
 * D7: a listing accepts **new** bids only while `status='OPEN' AND now < window_closes_at`.
 * Starting rounds sets `window_closes_at = least(window_closes_at, now)`, so ROUNDS never
 * accepts new bids. The server re-checks this under the listing lock in `landHold` (HF-003a).
 */
export function isBiddable(listing: ListingTiming, now: Instant = Date.now()): boolean {
  return listing.status === 'OPEN' && toMs(now) < toMs(listing.windowClosesAt);
}

/**
 * D7: a held bid may be **raised** while the listing is biddable, or while
 * `status='ROUNDS' AND now < rounds_end_at`. After `rounds_end_at` the book is frozen until Clear.
 */
export function isRaisable(listing: ListingTiming, now: Instant = Date.now()): boolean {
  if (isBiddable(listing, now)) return true;
  const roundsEnd = msOrNull(listing.roundsEndAt);
  return listing.status === 'ROUNDS' && roundsEnd !== null && toMs(now) < roundsEnd;
}

export const LISTING_PHASES = [
  'DRAFT',
  'BIDDING',
  'AWAITING_ROUNDS_OR_CLEAR',
  'ROUNDS_ACTIVE',
  'ROUNDS_ENDED',
  'CLEARING',
  'SETTLED',
  'PAID_OUT',
  'PAYOUT_FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type ListingPhaseName = (typeof LISTING_PHASES)[number];

export interface ListingPhase {
  phase: ListingPhaseName;
  /** What the deadline means, for the console header. */
  deadlineKind: 'WINDOW_CLOSES' | 'ROUNDS_END' | 'CLEAR_BY' | null;
  /** Epoch ms, or null when the phase has no deadline. */
  deadline: number | null;
  /** Current round number during ROUNDS_ACTIVE. */
  round: number | null;
}

/**
 * "Clear by" = min(`clear_deadline_at`, oldest hold `authorized_at` + 66 h) (features/08).
 * Null when neither is known.
 */
export function clearBy(listing: ListingTiming): number | null {
  const candidates = [
    msOrNull(listing.clearDeadlineAt),
    (() => {
      const oldest = msOrNull(listing.oldestHoldAuthorizedAt);
      return oldest === null ? null : oldest + HOLD_MAX_AGE_HOURS * HOUR_MS;
    })(),
  ].filter((v): v is number => v !== null);
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * Console header phase (HF-023): BIDDING → AWAITING_ROUNDS_OR_CLEAR → ROUNDS_ACTIVE →
 * ROUNDS_ENDED → CLEARING → SETTLED / PAID_OUT / PAYOUT_FAILED / EXPIRED / CANCELLED.
 * Note a listing can still be `status='OPEN'` after its window closed (awaiting Clear or rounds).
 */
export function listingPhase(listing: ListingTiming, now: Instant = Date.now()): ListingPhase {
  const none = { deadlineKind: null, deadline: null, round: null } as const;
  switch (listing.status) {
    case 'DRAFT':
      return { phase: 'DRAFT', ...none };
    case 'OPEN':
      if (isBiddable(listing, now)) {
        return {
          phase: 'BIDDING',
          deadlineKind: 'WINDOW_CLOSES',
          deadline: toMs(listing.windowClosesAt),
          round: null,
        };
      }
      return {
        phase: 'AWAITING_ROUNDS_OR_CLEAR',
        deadlineKind: 'CLEAR_BY',
        deadline: clearBy(listing),
        round: null,
      };
    case 'ROUNDS':
      if (isRaisable(listing, now)) {
        return {
          phase: 'ROUNDS_ACTIVE',
          deadlineKind: 'ROUNDS_END',
          deadline: msOrNull(listing.roundsEndAt),
          round: listing.currentRound ?? null,
        };
      }
      return {
        phase: 'ROUNDS_ENDED',
        deadlineKind: 'CLEAR_BY',
        deadline: clearBy(listing),
        round: listing.currentRound ?? null,
      };
    case 'CLEARING':
    case 'SETTLED':
    case 'PAID_OUT':
    case 'PAYOUT_FAILED':
    case 'EXPIRED':
    case 'CANCELLED':
      return { phase: listing.status, ...none };
    default: {
      const exhaustive: never = listing.status;
      throw new Error(`unknown listing status ${String(exhaustive)}`);
    }
  }
}
