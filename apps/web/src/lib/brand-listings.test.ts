import { describe, expect, it } from 'vitest';
import type { OverviewListingCard } from '@holdfast/shared';
import { filterCounts, LISTING_FILTERS, listingRow, matchesFilter } from './brand-listings';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const H = 3_600_000;

function card(over: Partial<OverviewListingCard> = {}): OverviewListingCard {
  return {
    listingId: 'l1',
    slug: 'aurel-a7',
    status: 'OPEN',
    phase: 'BIDDING',
    title: 'Aurel A7 Wireless — Midnight',
    imageUrl: null,
    quantity: 240,
    windowClosesAt: new Date(NOW + 5 * H).toISOString(),
    roundsEndAt: null,
    roundEndsAt: null,
    currentRound: null,
    clearDeadlineAt: new Date(NOW + 11 * H).toISOString(),
    oldestHoldAuthorizedAt: null,
    createdAt: new Date(NOW - 10 * H).toISOString(),
    liveBids: 312,
    heldCents: 6_120_000,
    capturedCents: 0,
    sparkline: { startAt: null, points: [] },
    ...over,
  };
}

describe('My listings filters', () => {
  it('counts every tab from the statuses', () => {
    const cards = [
      card(),
      card({ status: 'OPEN' }),
      card({ status: 'ROUNDS' }),
      card({ status: 'PAID_OUT' }),
      card({ status: 'PAYOUT_FAILED' }),
      card({ status: 'DRAFT' }),
      card({ status: 'EXPIRED' }),
      card({ status: 'CANCELLED' }),
    ];
    expect(filterCounts(cards)).toEqual({
      all: 8,
      live: 2,
      rounds: 1,
      cleared: 2,
      draft: 1,
      closed: 2,
    });
  });

  it('"all" matches everything; each status lands in exactly one other tab', () => {
    for (const s of ['DRAFT', 'OPEN', 'ROUNDS', 'CLEARING', 'SETTLED', 'CANCELLED'] as const) {
      expect(matchesFilter(s, 'all')).toBe(true);
      const tabs = LISTING_FILTERS.filter((f) => f.key !== 'all' && matchesFilter(s, f.key));
      expect(tabs).toHaveLength(1);
    }
  });
});

describe('My listings rows', () => {
  it('a live row shows held money, bids, units, floor and the countdown', () => {
    const r = listingRow(card(), { floorCents: 19_900 }, NOW, 'UTC');
    expect(r).toMatchObject({
      href: '/brand/listings/l1',
      initials: 'A7',
      draft: false,
      money: '$61.2k',
      bids: '312',
      units: 240,
      floor: '$199',
    });
    expect(r.time).toMatch(/^Closes in 5:00:00$/);
  });

  it('a draft has no money or time and is flagged for Publish · Edit', () => {
    const r = listingRow(card({ status: 'DRAFT', phase: 'DRAFT' }), undefined, NOW);
    expect(r).toMatchObject({ draft: true, money: '—', bids: '—', floor: '—', time: '' });
  });

  it('after Clear the money is what was captured', () => {
    const r = listingRow(
      card({ status: 'SETTLED', phase: 'SETTLED', capturedCents: 3_260_000 }),
      { floorCents: 100 },
      NOW,
    );
    expect(r.money).toBe('$32.6k');
    expect(r.bids).toBe('—');
  });

  it('a closed window says when', () => {
    const r = listingRow(
      card({ status: 'EXPIRED', phase: 'EXPIRED', windowClosesAt: '2026-11-03T15:00:00Z' }),
      undefined,
      NOW,
      'UTC',
    );
    expect(r.time).toBe('Expired Nov 3, 3:00 PM');
  });
});
