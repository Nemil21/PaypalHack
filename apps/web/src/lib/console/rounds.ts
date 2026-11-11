import {
  clearBy,
  type BookListing,
  type ListingEvent,
  type ListingPhaseName,
  type RoundsState,
} from '@holdfast/shared';
import { formatDeadline } from './phase';

/**
 * Live rounds console, basic part (HF-037a; features/19 §Screens, screens.md W06). Pure helpers
 * behind `RoundsPanel`: the start/stop previews quoted in the confirm copy, the round header's
 * countdowns and the rounds state the console shows.
 *
 * Rounds state normally comes from the book (`GET /listings/:id/book` carries every rounds field),
 * re-read on each SSE notice. Two sources can be ahead of the last book for a moment and are
 * merged on top of it as an *overlay*: the `RoundsState` a start / next / stop / PATCH returns, and
 * full `round.*` events from the HF-036a fixture replay (`npm run dev:rounds-replay -- --serve`),
 * which carry the numbers instead of a bare notice. The overlay only ever moves rounds forward, so
 * a later book always wins once it catches up.
 */

const HOUR = 3_600_000;

/** The listing fields the rounds console reads (a `BookListing` subset). */
export type RoundsListing = Pick<
  BookListing,
  | 'status'
  | 'quantity'
  | 'windowOpensAt'
  | 'windowClosesAt'
  | 'roundsStartedAt'
  | 'roundsEndAt'
  | 'roundEndsAt'
  | 'currentRound'
  | 'targetQuantity'
  | 'clearDeadlineAt'
  | 'oldestHoldAuthorizedAt'
>;

/** Rounds fields known to be newer than the book, for one round. */
export interface RoundsOverlay {
  round: number;
  roundsStartedAt?: string | null;
  targetQuantity?: number | null;
  roundEndsAt?: string | null;
  roundsEndAt?: string | null;
  clearDeadlineAt?: string | null;
}

const ms = (iso: string | null | undefined): number | null =>
  iso === null || iso === undefined ? null : Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
const minIso = (a: string | null | undefined, b: string | null | undefined) => {
  const x = ms(a);
  const y = ms(b);
  if (x === null) return b ?? null;
  if (y === null) return a ?? null;
  return x <= y ? a! : b!;
};
const maxIso = (a: string | null | undefined, b: string | null | undefined) => {
  const x = ms(a);
  const y = ms(b);
  if (x === null) return b ?? null;
  if (y === null) return a ?? null;
  return x >= y ? a! : b!;
};

/** Fold a full rounds event (fixture replay) into the overlay. Other events leave it unchanged. */
export function applyRoundEvent(
  overlay: RoundsOverlay | null,
  event: ListingEvent,
): RoundsOverlay | null {
  const same = overlay && overlay.round === eventRound(event) ? overlay : null;
  switch (event.type) {
    case 'round.started':
      return {
        round: event.round,
        roundsStartedAt: same?.roundsStartedAt ?? (event.round === 1 ? event.at : undefined),
        targetQuantity: event.targetQuantity,
        roundEndsAt: event.roundEndsAt,
        roundsEndAt: event.roundsEndAt,
        clearDeadlineAt: same?.clearDeadlineAt,
      };
    case 'round.extended':
      return {
        ...same,
        round: event.round,
        roundEndsAt: event.roundEndsAt,
        roundsEndAt: event.roundsEndAt,
      };
    case 'round.ended':
      return {
        ...same,
        round: event.round,
        roundsEndAt: event.roundsEndAt,
        clearDeadlineAt: event.clearDeadlineAt ?? same?.clearDeadlineAt,
      };
    default:
      return overlay;
  }
}

function eventRound(event: ListingEvent): number | null {
  return 'round' in event && typeof event.round === 'number' ? event.round : null;
}

/** The overlay for a rounds endpoint's response (start / next / stop / PATCH). */
export function overlayFromState(state: RoundsState): RoundsOverlay | null {
  if (state.status !== 'ROUNDS' || state.round === null) return null;
  return {
    round: state.round,
    roundsStartedAt: state.roundsStartedAt,
    targetQuantity: state.targetQuantity,
    roundEndsAt: state.roundEndsAt,
    roundsEndAt: state.roundsEndAt,
    clearDeadlineAt: state.clearDeadlineAt,
  };
}

/**
 * The rounds state to show: the book, moved forward by the overlay where the overlay is ahead.
 * - A listing past rounds (CLEARING onward, cancelled, expired) is never overridden.
 * - Book on a later round than the overlay: the book wins outright.
 * - Overlay on a later round (or the book still OPEN): the overlay's fields win.
 * - Same round: the earliest `roundsEndAt` / `clearDeadlineAt` (stop only moves them earlier) and
 *   the latest `roundEndsAt` (soft close only extends); the book keeps its target quantity.
 */
export function withRoundsOverlay<L extends RoundsListing>(
  listing: L,
  overlay: RoundsOverlay | null,
): L {
  if (!overlay || (listing.status !== 'OPEN' && listing.status !== 'ROUNDS')) return listing;
  const bookRound = listing.status === 'ROUNDS' ? (listing.currentRound ?? 0) : 0;
  if (bookRound > overlay.round) return listing;

  if (bookRound < overlay.round) {
    const startedAt = overlay.roundsStartedAt ?? listing.roundsStartedAt;
    return {
      ...listing,
      status: 'ROUNDS',
      currentRound: overlay.round,
      roundsStartedAt: startedAt,
      // Starting rounds closes new bidding (D7).
      windowClosesAt: startedAt
        ? minIso(listing.windowClosesAt, startedAt)
        : listing.windowClosesAt,
      targetQuantity: overlay.targetQuantity ?? listing.targetQuantity,
      roundEndsAt: overlay.roundEndsAt !== undefined ? overlay.roundEndsAt : listing.roundEndsAt,
      roundsEndAt: overlay.roundsEndAt ?? listing.roundsEndAt,
      clearDeadlineAt: minIso(listing.clearDeadlineAt, overlay.clearDeadlineAt),
    };
  }
  return {
    ...listing,
    roundEndsAt: maxIso(listing.roundEndsAt, overlay.roundEndsAt),
    roundsEndAt: minIso(listing.roundsEndAt, overlay.roundsEndAt),
    clearDeadlineAt: minIso(listing.clearDeadlineAt, overlay.clearDeadlineAt),
  };
}

// --- Start / stop previews (the confirm copy) --------------------------------------------------

export interface StartPreview {
  /** False once the 6 h after the window closed are over (the API answers `ROUNDS_WINDOW_PASSED`). */
  possible: boolean;
  /** Latest the rounds can run to: `least(now + 6h, window_closes_at + 6h)` (a demo time scale only ends them sooner). */
  roundsEndAt: number;
  /** `least(least(now + 6h, window_closes_at + 6h) + 6h, window_opens_at + 60h)`, as the start sets it. */
  clearDeadlineAt: number;
}

/** What starting rounds now would set (mirrors `startRounds` in packages/core). */
export function startPreview(listing: RoundsListing, now: number): StartPreview {
  const closes = ms(listing.windowClosesAt) ?? now;
  const roundsEndAt = Math.min(now + 6 * HOUR, closes + 6 * HOUR);
  const opens = ms(listing.windowOpensAt);
  const clearDeadlineAt = Math.min(
    roundsEndAt + 6 * HOUR,
    opens === null ? Infinity : opens + 60 * HOUR,
  );
  return { possible: now < closes + 6 * HOUR, roundsEndAt, clearDeadlineAt };
}

/**
 * "Clear by" after stopping now: `least(clear_deadline_at, now + 6h)`, then the hold-age guard
 * (shared `clearBy`), as the console header shows it.
 */
export function stopClearBy(listing: RoundsListing, now: number): number {
  const deadline = minIso(listing.clearDeadlineAt, iso(now + 6 * HOUR))!;
  return clearBy({
    ...listing,
    windowClosesAt: listing.windowClosesAt ?? iso(now),
    clearDeadlineAt: deadline,
  })!;
}

/** The start confirm copy (HF-037a scope, verbatim). */
export function startConfirmCopy(p: StartPreview, timeZone?: string): string {
  return (
    'Starting rounds closes bidding to new bids. ' +
    `Rounds end by ${formatDeadline(p.roundsEndAt, timeZone)}. ` +
    `Clear by ${formatDeadline(p.clearDeadlineAt, timeZone)}.`
  );
}

/** The banner once rounds have ended (after `round.ended`, or `rounds_end_at` passing). */
export function roundsEndedCopy(listing: RoundsListing, timeZone?: string): string {
  const by = clearBy({ ...listing, windowClosesAt: listing.windowClosesAt ?? 0 });
  return by === null
    ? 'Rounds ended. Press Clear to settle the winners.'
    : `Rounds ended. Press Clear by ${formatDeadline(by, timeZone)}.`;
}

// --- Round header ------------------------------------------------------------------------------

/** "04:59" for a round countdown (minutes keep counting past 59: "75:00"); "00:00" once passed. */
export function formatMmSs(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(total / 60);
  return `${String(m).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface RoundHeader {
  round: number;
  /** "ends in 04:59", or null while rounds advance only by "Next round". */
  roundEndsIn: string | null;
  /** "Rounds end Nov 12, 3:04 PM". */
  roundsEnd: string | null;
  targetQuantity: number | null;
}

export function roundHeader(listing: RoundsListing, now: number, timeZone?: string): RoundHeader {
  const roundEnds = ms(listing.roundEndsAt);
  const roundsEnd = ms(listing.roundsEndAt);
  return {
    round: listing.currentRound ?? 1,
    roundEndsIn: roundEnds === null ? null : `ends in ${formatMmSs(roundEnds - now)}`,
    roundsEnd: roundsEnd === null ? null : `Rounds end ${formatDeadline(roundsEnd, timeZone)}`,
    targetQuantity: listing.targetQuantity,
  };
}

// --- What the panel shows ----------------------------------------------------------------------

export type RoundsPanelMode =
  /** OPEN, rounds never ran: the "Start live rounds" control (hidden for VIEWER). */
  | 'start'
  /** ROUNDS_ACTIVE: round header, target edit, "Next round", "Stop". */
  | 'active'
  /** ROUNDS_ENDED: the header stays, read-only; the banner points at Clear. */
  | 'ended'
  | 'hidden';

export function roundsPanelMode(
  phase: ListingPhaseName,
  listing: Pick<RoundsListing, 'status' | 'roundsStartedAt'>,
  viewer: boolean,
): RoundsPanelMode {
  switch (phase) {
    case 'BIDDING':
    case 'AWAITING_ROUNDS_OR_CLEAR':
      return !viewer && listing.status === 'OPEN' && !listing.roundsStartedAt ? 'start' : 'hidden';
    case 'ROUNDS_ACTIVE':
      return 'active';
    case 'ROUNDS_ENDED':
      return 'ended';
    default:
      return 'hidden';
  }
}

/** Target quantity input: an integer in `1 … quantity`, or the reason it is not. */
export function parseTargetQuantity(
  raw: string,
  max: number,
): { ok: true; value: number } | { ok: false; message: string } {
  const value = Number(raw.trim());
  if (!raw.trim() || !Number.isInteger(value) || value < 1 || value > max) {
    return { ok: false, message: `Enter a whole number from 1 to ${max.toLocaleString('en-US')}.` };
  }
  return { ok: true, value };
}
