import type { RoundEndReason } from '@holdfast/shared';

/**
 * Live rounds timing and rules, pure (HF-036b; features/19 §Logic 2, 6, 7).
 *
 * `ROUNDS_TIME_SCALE` scales the round length, the soft-close window, the extension and the
 * rounds cap (e.g. 0.0667 → 2-min rounds for recording). It never touches hold age,
 * `clear_deadline_at` or expiry math: those keep their real 6 h / 60 h constants (D6).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const BASE_ROUND_MS = 30 * MINUTE;
export const BASE_SOFT_CLOSE_MS = 5 * MINUTE;
export const BASE_EXTENSION_MS = 10 * MINUTE;
export const BASE_ROUNDS_CAP_MS = 6 * HOUR;
/** The in-process tick period (not Render cron). */
export const ROUNDS_TICK_MS = 5_000;

export interface RoundsTiming {
  /** Length of one round. */
  roundMs: number;
  /** A raise this close to the round's end extends it. */
  softCloseMs: number;
  /** How far one soft-close raise pushes the round's end. */
  extensionMs: number;
  /** `rounds_end_at = least(now() + capMs, window_closes_at + 6 h)`. */
  capMs: number;
}

/** The timing for a `ROUNDS_TIME_SCALE`. Scale 1 is the real 30 / 5 / 10 min and 6 h. */
export function roundsTiming(scale = 1): RoundsTiming {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('ROUNDS_TIME_SCALE must be > 0');
  const s = (ms: number) => Math.max(1_000, Math.round(ms * scale));
  return {
    roundMs: s(BASE_ROUND_MS),
    softCloseMs: s(BASE_SOFT_CLOSE_MS),
    extensionMs: s(BASE_EXTENSION_MS),
    capMs: s(BASE_ROUNDS_CAP_MS),
  };
}

export const UNSCALED_TIMING: RoundsTiming = roundsTiming(1);

/** Is a raise at `raisedAt` in the soft-close window of a round ending at `roundEndsAt`? */
export function inSoftClose(raisedAt: number, roundEndsAt: number, timing: RoundsTiming): boolean {
  return raisedAt < roundEndsAt && raisedAt >= roundEndsAt - timing.softCloseMs;
}

/**
 * Soft close (19 §Logic 6): every raise in the last `softCloseMs` of the round extends it by
 * `extensionMs`, never past `rounds_end_at`. Raises handled in the same tick happened "at once":
 * each is judged against the round's end as it stood before this tick (`roundEndsAt`), and each
 * that qualifies extends once. Returns the successive ends, one per raise that moved it.
 */
export function softCloseEnds(
  raisedAt: readonly number[],
  roundEndsAt: number,
  roundsEndAt: number,
  timing: RoundsTiming,
): number[] {
  const ends: number[] = [];
  let end = roundEndsAt;
  for (const at of raisedAt) {
    if (!inSoftClose(at, roundEndsAt, timing)) continue;
    const next = Math.min(end + timing.extensionMs, roundsEndAt);
    if (next <= end) break; // at the cap: nothing more to extend
    end = next;
    ends.push(end);
  }
  return ends;
}

export interface TickState {
  /** DB clock. */
  now: number;
  roundEndsAt: number;
  roundsEndAt: number;
  /** Nudges written for the current round. */
  nudgesThisRound: number;
  /** `bid.raised` landed since the current round started. */
  raisesThisRound: number;
}

export type TickDecision =
  | { kind: 'WAIT' }
  | { kind: 'ADVANCE' }
  | { kind: 'END'; reason: Extract<RoundEndReason, 'CAP_REACHED' | 'NO_RAISES'> };

/**
 * What one tick does to a listing in live rounds once soft-close extensions are applied
 * (19 §Logic 7). The other two end rules happen elsewhere: `NONE_BELOW_CUTOFF` in the new round's
 * snapshot, `BRAND_STOPPED` in `stopRounds`.
 * - `now ≥ rounds_end_at` → END `CAP_REACHED` (the 6 h cap, scaled);
 * - the round is still running → WAIT;
 * - the round sent ≥ 1 nudge and saw no raise → END `NO_RAISES`;
 * - otherwise → ADVANCE to the next round.
 */
export function decideTick(s: TickState): TickDecision {
  if (s.now >= s.roundsEndAt) return { kind: 'END', reason: 'CAP_REACHED' };
  if (s.now < s.roundEndsAt) return { kind: 'WAIT' };
  if (s.nudgesThisRound >= 1 && s.raisesThisRound === 0)
    return { kind: 'END', reason: 'NO_RAISES' };
  return { kind: 'ADVANCE' };
}
