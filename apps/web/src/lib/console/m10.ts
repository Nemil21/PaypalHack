import { formatCompactUsd, type ListingPhaseName } from '@holdfast/shared';

/**
 * M10 brand mobile alert + clear approval (HF-061, screens.md M10). No React. `/brand/listings/:id`
 * is one route: phones get M10, wider screens W06. The `brand_window_closing` push (HF-054b)
 * deep-links to that route, so a tap on a phone lands here.
 */

/** Below this width the console renders M10 (Tailwind's `sm` breakpoint). */
export const M10_MEDIA_QUERY = '(max-width: 639px)';

export type ConsoleLayout = 'mobile' | 'desktop';

/**
 * `?view=mobile` / `?view=desktop` force a layout (demo recording on a laptop, a tablet that
 * wants M10); otherwise the viewport decides.
 */
export function consoleLayout(search: string, narrow: boolean): ConsoleLayout {
  const view = new URLSearchParams(search).get('view');
  if (view === 'mobile' || view === 'desktop') return view;
  return narrow ? 'mobile' : 'desktop';
}

/** M10's states (screens.md: open, clearing progress, done; plus rounds and a closed window). */
export type M10State = 'open' | 'rounds' | 'clearing' | 'done' | 'closed';

export function m10State(phase: ListingPhaseName, clearedHere = false): M10State {
  switch (phase) {
    case 'BIDDING':
    case 'AWAITING_ROUNDS_OR_CLEAR':
      // A 202 from this phone: show progress before the book catches up with CLEARING.
      return clearedHere ? 'clearing' : 'open';
    case 'ROUNDS_ACTIVE':
    case 'ROUNDS_ENDED':
      return clearedHere ? 'clearing' : 'rounds';
    case 'CLEARING':
      return 'clearing';
    case 'SETTLED':
    case 'PAID_OUT':
    case 'PAYOUT_FAILED':
      return 'done';
    default:
      return 'closed';
  }
}

/** "6 h", "42 min": the push's rounding (whole hours, at least 1 h) above an hour. */
export function timeLeftShort(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.ceil(ms / 60_000))} min`;
  return `${Math.max(1, Math.round(ms / 3_600_000))} h`;
}

/**
 * The M10 alert line, the push title on screen: "Window closes in 6 h · $61k held". Only while
 * bidding is open and the window has not passed; null otherwise.
 */
export function closingAlert(
  phase: ListingPhaseName,
  windowClosesAt: number | null,
  now: number,
  heldCents: number,
): string | null {
  if (phase !== 'BIDDING' || windowClosesAt === null || windowClosesAt <= now) return null;
  return `Window closes in ${timeLeftShort(windowClosesAt - now)} · ${formatCompactUsd(heldCents)} held`;
}
