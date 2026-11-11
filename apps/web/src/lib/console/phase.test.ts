import { describe, expect, it } from 'vitest';
import { LISTING_PHASES, type BookListing, type ListingPhaseName } from '@holdfast/shared';
import { formatCountdown, navPhaseLabel, phaseView } from './phase';

const NOW = Date.parse('2026-11-11T20:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const TZ = { timeZone: 'UTC' };

type Timing = Parameters<typeof phaseView>[0];
const base: Timing = {
  status: 'OPEN',
  windowClosesAt: iso(NOW + 41 * H + 12 * 60_000 + 9_000),
  roundsEndAt: null,
  roundEndsAt: null,
  clearDeadlineAt: iso(NOW + 60 * H),
  currentRound: null,
  oldestHoldAuthorizedAt: null,
};
const at = (patch: Partial<BookListing>): Timing => ({ ...base, ...patch }) as Timing;

describe('phaseView: the console header for every listingPhase value', () => {
  const cases: [ListingPhaseName, Timing, Partial<ReturnType<typeof phaseView>>][] = [
    ['DRAFT', at({ status: 'DRAFT', windowClosesAt: null }), { pill: 'Draft', locked: true }],
    [
      'BIDDING',
      base,
      { pill: 'Open', deadline: 'Closes in 41:12:09', locked: false, cancellable: true },
    ],
    [
      // D7: still OPEN after window_closes_at, no new bids; Clear by = oldest hold + 66 h here.
      'AWAITING_ROUNDS_OR_CLEAR',
      at({
        windowClosesAt: iso(NOW - 1000),
        oldestHoldAuthorizedAt: iso(NOW - 50 * H),
      }),
      {
        pill: 'Open',
        tone: 'dark',
        deadline: 'Bidding closed · start rounds or clear by Nov 12, 12:00 PM',
        deadlineAt: NOW + 16 * H,
        cancellable: true,
      },
    ],
    [
      'ROUNDS_ACTIVE',
      at({
        status: 'ROUNDS',
        windowClosesAt: iso(NOW - H),
        roundsEndAt: iso(NOW + 5 * 60_000),
        currentRound: 2,
      }),
      { pill: 'Rounds · round 2', deadline: 'Rounds end in 0:05:00', cancellable: true },
    ],
    [
      'ROUNDS_ENDED',
      at({ status: 'ROUNDS', windowClosesAt: iso(NOW - H), roundsEndAt: iso(NOW - 1) }),
      { pill: 'Rounds ended', deadline: 'Rounds ended · clear by Nov 14, 8:00 AM' },
    ],
    [
      'CLEARING',
      at({ status: 'CLEARING' }),
      { pill: 'Clearing', locked: true, cancellable: false },
    ],
    ['SETTLED', at({ status: 'SETTLED' }), { pill: 'Settled', locked: true }],
    ['PAID_OUT', at({ status: 'PAID_OUT' }), { pill: 'Paid out', locked: true }],
    ['PAYOUT_FAILED', at({ status: 'PAYOUT_FAILED' }), { pill: 'Payout failed', tone: 'danger' }],
    [
      'EXPIRED',
      at({ status: 'EXPIRED' }),
      { pill: 'Expired', deadline: 'Window expired · every hold released', locked: true },
    ],
    ['CANCELLED', at({ status: 'CANCELLED' }), { pill: 'Cancelled', locked: true }],
  ];

  it('covers every phase', () => {
    expect(cases.map((c) => c[0]).sort()).toEqual([...LISTING_PHASES].sort());
  });

  it.each(cases)('%s', (phase, listing, expected) => {
    const v = phaseView(listing, NOW, TZ);
    expect(v.phase).toBe(phase);
    expect(v).toMatchObject(expected);
  });

  it('flips from BIDDING to "Bidding closed" as time passes, with no refetch', () => {
    const closesAt = NOW + 2000;
    const listing = at({ windowClosesAt: iso(closesAt) });
    expect(phaseView(listing, NOW, TZ).phase).toBe('BIDDING');
    expect(phaseView(listing, closesAt, TZ).phase).toBe('AWAITING_ROUNDS_OR_CLEAR');
  });

  it('shows a date instead of a countdown beyond 72 h, and Clear by from clear_deadline_at', () => {
    const v = phaseView(at({ windowClosesAt: iso(NOW + 80 * H) }), NOW, TZ);
    expect(v.deadline).toBe('Closes Nov 15, 4:00 AM');
    const closed = phaseView(at({ windowClosesAt: iso(NOW - 1) }), NOW, TZ);
    expect(closed.deadlineAt).toBe(NOW + 60 * H);
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '0:00:00'],
    [-5000, '0:00:00'],
    [59_999, '0:00:59'],
    [41 * H + 12 * 60_000 + 9_000, '41:12:09'],
  ])('%i ms → %s', (ms, out) => expect(formatCountdown(ms)).toBe(out));
});

describe('navPhaseLabel', () => {
  it.each([
    [{ status: 'OPEN' as const, windowClosesAt: iso(NOW + H) }, 'BIDDING'],
    [{ status: 'OPEN' as const, windowClosesAt: iso(NOW - 1) }, 'AWAITING_ROUNDS_OR_CLEAR'],
    [{ status: 'ROUNDS' as const, windowClosesAt: iso(NOW - H) }, 'ROUNDS'],
    [{ status: 'DRAFT' as const, windowClosesAt: null }, 'DRAFT'],
    [{ status: 'PAID_OUT' as const, windowClosesAt: iso(NOW - H) }, 'PAID_OUT'],
  ])('%j → %s', (l, label) => expect(navPhaseLabel(l, NOW)).toBe(label));
});
