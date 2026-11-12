import { describe, expect, it } from 'vitest';
import type { BrandMe } from './brand-gate.js';
import { paths } from './routes.js';
import { buyerName, isLinkActive, shellNav, viewerFor, type MeResponse } from './viewer.js';

const brandUser: BrandMe = {
  id: 'u1',
  email: 'priya@aurel.example',
  displayName: 'Priya',
  role: 'OWNER',
  brand: { id: 'b1', name: 'Aurel Audio', verificationStatus: 'VERIFIED' },
};
const maya = { id: 's1', email: 'maya@example.com', displayName: 'Maya R.', provisional: false };
const anon = { id: 's2', email: null, displayName: null, provisional: true };
const me = (over: Partial<MeResponse>): MeResponse => ({ brandUser: null, shopper: null, ...over });

describe('viewerFor', () => {
  it('signed out (or /api/me failed) shows the public nav', () => {
    expect(viewerFor(null, '/bids').role).toBe('public');
    expect(viewerFor(me({}), '/brand').role).toBe('public');
  });

  it('a brand session draws the brand nav with the brand name and admin flag', () => {
    expect(viewerFor(me({ brandUser: { ...brandUser, isAdmin: true } }), '/brand')).toEqual({
      role: 'brand',
      name: 'Aurel Audio',
      isAdmin: true,
    });
    expect(viewerFor(me({ brandUser }), '/developer').role).toBe('brand');
  });

  it('a shopper session draws the buyer nav', () => {
    expect(viewerFor(me({ shopper: maya }), '/bids')).toEqual({
      role: 'buyer',
      name: 'Maya R.',
      isAdmin: false,
    });
    expect(viewerFor(me({ shopper: maya }), '/developer').role).toBe('buyer');
  });

  it('with both sessions, the page area decides', () => {
    const both = me({ brandUser, shopper: maya });
    expect(viewerFor(both, '/brand/payouts').role).toBe('brand');
    expect(viewerFor(both, '/admin').role).toBe('brand');
    expect(viewerFor(both, '/bids/abc').role).toBe('buyer');
    expect(viewerFor(both, '/o/aurel-a7').role).toBe('buyer');
    expect(viewerFor(both, '/settings').role).toBe('buyer');
    expect(viewerFor(both, '/developer').role).toBe('brand');
  });

  it('brand pages never show a buyer nav, and an anonymous shopper only counts on buyer pages', () => {
    expect(viewerFor(me({ shopper: maya }), '/brand/sign-in').role).toBe('public');
    expect(viewerFor(me({ shopper: anon }), '/demo').role).toBe('public');
    expect(viewerFor(me({ shopper: anon }), '/o/aurel-a7')).toMatchObject({
      role: 'buyer',
      name: 'Guest',
    });
    // `/brandx` is not the brand area; `/settings` is not `/brand/settings`.
    expect(viewerFor(me({ shopper: maya }), '/brandx').role).toBe('buyer');
  });
});

describe('buyerName', () => {
  it('prefers the PayPal display name, then the email local part', () => {
    expect(buyerName(maya)).toBe('Maya R.');
    expect(buyerName({ ...maya, displayName: '  ' })).toBe('maya');
    expect(buyerName(anon)).toBe('Guest');
  });
});

describe('shellNav', () => {
  it('brand: My listings and Developer; Settings [S] outline, Payouts [P] dark; lands on /brand', () => {
    const n = shellNav('brand');
    expect(n.home).toBe(paths.brand);
    expect(n.links.map((l) => l.label)).toEqual(['My listings', 'Developer']);
    expect(n.actions.map((a) => [a.label, a.variant, a.shortcut])).toEqual([
      ['Settings', 'outline', 'S'],
      ['Payouts', 'secondary', 'P'],
    ]);
  });

  it('buyer: My bids and Developer; Place a bid [P] orange, Settings [S]; lands on /bids', () => {
    const n = shellNav('buyer');
    expect(n.home).toBe(paths.bids);
    expect(n.links.map((l) => l.label)).toEqual(['My bids', 'Developer']);
    expect(n.actions.map((a) => [a.label, a.variant, a.shortcut, a.to])).toEqual([
      ['Place a bid', 'primary', 'P', paths.offer('aurel-a7')],
      ['Settings', 'outline', 'S', paths.settings],
    ]);
  });

  it('public: just the logo back to the site', () => {
    expect(shellNav('public')).toEqual({ home: paths.home, links: [], actions: [] });
  });
});

describe('isLinkActive', () => {
  it('underlines My listings on the list and the console, not on Payouts or Overview', () => {
    const prefix = shellNav('brand').links[0]!.activePrefix;
    expect(isLinkActive('/brand/listings/abc', prefix)).toBe(true);
    expect(isLinkActive('/brand/payouts', prefix)).toBe(false);
    expect(isLinkActive('/brand', prefix)).toBe(false);
    expect(isLinkActive('/bids/x/won', paths.bids)).toBe(true);
    expect(isLinkActive('/bidsx', paths.bids)).toBe(false);
  });
});
