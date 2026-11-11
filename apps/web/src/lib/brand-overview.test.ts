import { describe, expect, it } from 'vitest';
import type { OverviewActivity, OverviewListingCard } from '@holdfast/shared';
import {
  activityText,
  BRAND_NAV,
  canCreateListing,
  cardView,
  overviewState,
  sparklinePoints,
  streamedListingIds,
  verificationBanner,
  OVERVIEW_MAX_STREAMS,
} from './brand-overview';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const H = 3_600_000;

function card(over: Partial<OverviewListingCard> = {}): OverviewListingCard {
  return {
    listingId: 'l1',
    slug: 'aurel-a7',
    status: 'OPEN',
    phase: 'BIDDING',
    title: 'Aurel A7',
    imageUrl: null,
    quantity: 300,
    windowClosesAt: new Date(NOW + 5 * H).toISOString(),
    roundsEndAt: null,
    roundEndsAt: null,
    currentRound: null,
    clearDeadlineAt: new Date(NOW + 11 * H).toISOString(),
    oldestHoldAuthorizedAt: null,
    createdAt: new Date(NOW - 10 * H).toISOString(),
    liveBids: 2,
    heldCents: 6_120_000,
    capturedCents: 0,
    sparkline: { startAt: null, points: [0, 100, 300] },
    ...over,
  };
}

describe('W04 states and gating', () => {
  it('empty with no listings, live otherwise', () => {
    expect(overviewState({ listings: [] })).toBe('empty');
    expect(overviewState({ listings: [card()] })).toBe('live');
  });

  it('an unverified brand gets the banner, which says drafts are still allowed', () => {
    const b = verificationBanner('PENDING');
    expect(b?.tone).toBe('pending');
    expect(b?.body).toMatch(/drafts/i);
    expect(verificationBanner('REJECTED')?.tone).toBe('rejected');
    expect(verificationBanner('VERIFIED')).toBeNull();
  });

  it('"New listing" follows the role, never verification', () => {
    expect(canCreateListing('OWNER')).toBe(true);
    expect(canCreateListing('MANAGER')).toBe(true);
    expect(canCreateListing('VIEWER')).toBe(false);
  });

  it('left nav has the five W04 entries', () => {
    expect(BRAND_NAV.map((n) => n.label)).toEqual([
      'Overview',
      'Listings',
      'Payouts',
      'Embed',
      'Settings',
    ]);
  });
});

describe('cardView', () => {
  it('opens W06 and shows the live phase, countdown, held $ and bids', () => {
    const v = cardView(card(), NOW, 'UTC');
    expect(v.href).toBe('/brand/listings/l1');
    expect(v).toMatchObject({ pill: 'Open', held: '$61.2k', heldLabel: 'held', bids: '2 bids' });
    expect(v.timeLeft).toBe('Closes in 5:00:00');
  });

  it('flips to bidding closed once the window passes (no refetch)', () => {
    const v = cardView(card(), NOW + 6 * H, 'UTC');
    expect(v.timeLeft).toMatch(/^Bidding closed/);
  });

  it('after Clear shows captured money instead of held', () => {
    const v = cardView(
      card({ status: 'SETTLED', phase: 'SETTLED', heldCents: 0, capturedCents: 45_000 }),
      NOW,
    );
    expect(v).toMatchObject({ pill: 'Settled', held: '$450', heldLabel: 'captured', bids: '' });
  });

  it('a draft reads as a draft with an untitled fallback', () => {
    const v = cardView(card({ status: 'DRAFT', windowClosesAt: null, title: null }), NOW);
    expect(v).toMatchObject({ pill: 'Draft', title: 'Untitled listing', bids: '' });
  });
});

describe('streams and feed', () => {
  it('streams only listings that can still change, ROUNDS first, capped', () => {
    const many = [
      card({ listingId: 'd', status: 'DRAFT' }),
      card({ listingId: 'p', status: 'PAID_OUT' }),
      card({ listingId: 's', status: 'SETTLED' }),
      card({ listingId: 'o1' }),
      card({ listingId: 'r', status: 'ROUNDS' }),
      card({ listingId: 'o2' }),
      card({ listingId: 'o3' }),
    ];
    const ids = streamedListingIds({ listings: many });
    expect(ids).toHaveLength(OVERVIEW_MAX_STREAMS);
    expect(ids[0]).toBe('r');
    expect(ids).not.toContain('d');
    expect(ids).not.toContain('p');
  });

  const act = (over: Partial<OverviewActivity>): OverviewActivity => ({
    id: '1',
    at: new Date(NOW).toISOString(),
    kind: 'BID',
    action: 'BID_HELD',
    listingId: 'l1',
    listingTitle: 'Aurel A7',
    amountCents: 22_900,
    ...over,
  });

  it('activity copy, with agent bids called out', () => {
    expect(activityText(act({}))).toEqual({ text: 'New held bid', amount: '$229' });
    expect(activityText(act({ kind: 'AGENT' })).text).toBe('Agent placed a held bid');
    expect(
      activityText(act({ kind: 'PAYOUT', action: 'PAYOUT_FAILED', amountCents: null })),
    ).toEqual({ text: 'Payout failed', amount: null });
  });

  it('sparkline points fit the box, rising left to right', () => {
    expect(sparklinePoints([], 100, 20)).toBe('');
    expect(sparklinePoints([5], 100, 20)).toBe('0,20 100,20');
    expect(sparklinePoints([0, 50, 100], 100, 20)).toBe('0.0,20.0 50.0,10.0 100.0,0.0');
  });
});
