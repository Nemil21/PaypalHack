import { describe, expect, it } from 'vitest';
import {
  HOLD_MAX_AGE_HOURS,
  clearBy,
  isBiddable,
  isRaisable,
  listingPhase,
  type ListingTiming,
} from './listing.js';
import type { ListingStatus } from './status.js';

const H = 3_600_000;
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const future = new Date(NOW + H);
const past = new Date(NOW - H);

function listing(status: ListingStatus, over: Partial<ListingTiming> = {}): ListingTiming {
  return { status, windowClosesAt: future, roundsEndAt: null, ...over };
}

describe('isBiddable / isRaisable (D7)', () => {
  it.each<[string, ListingTiming, boolean, boolean]>([
    ['OPEN before window_closes_at', listing('OPEN'), true, true],
    ['OPEN at window_closes_at', listing('OPEN', { windowClosesAt: NOW }), false, false],
    ['OPEN after window_closes_at', listing('OPEN', { windowClosesAt: past }), false, false],
    [
      'ROUNDS before rounds_end_at',
      listing('ROUNDS', { windowClosesAt: past, roundsEndAt: future }),
      false,
      true,
    ],
    [
      'ROUNDS at rounds_end_at',
      listing('ROUNDS', { windowClosesAt: past, roundsEndAt: NOW }),
      false,
      false,
    ],
    [
      'ROUNDS after rounds_end_at',
      listing('ROUNDS', { windowClosesAt: past, roundsEndAt: past }),
      false,
      false,
    ],
    // Starting rounds clamps window_closes_at to now, but even if it didn't, ROUNDS takes no new bids.
    [
      'ROUNDS with an unclamped future window',
      listing('ROUNDS', { windowClosesAt: future, roundsEndAt: future }),
      false,
      true,
    ],
    ['ROUNDS with no rounds_end_at', listing('ROUNDS', { windowClosesAt: past }), false, false],
    ['CLEARING', listing('CLEARING', { roundsEndAt: future }), false, false],
    ['CANCELLED', listing('CANCELLED', { roundsEndAt: future }), false, false],
    ['DRAFT', listing('DRAFT'), false, false],
    ['EXPIRED', listing('EXPIRED'), false, false],
    ['SETTLED', listing('SETTLED'), false, false],
  ])('%s', (_name, l, biddable, raisable) => {
    expect(isBiddable(l, NOW)).toBe(biddable);
    expect(isRaisable(l, NOW)).toBe(raisable);
  });

  it('accepts ISO strings and Dates', () => {
    const l = listing('OPEN', { windowClosesAt: future.toISOString() });
    expect(isBiddable(l, new Date(NOW))).toBe(true);
    expect(isBiddable(l, new Date(NOW).toISOString())).toBe(true);
  });

  it('rejects an invalid date', () => {
    expect(() => isBiddable(listing('OPEN', { windowClosesAt: 'not a date' }), NOW)).toThrow();
  });
});

describe('listingPhase', () => {
  const clearDeadlineAt = NOW + 5 * H;

  it('BIDDING with the window deadline', () => {
    expect(listingPhase(listing('OPEN'), NOW)).toEqual({
      phase: 'BIDDING',
      deadlineKind: 'WINDOW_CLOSES',
      deadline: future.getTime(),
      round: null,
    });
  });

  it('AWAITING_ROUNDS_OR_CLEAR once the window closed while still OPEN', () => {
    const p = listingPhase(listing('OPEN', { windowClosesAt: past, clearDeadlineAt }), NOW);
    expect(p).toMatchObject({ phase: 'AWAITING_ROUNDS_OR_CLEAR', deadlineKind: 'CLEAR_BY' });
    expect(p.deadline).toBe(clearDeadlineAt);
  });

  it('ROUNDS_ACTIVE with round and rounds_end_at', () => {
    const p = listingPhase(
      listing('ROUNDS', { windowClosesAt: past, roundsEndAt: future, currentRound: 2 }),
      NOW,
    );
    expect(p).toEqual({
      phase: 'ROUNDS_ACTIVE',
      deadlineKind: 'ROUNDS_END',
      deadline: future.getTime(),
      round: 2,
    });
  });

  it('ROUNDS_ENDED after rounds_end_at, with clear-by', () => {
    const p = listingPhase(
      listing('ROUNDS', {
        windowClosesAt: past,
        roundsEndAt: past,
        clearDeadlineAt,
        currentRound: 3,
      }),
      NOW,
    );
    expect(p).toEqual({
      phase: 'ROUNDS_ENDED',
      deadlineKind: 'CLEAR_BY',
      deadline: clearDeadlineAt,
      round: 3,
    });
  });

  it.each([
    'CLEARING',
    'SETTLED',
    'PAID_OUT',
    'PAYOUT_FAILED',
    'EXPIRED',
    'CANCELLED',
    'DRAFT',
  ] as const)('%s maps through with no deadline', (status) => {
    expect(listingPhase(listing(status), NOW)).toEqual({
      phase: status,
      deadlineKind: null,
      deadline: null,
      round: null,
    });
  });

  it('clear-by is the earlier of clear_deadline_at and oldest hold + 66 h', () => {
    const oldest = NOW - 63 * H; // hits 66 h at NOW + 3 h, before clearDeadlineAt (NOW + 5 h)
    expect(clearBy(listing('OPEN', { clearDeadlineAt, oldestHoldAuthorizedAt: oldest }))).toBe(
      oldest + HOLD_MAX_AGE_HOURS * H,
    );
    expect(clearBy(listing('OPEN', { clearDeadlineAt, oldestHoldAuthorizedAt: NOW }))).toBe(
      clearDeadlineAt,
    );
    expect(clearBy(listing('OPEN'))).toBeNull();
  });
});
