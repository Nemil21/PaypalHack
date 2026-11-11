import { describe, expect, it } from 'vitest';
import { paypalStartUrl, safeNext, signInErrorMessage } from './brand-sign-in';

describe('W02 sign-in helpers (HF-010)', () => {
  it('maps callback errors to the W02 error state', () => {
    expect(signInErrorMessage(null)).toBeNull();
    expect(signInErrorMessage('cancelled')).toBe('PayPal sign-in was cancelled.');
    expect(signInErrorMessage('state')).toMatch(/try again/);
    expect(signInErrorMessage('something-new')).toBe(signInErrorMessage('failed'));
  });

  it('keeps `next` same-origin only', () => {
    expect(safeNext('/brand/listings/1')).toBe('/brand/listings/1');
    expect(safeNext('//evil.example')).toBeUndefined();
    expect(safeNext('/\\evil.example')).toBeUndefined();
    expect(safeNext('https://evil.example')).toBeUndefined();
    expect(safeNext(null)).toBeUndefined();
  });

  it('builds the start URL', () => {
    expect(paypalStartUrl()).toBe('/api/auth/paypal/start');
    expect(paypalStartUrl('/brand/listings/a b')).toBe(
      '/api/auth/paypal/start?next=%2Fbrand%2Flistings%2Fa%20b',
    );
  });
});
