import { describe, expect, it } from 'vitest';
import { paths } from './routes';
import {
  allSignInCopy,
  BRAND_SIGN_IN,
  BUYER_SIGN_IN,
  inviteHeading,
  ROLE_CARDS,
  withNext,
} from './sign-in';

describe('v4 sign-in (plan §0)', () => {
  it('sends each role to its own sign-in page', () => {
    expect(ROLE_CARDS.map((c) => [c.role, c.to])).toEqual([
      ['brand', paths.brandSignIn],
      ['buyer', paths.buyerSignIn],
    ]);
    expect(paths.signIn).toBe('/sign-in');
  });

  it('never implies every winner pays the same (D14)', () => {
    const copy = allSignInCopy().join('\n');
    expect(copy).not.toMatch(/clearing price|fair price|single price|same price/i);
  });

  it('offers PayPal to brands and email to buyers, never the other way round', () => {
    expect(JSON.stringify(BRAND_SIGN_IN)).not.toMatch(/email me/i);
    expect(BUYER_SIGN_IN.send).toBe('Email me a sign-in link');
    expect(JSON.stringify(BUYER_SIGN_IN)).not.toMatch(/continue with paypal/i);
  });

  it('carries `next` through the chooser', () => {
    expect(withNext(paths.brandSignIn, undefined)).toBe('/brand/sign-in');
    expect(withNext(paths.buyerSignIn, '/bids/a b')).toBe('/sign-in/buyer?next=%2Fbids%2Fa%20b');
  });

  it('names the inviting brand', () => {
    expect(inviteHeading('Aurel Audio')).toEqual({
      lead: 'You’re invited to ',
      accent: 'Aurel Audio.',
    });
  });
});
