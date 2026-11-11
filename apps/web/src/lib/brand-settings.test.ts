import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  dnsCheckMessage,
  inviteTokenFromHash,
  isLastOwner,
  joinError,
  parseDomainsInput,
  PAYOUT_RELOGIN_URL,
  permissionsFor,
  reauthNotice,
  tabFromSearch,
  type DnsCheckAnswer,
  type TeamMemberView,
} from './brand-settings';

describe('W11 brand settings helpers (HF-056)', () => {
  it('tabFromSearch: known tabs, else Team', () => {
    expect(tabFromSearch('?tab=payout&reauth=ok')).toBe('payout');
    expect(tabFromSearch('?tab=retailers')).toBe('retailers');
    expect(tabFromSearch('?tab=api')).toBe('team');
    expect(tabFromSearch('')).toBe('team');
  });

  it('permissions: OWNER everything, MANAGER retailers only, VIEWER nothing', () => {
    expect(permissionsFor('OWNER')).toEqual({
      manageTeam: true,
      changePayout: true,
      editRetailers: true,
    });
    expect(permissionsFor('MANAGER')).toEqual({
      manageTeam: false,
      changePayout: false,
      editRetailers: true,
    });
    expect(permissionsFor('VIEWER')).toEqual({
      manageTeam: false,
      changePayout: false,
      editRetailers: false,
    });
  });

  it('isLastOwner', () => {
    const m = (id: string, role: TeamMemberView['role']): TeamMemberView => ({
      id,
      role,
      email: `${id}@x.example`,
      displayName: null,
      createdAt: '',
    });
    expect(isLastOwner([m('a', 'OWNER'), m('b', 'VIEWER')], 'a')).toBe(true);
    expect(isLastOwner([m('a', 'OWNER'), m('b', 'OWNER')], 'a')).toBe(false);
    expect(isLastOwner([m('a', 'OWNER'), m('b', 'VIEWER')], 'b')).toBe(false);
  });

  it('inviteTokenFromHash', () => {
    const t = `hfi_${'a'.repeat(32)}`;
    expect(inviteTokenFromHash(`#${t}`)).toBe(t);
    expect(inviteTokenFromHash('#nope')).toBeNull();
    expect(inviteTokenFromHash('')).toBeNull();
  });

  it('parseDomainsInput: lines, commas, URLs; dedupes; invalid and > max refused', () => {
    expect(parseDomainsInput('jbl.com\nhttps://www.BestBuy.com/x, jbl.com\n\n', 25)).toEqual({
      ok: true,
      domains: ['jbl.com', 'bestbuy.com'],
    });
    expect(parseDomainsInput('', 25)).toEqual({ ok: true, domains: [] });
    const bad = parseDomainsInput('jbl.com localhost', 25);
    expect(bad).toMatchObject({ ok: false, invalid: ['localhost'] });
    const many = Array.from({ length: 26 }, (_, i) => `s${i}.example`).join('\n');
    expect(parseDomainsInput(many, 25)).toMatchObject({
      ok: false,
      message: 'Up to 25 retailers (you have 26).',
    });
  });

  it('joinError maps API reasons to copy', () => {
    const e = (code: string, reason?: string) =>
      new ApiError(409, code, 'x', reason ? { reason } : {});
    expect(joinError(e('STATE_CONFLICT', 'INVITE_USED'))).toMatch(/already used/);
    expect(joinError(e('STATE_CONFLICT', 'INVITE_EXPIRED'))).toMatch(/expired/);
    expect(joinError(e('DUPLICATE', 'OTHER_BRAND'))).toMatch(/another brand/);
    expect(joinError(e('NOT_FOUND'))).toMatch(/not valid/);
  });

  it('payout re-login: start URL comes back to the payout tab; notices per outcome', () => {
    const u = new URL(PAYOUT_RELOGIN_URL, 'http://x');
    expect(u.pathname).toBe('/api/auth/paypal/start');
    expect(u.searchParams.get('purpose')).toBe('payout');
    expect(u.searchParams.get('next')).toBe('/brand/settings?tab=payout');
    expect(reauthNotice('?reauth=ok')?.tone).toBe('info');
    expect(reauthNotice('?reauth=forbidden')?.tone).toBe('error');
    expect(reauthNotice('?tab=payout')).toBeNull();
  });

  it('dnsCheckMessage', () => {
    const a = (over: Partial<DnsCheckAnswer>): DnsCheckAnswer => ({
      verificationStatus: 'PENDING',
      verified: false,
      lookup: 'NOT_FOUND',
      domain: 'a.example',
      checkedAt: '',
      nextCheckAt: null,
      cached: false,
      ...over,
    });
    expect(dnsCheckMessage(a({}))).toMatch(/up to an hour/);
    expect(dnsCheckMessage(a({ lookup: 'DNS_ERROR' }))).toMatch(/couldn’t reach/);
    expect(dnsCheckMessage(a({ verified: true, verificationStatus: 'VERIFIED' }))).toMatch(
      /Verified/,
    );
  });
});
