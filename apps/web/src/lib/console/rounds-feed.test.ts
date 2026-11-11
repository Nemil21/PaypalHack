import { describe, expect, it } from 'vitest';
import type { ListingEvent, RoundsActivity } from '@holdfast/shared';
import { roundsReplayEvents } from '../../../../../packages/shared/fixtures/rounds';
import {
  EMPTY_FEED,
  applyFeedEvent,
  endedCopy,
  extensionCopy,
  feedFromActivity,
  feedRows,
  formatDuration,
  mergeFeeds,
  raiseCopy,
  recentExtension,
  roundSummaryCopy,
  signedUsd,
  type RoundsFeed,
} from './rounds-feed';

const START = '2026-11-11T20:00:00.000Z';
const T = Date.parse(START);
const fold = (events: ListingEvent[], from: RoundsFeed = EMPTY_FEED) =>
  events.reduce(applyFeedEvent, from);

const activity = (patch: Partial<RoundsActivity> = {}): RoundsActivity => ({
  listingId: 'l1',
  status: 'ROUNDS',
  currentRound: 1,
  targetQuantity: 6,
  expectedGrossCents: 150_000,
  rounds: [
    {
      round: 1,
      startedAt: START,
      nudged: 4,
      raised: 1,
      grossAtStartCents: 148_000,
      grossDeltaCents: 121_000,
    },
  ],
  raises: [
    {
      bidId: 'b-new',
      replacesBidId: 'b-old',
      oldCents: 21_900,
      newCents: 24_100,
      shopperLabel: 'Shopper #1007',
      source: 'SIM',
      isSimulated: true,
      at: new Date(T + 5_000).toISOString(),
      round: 1,
    },
  ],
  extensions: [],
  ended: null,
  ...patch,
});

describe('copy', () => {
  it('raise row: a new hold and a released one (no in-place increase)', () => {
    expect(raiseCopy({ oldCents: 21_900, newCents: 24_100 })).toBe(
      'New $241 hold placed · $219 hold released',
    );
  });

  it('round summary: nudged, raised, expected gross Δ (omitted when unknown)', () => {
    expect(roundSummaryCopy(activity().rounds[0]!)).toBe(
      'Round 1: nudged 4, raised 1, expected gross +$1,210',
    );
    expect(roundSummaryCopy({ ...activity().rounds[0]!, grossDeltaCents: -4_000, round: 2 })).toBe(
      'Round 2: nudged 4, raised 1, expected gross −$40',
    );
    expect(roundSummaryCopy({ ...activity().rounds[0]!, grossDeltaCents: null })).toBe(
      'Round 1: nudged 4, raised 1',
    );
    expect(signedUsd(0)).toBe('+$0');
  });

  it('extension note and end reasons', () => {
    expect(extensionCopy({ extendedByMs: 600_000 })).toBe('+10 min (late raise)');
    expect(extensionCopy({ extendedByMs: 40_000 })).toBe('+40 s (late raise)');
    expect(extensionCopy({ extendedByMs: 0 })).toBe('(late raise)');
    expect(formatDuration(90_000)).toBe('2 min');
    expect(endedCopy({ round: 3, reason: 'CAP_REACHED' })).toBe(
      'Rounds ended in round 3: time cap reached.',
    );
    expect(endedCopy({ round: 2, reason: 'NO_RAISES' })).toBe(
      'Rounds ended in round 2: no raises last round.',
    );
    expect(endedCopy({ round: 1, reason: 'NONE_BELOW_CUTOFF' })).toBe(
      'Rounds ended in round 1: nobody below the cutoff.',
    );
    expect(endedCopy({ round: 1, reason: 'BRAND_STOPPED' })).toBe(
      'Rounds ended in round 1: stopped.',
    );
  });
});

describe('fixture replay events', () => {
  const events = roundsReplayEvents({
    startAt: START,
    roundMs: 300_000,
    raises: 3,
    extend: true,
    end: true,
    endReason: 'NO_RAISES',
  });

  it('folds into rounds, raises with SIM flags, the extension and the end', () => {
    const feed = fold(events);
    const nudged = events.filter((e) => e.type === 'round.nudged').length;
    expect(feed.rounds).toEqual([
      expect.objectContaining({ round: 1, nudged, raised: 3, grossDeltaCents: null }),
    ]);
    const raised = events.filter((e) => e.type === 'bid.raised');
    expect(feed.raises.map((r) => r.bidId)).toEqual(raised.map((e) => e.bidId).reverse());
    for (const r of feed.raises) {
      const e = raised.find((x) => x.bidId === r.bidId)!;
      expect(r).toMatchObject({
        oldCents: e.oldCents,
        newCents: e.newCents,
        shopperLabel: e.shopperLabel,
        isSimulated: e.isSimulated,
        round: 1,
      });
    }
    expect(feed.extensions).toHaveLength(1);
    expect(feed.extensions[0]!.extendedByMs).toBe(600_000);
    expect(extensionCopy(feed.extensions[0]!)).toBe('+10 min (late raise)');
    expect(feed.ended).toMatchObject({ round: 1, reason: 'NO_RAISES' });
  });

  it('is idempotent: a replay seen twice (reconnect) does not double count', () => {
    expect(fold(events, fold(events))).toEqual(fold(events));
  });

  it('feed rows: newest first, end on top, extension above the raise that caused it', () => {
    const rows = feedRows(fold(events));
    expect(rows.map((r) => r.kind)).toEqual(['ended', 'extended', 'raise', 'raise', 'raise']);
  });
});

describe('server activity', () => {
  it('merges with replay-only rows; the server wins on overlap', () => {
    const server = feedFromActivity(activity());
    const local = fold([
      {
        type: 'round.started',
        listingId: 'l1',
        at: START,
        round: 1,
        targetQuantity: 6,
        cutoffCents: 24_000,
        roundEndsAt: null,
        roundsEndAt: new Date(T + 6 * 3_600_000).toISOString(),
      },
      {
        type: 'bid.raised',
        listingId: 'l1',
        at: new Date(T + 5_000).toISOString(),
        bidId: 'b-new',
        replacesBidId: 'b-old',
        oldCents: 21_900,
        newCents: 24_100,
        shopperLabel: 'Shopper #7',
        source: 'SIM',
        isSimulated: true,
      },
      {
        type: 'round.ended',
        listingId: 'l1',
        at: new Date(T + 9_000).toISOString(),
        round: 1,
        reason: 'BRAND_STOPPED',
        roundsEndAt: new Date(T + 9_000).toISOString(),
        clearDeadlineAt: null,
      },
    ]);
    const merged = mergeFeeds(server, local);
    expect(merged.raises).toHaveLength(1);
    expect(merged.raises[0]!.shopperLabel).toBe('Shopper #1007');
    expect(merged.rounds[0]).toMatchObject({ nudged: 4, grossDeltaCents: 121_000 });
    expect(merged.ended).toMatchObject({ reason: 'BRAND_STOPPED' });
    expect(mergeFeeds(null, local)).toBe(local);
  });

  it('the extension note shows while recent, not after the end', () => {
    const at = new Date(T + 60_000).toISOString();
    const feed = feedFromActivity(
      activity({
        extensions: [{ round: 1, at, bidId: 'b-new', roundEndsAt: at, extendedByMs: 600_000 }],
      }),
    );
    expect(recentExtension(feed, T + 61_000)).not.toBeNull();
    expect(recentExtension(feed, T + 80_000)).toBeNull();
    expect(
      recentExtension({ ...feed, ended: { round: 1, reason: 'CAP_REACHED', at } }, T + 61_000),
    ).toBeNull();
  });
});
