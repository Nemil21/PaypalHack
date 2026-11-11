import { listingPhase, type BookListing, type ListingPhaseName } from '@holdfast/shared';

/**
 * The console header's status pill and deadline (HF-023), from the shared `listingPhase()` so the
 * console, rounds controls (HF-037a), Clear modal (HF-028) and overview (HF-026) agree. The book
 * carries the phase at `asOf`; the console recomputes it every second so the header flips from
 * BIDDING to "Bidding closed" when the window closes, without a refetch (D7: still `OPEN`).
 */

export type PhaseTone = 'held' | 'neutral' | 'dark' | 'success' | 'danger';

export interface PhaseView {
  phase: ListingPhaseName;
  /** Status pill text (rendered uppercase). */
  pill: string;
  tone: PhaseTone;
  /** "Closes in 41:12:09", "Bidding closed · start rounds or Clear by Nov 12, 3:04 PM", … */
  deadline: string | null;
  /** Epoch ms of the deadline, when the phase has one. */
  deadlineAt: number | null;
  /** Inputs locked: CLEARING onward (→ W08) and terminal states are read-only. */
  locked: boolean;
  /** The brand can still cancel the window (HF-012b: from OPEN or ROUNDS). */
  cancellable: boolean;
}

const HOUR = 3_600_000;

/** "41:12:09" for a countdown; "0:00:00" once it has passed. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** "Nov 12, 3:04 PM" in the viewer's time zone (tests pass `timeZone`). */
export function formatDeadline(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(ms);
}

/** "in 5:12:09" while under 72 h away; past deadlines read "passed". */
function until(deadline: number, now: number): string {
  const left = deadline - now;
  if (left <= 0) return 'passed';
  return left < 72 * HOUR ? `in ${formatCountdown(left)}` : '';
}

export function phaseView(
  listing: Pick<
    BookListing,
    | 'status'
    | 'windowClosesAt'
    | 'roundsEndAt'
    | 'roundEndsAt'
    | 'clearDeadlineAt'
    | 'currentRound'
    | 'oldestHoldAuthorizedAt'
  >,
  now: number,
  opts: { timeZone?: string } = {},
): PhaseView {
  const p = listingPhase(
    {
      status: listing.status,
      // A DRAFT has no window yet; treat it as already closed (it never reads as BIDDING).
      windowClosesAt: listing.windowClosesAt ?? now,
      roundsEndAt: listing.roundsEndAt,
      roundEndsAt: listing.roundEndsAt,
      clearDeadlineAt: listing.clearDeadlineAt,
      currentRound: listing.currentRound,
      oldestHoldAuthorizedAt: listing.oldestHoldAuthorizedAt,
    },
    now,
  );
  const at = p.deadline;
  const clearBy = at === null ? null : `Clear by ${formatDeadline(at, opts.timeZone)}`;
  const view = (
    pill: string,
    tone: PhaseTone,
    deadline: string | null,
    flags: { locked?: boolean; cancellable?: boolean } = {},
  ): PhaseView => ({
    phase: p.phase,
    pill,
    tone,
    deadline,
    deadlineAt: at,
    locked: flags.locked ?? false,
    cancellable: flags.cancellable ?? false,
  });

  switch (p.phase) {
    case 'DRAFT':
      return view('Draft', 'neutral', 'Not published yet', { locked: true });
    case 'BIDDING':
      return view(
        'Open',
        'held',
        at === null ? null : `Closes ${until(at, now) || formatDeadline(at, opts.timeZone)}`,
        { cancellable: true },
      );
    case 'AWAITING_ROUNDS_OR_CLEAR':
      // Still `OPEN` (D7): the deadline line says bidding is closed.
      return view(
        'Open',
        'dark',
        `Bidding closed · start rounds or ${clearBy ? lowerFirst(clearBy) : 'clear'}`,
        { cancellable: true },
      );
    case 'ROUNDS_ACTIVE': {
      const round = p.round ? ` · round ${p.round}` : '';
      return view(
        `Rounds${round}`,
        'held',
        at === null ? null : `Rounds end ${until(at, now) || formatDeadline(at, opts.timeZone)}`,
        { cancellable: true },
      );
    }
    case 'ROUNDS_ENDED':
      return view(
        'Rounds ended',
        'dark',
        clearBy ? `Rounds ended · ${lowerFirst(clearBy)}` : null,
        {
          cancellable: true,
        },
      );
    case 'CLEARING':
      return view('Clearing', 'held', 'Capturing winners and releasing other holds', {
        locked: true,
      });
    case 'SETTLED':
      return view('Settled', 'success', 'Winners charged · paying out', { locked: true });
    case 'PAID_OUT':
      return view('Paid out', 'success', 'Payout sent', { locked: true });
    case 'PAYOUT_FAILED':
      return view('Payout failed', 'danger', 'Payout failed · retry from settlement', {
        locked: true,
      });
    case 'EXPIRED':
      return view('Expired', 'neutral', 'Window expired · every hold released', { locked: true });
    case 'CANCELLED':
      return view('Cancelled', 'neutral', 'Window cancelled · every hold released', {
        locked: true,
      });
  }
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Nav badge for a listing in `GET /api/listings` (HF-012a rows carry status and window, not round
 * timing): BIDDING / AWAITING_ROUNDS_OR_CLEAR for OPEN listings, else the status. The open
 * listing's badge uses the console's live `phaseView` instead.
 */
export function navPhaseLabel(
  l: { status: BookListing['status']; windowClosesAt: string | null },
  now: number = Date.now(),
): string {
  if (l.status !== 'OPEN' || !l.windowClosesAt) return l.status;
  return listingPhase({ status: 'OPEN', windowClosesAt: l.windowClosesAt }, now).phase;
}
