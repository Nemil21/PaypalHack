import { describe, expect, it } from 'vitest';
import { notificationPush, pushUrl } from '@holdfast/shared';
import { closingAlert, consoleLayout, m10State, timeLeftShort } from './m10';
import { paths } from '../routes';

const H = 3_600_000;

describe('M10 brand mobile alert (HF-061)', () => {
  it('phones get M10; ?view= forces either layout', () => {
    expect(consoleLayout('', true)).toBe('mobile');
    expect(consoleLayout('', false)).toBe('desktop');
    expect(consoleLayout('?view=mobile', false)).toBe('mobile');
    expect(consoleLayout('?view=desktop', true)).toBe('desktop');
    expect(consoleLayout('?view=bogus', true)).toBe('mobile');
  });

  it('states: open, rounds, clearing progress, done, closed', () => {
    expect(m10State('BIDDING')).toBe('open');
    expect(m10State('AWAITING_ROUNDS_OR_CLEAR')).toBe('open');
    expect(m10State('ROUNDS_ACTIVE')).toBe('rounds');
    expect(m10State('ROUNDS_ENDED')).toBe('rounds');
    expect(m10State('CLEARING')).toBe('clearing');
    expect(m10State('SETTLED')).toBe('done');
    expect(m10State('PAID_OUT')).toBe('done');
    expect(m10State('PAYOUT_FAILED')).toBe('done');
    expect(m10State('EXPIRED')).toBe('closed');
    expect(m10State('CANCELLED')).toBe('closed');
    // A 202 from this phone shows progress before the book reads CLEARING.
    expect(m10State('BIDDING', true)).toBe('clearing');
    expect(m10State('ROUNDS_ACTIVE', true)).toBe('clearing');
    expect(m10State('CANCELLED', true)).toBe('closed');
  });

  it('the alert line matches the push title: "Window closes in 6 h · $61k held"', () => {
    const now = Date.UTC(2026, 10, 12, 12);
    expect(closingAlert('BIDDING', now + 6 * H, now, 6_100_000)).toBe(
      'Window closes in 6 h · $61k held',
    );
    expect(closingAlert('BIDDING', now + 42 * 60_000, now, 54_200)).toBe(
      'Window closes in 42 min · $542 held',
    );
    expect(closingAlert('BIDDING', now - 1, now, 6_100_000)).toBeNull();
    expect(closingAlert('ROUNDS_ACTIVE', now + H, now, 6_100_000)).toBeNull();
    expect(closingAlert('BIDDING', null, now, 6_100_000)).toBeNull();

    const push = notificationPush(
      'brand_window_closing',
      {
        listingId: 'l1',
        hoursLeft: 6,
        quantity: 240,
        lowestWinningCents: 21_900,
        heldBids: 312,
        heldCents: 6_100_000,
      },
      'brand_window_closing:l1',
    );
    expect(push.title).toBe(closingAlert('BIDDING', now + 6 * H, now, 6_100_000));
  });

  it('the brand_window_closing push opens this route (M10 on a phone)', () => {
    const url = pushUrl('brand_window_closing', {
      listingId: 'lst 1',
      hoursLeft: 6,
      quantity: 240,
      lowestWinningCents: null,
      heldBids: 0,
    });
    expect(url).toBe(paths.listingConsole('lst 1'));
  });

  it('time left rounds like the push (whole hours, minutes under an hour)', () => {
    expect(timeLeftShort(5.6 * H)).toBe('6 h');
    expect(timeLeftShort(H)).toBe('1 h');
    expect(timeLeftShort(59 * 60_000 + 1)).toBe('60 min');
    expect(timeLeftShort(1)).toBe('1 min');
  });
});
