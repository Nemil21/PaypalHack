import { describe, expect, it } from 'vitest';
import {
  BUYER_NOTIFICATION_EVENTS,
  buyerSettingsState,
  paypalRow,
  profileView,
  READ_ONLY_NOTE,
} from './buyer-settings.js';

const maya = { id: 's1', email: 'maya@example.com', displayName: 'Maya R.', provisional: false };

describe('buyerSettingsState', () => {
  it('signed out, anonymous guest or signed in', () => {
    expect(buyerSettingsState(null)).toBe('signed-out');
    expect(buyerSettingsState({ brandUser: null, shopper: null })).toBe('signed-out');
    expect(
      buyerSettingsState({
        brandUser: null,
        shopper: { id: 's2', email: null, provisional: true },
      }),
    ).toBe('guest');
    expect(buyerSettingsState({ brandUser: null, shopper: maya })).toBe('signed-in');
  });
});

describe('paypalRow', () => {
  it('shows Connected only once a PayPal method is saved', () => {
    expect(paypalRow(true).badge).toEqual({ label: 'Connected', tone: 'success' });
    expect(paypalRow(false).badge).toEqual({ label: 'Not saved', tone: 'neutral' });
    expect(paypalRow(null).badge).toBeNull();
  });
});

describe('profileView', () => {
  it('reads the name and email from /api/me', () => {
    expect(profileView({ brandUser: null, shopper: maya })).toEqual({
      name: 'Maya R.',
      email: 'maya@example.com',
    });
  });
});

describe('copy', () => {
  it('says name and address are read-only (decision 5) and keeps D14 wording', () => {
    expect(READ_ONLY_NOTE).toMatch(/come from your PayPal account and can't be edited here yet/);
    const all = [READ_ONLY_NOTE, ...BUYER_NOTIFICATION_EVENTS, paypalRow(true).detail].join(' ');
    expect(all).not.toMatch(/clearing price|fair price|single price/i);
  });
});
