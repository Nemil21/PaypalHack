import { describe, expect, it } from 'vitest';
import { listingPhase, type RoundsState } from '@holdfast/shared';
import {
  FIXTURE_ROUNDS_LISTING_ID,
  roundsReplayEvents,
} from '../../../../../packages/shared/fixtures/rounds';
import {
  applyRoundEvent,
  formatMmSs,
  overlayFromState,
  parseTargetQuantity,
  roundHeader,
  roundsEndedCopy,
  roundsPanelMode,
  startConfirmCopy,
  startPreview,
  stopClearBy,
  withRoundsOverlay,
  type RoundsListing,
  type RoundsOverlay,
} from './rounds';

const NOW = Date.parse('2026-11-11T20:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const TZ = 'UTC';

const open: RoundsListing = {
  status: 'OPEN',
  quantity: 240,
  windowOpensAt: iso(NOW - 20 * H),
  windowClosesAt: iso(NOW + 4 * H),
  roundsStartedAt: null,
  roundsEndAt: null,
  roundEndsAt: null,
  currentRound: null,
  targetQuantity: null,
  clearDeadlineAt: iso(NOW + 10 * H),
  oldestHoldAuthorizedAt: iso(NOW - 19 * H),
};

const inRounds: RoundsListing = {
  ...open,
  status: 'ROUNDS',
  windowClosesAt: iso(NOW - H),
  roundsStartedAt: iso(NOW - H),
  currentRound: 2,
  roundEndsAt: iso(NOW + 4 * 60_000 + 59_000),
  roundsEndAt: iso(NOW + 5 * H),
  targetQuantity: 200,
  clearDeadlineAt: iso(NOW + 11 * H),
};

describe('startPreview: the deadlines a start sets (D6/D7, mirrors core startRounds)', () => {
  it('window still open: rounds end 6 h from now; Clear 6 h after that', () => {
    const p = startPreview(open, NOW);
    expect(p).toEqual({ possible: true, roundsEndAt: NOW + 6 * H, clearDeadlineAt: NOW + 12 * H });
  });

  it('window closed 2 h ago: rounds end 6 h after the close', () => {
    const p = startPreview({ ...open, windowClosesAt: iso(NOW - 2 * H) }, NOW);
    expect(p.roundsEndAt).toBe(NOW + 4 * H);
    expect(p.clearDeadlineAt).toBe(NOW + 10 * H);
  });

  it('Clear by is capped at window_opens_at + 60 h', () => {
    const p = startPreview({ ...open, windowOpensAt: iso(NOW - 50 * H) }, NOW);
    expect(p.clearDeadlineAt).toBe(NOW + 10 * H);
  });

  it('6 h after the close: not possible (ROUNDS_WINDOW_PASSED)', () => {
    expect(startPreview({ ...open, windowClosesAt: iso(NOW - 6 * H) }, NOW).possible).toBe(false);
  });

  it('confirm copy, verbatim', () => {
    expect(startConfirmCopy(startPreview(open, NOW), TZ)).toBe(
      'Starting rounds closes bidding to new bids. Rounds end by Nov 12, 2:00 AM. Clear by Nov 12, 8:00 AM.',
    );
  });
});

describe('stop and the ended banner', () => {
  it('stop: Clear by = least(clear_deadline_at, now + 6 h)', () => {
    expect(stopClearBy(inRounds, NOW)).toBe(NOW + 6 * H);
    expect(stopClearBy({ ...inRounds, clearDeadlineAt: iso(NOW + 2 * H) }, NOW)).toBe(NOW + 2 * H);
  });

  it('banner quotes the Clear deadline', () => {
    const ended = { ...inRounds, roundsEndAt: iso(NOW - 1000), clearDeadlineAt: iso(NOW + 6 * H) };
    expect(roundsEndedCopy(ended, TZ)).toBe('Rounds ended. Press Clear by Nov 12, 2:00 AM.');
  });
});

describe('round header', () => {
  it('round N, mm:ss to the round end, overall end', () => {
    expect(roundHeader(inRounds, NOW, TZ)).toEqual({
      round: 2,
      roundEndsIn: 'ends in 04:59',
      roundsEnd: 'Rounds end Nov 12, 1:00 AM',
      targetQuantity: 200,
    });
  });

  it('no round end while rounds advance by "Next round" only', () => {
    expect(roundHeader({ ...inRounds, roundEndsAt: null }, NOW).roundEndsIn).toBeNull();
  });

  it('formatMmSs', () => {
    expect(formatMmSs(299_001)).toBe('05:00');
    expect(formatMmSs(59_000)).toBe('00:59');
    expect(formatMmSs(75 * 60_000)).toBe('75:00');
    expect(formatMmSs(-5)).toBe('00:00');
  });
});

describe('roundsPanelMode', () => {
  it('start only on an OPEN listing that never ran rounds, never for VIEWER', () => {
    expect(roundsPanelMode('BIDDING', open, false)).toBe('start');
    expect(roundsPanelMode('AWAITING_ROUNDS_OR_CLEAR', open, false)).toBe('start');
    expect(roundsPanelMode('BIDDING', open, true)).toBe('hidden');
  });

  it('VIEWER still sees the rounds state', () => {
    expect(roundsPanelMode('ROUNDS_ACTIVE', inRounds, true)).toBe('active');
    expect(roundsPanelMode('ROUNDS_ENDED', inRounds, true)).toBe('ended');
  });

  it('hidden from CLEARING onward', () => {
    for (const p of ['CLEARING', 'SETTLED', 'CANCELLED', 'EXPIRED', 'DRAFT'] as const) {
      expect(roundsPanelMode(p, inRounds, false)).toBe('hidden');
    }
  });
});

describe('parseTargetQuantity', () => {
  it('accepts 1 … quantity', () => {
    expect(parseTargetQuantity('240', 240)).toEqual({ ok: true, value: 240 });
    expect(parseTargetQuantity(' 1 ', 240)).toEqual({ ok: true, value: 1 });
  });
  it.each(['', '0', '241', '2.5', 'abc', '-3'])('refuses %j', (raw) => {
    expect(parseTargetQuantity(raw, 240).ok).toBe(false);
  });
});

describe('rounds overlay', () => {
  it('the fixture replay alone drives OPEN → ROUNDS_ACTIVE → ROUNDS_ENDED', () => {
    const startAt = iso(NOW);
    const events = roundsReplayEvents({ startAt, roundMs: 5 * 60_000, end: true });
    const book = { ...open, windowClosesAt: iso(NOW + 4 * H) };

    let overlay: RoundsOverlay | null = null;
    const phaseAfter = (n: number, now: number) => {
      overlay = null;
      for (const e of events.slice(0, n)) overlay = applyRoundEvent(overlay, e);
      return listingPhase(
        {
          ...withRoundsOverlay(book, overlay),
          windowClosesAt: withRoundsOverlay(book, overlay).windowClosesAt!,
        },
        now,
      );
    };

    expect(phaseAfter(0, NOW).phase).toBe('BIDDING');
    const started = events.findIndex((e) => e.type === 'round.started') + 1;
    expect(phaseAfter(started, NOW + 500)).toMatchObject({ phase: 'ROUNDS_ACTIVE', round: 1 });
    const merged = withRoundsOverlay(book, overlay);
    expect(merged.targetQuantity).toBe(6);
    expect(merged.roundEndsAt).toBe(iso(NOW + 5 * 60_000));
    // Starting rounds closed bidding.
    expect(Date.parse(merged.windowClosesAt!)).toBe(NOW);

    expect(events.at(-1)!.type).toBe('round.ended');
    const ended = phaseAfter(events.length, NOW + 60_000);
    expect(ended.phase).toBe('ROUNDS_ENDED');
  });

  it('the replay stays as before without the new options', () => {
    const events = roundsReplayEvents({ listingId: FIXTURE_ROUNDS_LISTING_ID });
    expect(events.some((e) => e.type === 'round.ended')).toBe(false);
    const started = events.find((e) => e.type === 'round.started');
    expect(started && 'roundEndsAt' in started && started.roundEndsAt).toBeNull();
  });

  it('a book on a later round wins outright', () => {
    const overlay: RoundsOverlay = { round: 1, roundsEndAt: iso(NOW - 1) };
    expect(withRoundsOverlay(inRounds, overlay)).toBe(inRounds);
  });

  it('never overrides a listing past rounds', () => {
    const cancelled = { ...inRounds, status: 'CANCELLED' as const };
    expect(withRoundsOverlay(cancelled, { round: 9 })).toBe(cancelled);
  });

  it('same round: stop moves the ends earlier, soft close the round end later', () => {
    const merged = withRoundsOverlay(inRounds, {
      round: 2,
      roundsEndAt: iso(NOW),
      clearDeadlineAt: iso(NOW + 6 * H),
      roundEndsAt: iso(NOW + 9 * 60_000),
      targetQuantity: 1,
    });
    expect(merged.roundsEndAt).toBe(iso(NOW));
    expect(merged.clearDeadlineAt).toBe(iso(NOW + 6 * H));
    expect(merged.roundEndsAt).toBe(iso(NOW + 9 * 60_000));
    expect(merged.targetQuantity).toBe(200);
    // ...but a stale overlay never moves them back.
    const stale = withRoundsOverlay(inRounds, { round: 2, roundsEndAt: iso(NOW + 9 * H) });
    expect(stale.roundsEndAt).toBe(inRounds.roundsEndAt);
  });

  it('a rounds endpoint response is ahead of a book still OPEN', () => {
    const state: RoundsState = {
      listingId: 'l',
      status: 'ROUNDS',
      round: 1,
      targetQuantity: 180,
      roundsStartedAt: iso(NOW),
      roundEndsAt: null,
      roundsEndAt: iso(NOW + 6 * H),
      windowClosesAt: iso(NOW),
      clearDeadlineAt: iso(NOW + 12 * H),
      nudged: 3,
      endedReason: null,
    };
    const merged = withRoundsOverlay(open, overlayFromState(state));
    expect(merged).toMatchObject({ status: 'ROUNDS', currentRound: 1, targetQuantity: 180 });
    expect(overlayFromState({ ...state, status: 'OPEN', round: null })).toBeNull();
  });
});
