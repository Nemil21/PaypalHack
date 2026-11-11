import { describe, expect, it } from 'vitest';
import {
  BASE_EXTENSION_MS,
  BASE_ROUND_MS,
  BASE_ROUNDS_CAP_MS,
  BASE_SOFT_CLOSE_MS,
  decideTick,
  inSoftClose,
  roundsTiming,
  softCloseEnds,
  UNSCALED_TIMING,
  type TickState,
} from './timing.js';

const MIN = 60_000;

describe('roundsTiming (ROUNDS_TIME_SCALE)', () => {
  it('scale 1 is 30 min rounds, 5 min soft close, 10 min extension, 6 h cap', () => {
    expect(UNSCALED_TIMING).toEqual({
      roundMs: 30 * MIN,
      softCloseMs: 5 * MIN,
      extensionMs: 10 * MIN,
      capMs: 6 * 60 * MIN,
    });
  });

  it('0.0667 gives ~2-min rounds and scales the soft close, extension and cap with them', () => {
    const t = roundsTiming(0.0667);
    expect(t.roundMs).toBe(Math.round(BASE_ROUND_MS * 0.0667)); // 120.06 s
    expect(t.softCloseMs).toBe(Math.round(BASE_SOFT_CLOSE_MS * 0.0667)); // 20 s
    expect(t.extensionMs).toBe(Math.round(BASE_EXTENSION_MS * 0.0667)); // 40 s
    expect(t.capMs).toBe(Math.round(BASE_ROUNDS_CAP_MS * 0.0667)); // 24 min
    // Same proportions as the real thing.
    expect(t.softCloseMs / t.roundMs).toBeCloseTo(1 / 6, 3);
    expect(t.extensionMs / t.roundMs).toBeCloseTo(1 / 3, 3);
  });

  it('rejects a non-positive scale', () => {
    expect(() => roundsTiming(0)).toThrow();
    expect(() => roundsTiming(-1)).toThrow();
    expect(() => roundsTiming(Number.NaN)).toThrow();
  });
});

describe('soft close arithmetic', () => {
  const end = 1_000 * MIN; // round ends here
  const cap = end + 60 * MIN; // rounds_end_at far away

  it('only a raise in the last 5 min of the round counts', () => {
    expect(inSoftClose(end - 5 * MIN, end, UNSCALED_TIMING)).toBe(true);
    expect(inSoftClose(end - 1, end, UNSCALED_TIMING)).toBe(true);
    expect(inSoftClose(end - 5 * MIN - 1, end, UNSCALED_TIMING)).toBe(false);
    expect(inSoftClose(end, end, UNSCALED_TIMING)).toBe(false); // the round is over
  });

  it('one raise in the window extends by 10 min', () => {
    expect(softCloseEnds([end - MIN], end, cap, UNSCALED_TIMING)).toEqual([end + 10 * MIN]);
  });

  it('a raise outside the window does not extend', () => {
    expect(softCloseEnds([end - 6 * MIN], end, cap, UNSCALED_TIMING)).toEqual([]);
  });

  it('two raises at once extend once each', () => {
    expect(softCloseEnds([end - MIN, end - MIN], end, cap, UNSCALED_TIMING)).toEqual([
      end + 10 * MIN,
      end + 20 * MIN,
    ]);
  });

  it('never past rounds_end_at, and stops once at the cap', () => {
    const near = end + 15 * MIN;
    expect(softCloseEnds([end - MIN, end - MIN, end - MIN], end, near, UNSCALED_TIMING)).toEqual([
      end + 10 * MIN,
      near,
    ]);
    expect(softCloseEnds([end - MIN], end, end, UNSCALED_TIMING)).toEqual([]);
  });

  it('scales: with 2-min rounds the window is 20 s and the extension 40 s', () => {
    const t = roundsTiming(0.0667);
    expect(softCloseEnds([end - 19_000], end, cap, t)).toEqual([end + t.extensionMs]);
    expect(softCloseEnds([end - 21_000], end, cap, t)).toEqual([]);
    expect(t.extensionMs).toBe(40_020);
  });
});

describe('decideTick: end-rule table', () => {
  const base: TickState = {
    now: 100 * MIN,
    roundEndsAt: 110 * MIN,
    roundsEndAt: 300 * MIN,
    nudgesThisRound: 3,
    raisesThisRound: 0,
  };
  const cases: [string, Partial<TickState>, ReturnType<typeof decideTick>][] = [
    ['round still running', {}, { kind: 'WAIT' }],
    [
      'round over, raises seen → advance',
      { now: 110 * MIN, raisesThisRound: 2 },
      { kind: 'ADVANCE' },
    ],
    [
      'round over, nudged but no raise → NO_RAISES',
      { now: 110 * MIN },
      { kind: 'END', reason: 'NO_RAISES' },
    ],
    [
      'round over, nobody was nudged → advance (snapshot decides NONE_BELOW_CUTOFF)',
      { now: 110 * MIN, nudgesThisRound: 0 },
      { kind: 'ADVANCE' },
    ],
    [
      'rounds cap reached → CAP_REACHED even mid-round',
      { now: 300 * MIN, raisesThisRound: 5 },
      { kind: 'END', reason: 'CAP_REACHED' },
    ],
    [
      'cap and round end at the same instant → CAP_REACHED',
      { now: 300 * MIN, roundEndsAt: 300 * MIN },
      { kind: 'END', reason: 'CAP_REACHED' },
    ],
  ];
  it.each(cases)('%s', (_name, patch, expected) => {
    expect(decideTick({ ...base, ...patch })).toEqual(expected);
  });
});
