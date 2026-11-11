import { normalizeDomain } from '@holdfast/shared';
import type { ApiError } from './api';
import type { BrandRole } from './brand-gate';
import type { VerificationStatus } from './brand-onboarding';

/**
 * W11 brand settings view model (HF-056; screens.md §W11), kept pure so it can be tested. The
 * screen reads `GET /api/brands/me/settings` and writes through the `/api/brands/me/*` routes.
 */

export const SETTINGS_TABS = [
  { id: 'team', label: 'Team' },
  { id: 'payout', label: 'Payout account' },
  { id: 'verification', label: 'Verification' },
  { id: 'retailers', label: 'Authorized retailers' },
  { id: 'notifications', label: 'Notifications' },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

/** `?tab=` (the payout re-login comes back to `?tab=payout`); anything else → Team. */
export function tabFromSearch(search: string): SettingsTab {
  const t = new URLSearchParams(search).get('tab');
  return SETTINGS_TABS.some((x) => x.id === t) ? (t as SettingsTab) : 'team';
}

export interface TeamMemberView {
  id: string;
  email: string;
  displayName: string | null;
  role: BrandRole;
  createdAt: string;
}

export interface InviteView {
  id: string;
  role: BrandRole;
  email: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export const NOTIFICATION_TEMPLATES = [
  {
    id: 'brand_demand_milestone',
    label: 'Demand milestones',
    hint: 'Held demand crosses $10k, $25k or $50k.',
  },
  {
    id: 'brand_window_closing',
    label: 'Window closing',
    hint: '6 hours before a window closes, with the recommended clear.',
  },
  { id: 'brand_cleared', label: 'Cleared', hint: 'A window settled and the payout is on its way.' },
  { id: 'brand_payout_failed', label: 'Payout failed', hint: 'A payout failed; we retry it.' },
] as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATES)[number]['id'];
export type NotificationChannel = 'EMAIL' | 'PUSH';
export type NotificationPrefs = Record<NotificationTemplate, Record<NotificationChannel, boolean>>;

export interface BrandSettings {
  me: { id: string; email: string; role: BrandRole };
  brand: {
    id: string;
    name: string;
    domain: string | null;
    verificationStatus: VerificationStatus;
    verifiedAt: string | null;
    dnsTxtRecord: string;
    lastDnsCheckAt: string | null;
  };
  payout: { email: string; pendingEmail: string | null };
  authorizedDomains: string[];
  maxAuthorizedDomains: number;
  team: { members: TeamMemberView[]; invites: InviteView[] };
  notifications: NotificationPrefs;
}

/** `POST /api/brands/verification/check`. */
export interface DnsCheckAnswer {
  verificationStatus: VerificationStatus;
  verified: boolean;
  lookup: 'FOUND' | 'NOT_FOUND' | 'DNS_ERROR' | 'SKIPPED';
  domain: string | null;
  checkedAt: string;
  nextCheckAt: string | null;
  cached: boolean;
}

// --- Roles --------------------------------------------------------------------------------------

export const ROLE_COPY: Record<BrandRole, string> = {
  OWNER: 'Everything, including the team and the payout account.',
  MANAGER: 'Create listings, clear windows, edit authorized retailers.',
  VIEWER: 'Watch listings and the console. Can’t clear or change settings.',
};

export interface SettingsPermissions {
  manageTeam: boolean;
  changePayout: boolean;
  editRetailers: boolean;
}

export function permissionsFor(role: BrandRole): SettingsPermissions {
  return {
    manageTeam: role === 'OWNER',
    changePayout: role === 'OWNER',
    editRetailers: role === 'OWNER' || role === 'MANAGER',
  };
}

/** The OWNER count guard mirrored client side: the last OWNER's role and Remove are locked. */
export function isLastOwner(members: readonly TeamMemberView[], userId: string): boolean {
  const owners = members.filter((m) => m.role === 'OWNER');
  return owners.length === 1 && owners[0]!.id === userId;
}

// --- Invite links -------------------------------------------------------------------------------

/** The token from a join link's fragment (`/brand/join#hfi_…`); null when there is none. */
export function inviteTokenFromHash(hash: string): string | null {
  const t = hash.replace(/^#/, '').trim();
  return /^hfi_[A-Za-z0-9_-]{32}$/.test(t) ? t : null;
}

/** Kept across the PayPal sign-in round trip (the fragment doesn't survive the redirects). */
export const INVITE_STORAGE_KEY = 'holdfast:invite';

export function joinError(err: ApiError): string {
  switch (err.details.reason) {
    case 'INVITE_USED':
      return 'This invite link was already used. Ask your teammate for a new one.';
    case 'INVITE_REVOKED':
      return 'This invite link was cancelled. Ask your teammate for a new one.';
    case 'INVITE_EXPIRED':
      return 'This invite link has expired (links last 7 days). Ask for a new one.';
    case 'EMAIL_MISMATCH':
      return 'This invite is for a different email. Sign in with the PayPal account it was sent to.';
    case 'OTHER_BRAND':
      return 'Your account already belongs to another brand on Holdfast.';
  }
  if (err.code === 'NOT_FOUND') return 'This invite link is not valid. Check you copied all of it.';
  if (err.code === 'UNAUTHENTICATED') return 'Sign in with PayPal to join.';
  return err.message;
}

// --- Authorized retailers -----------------------------------------------------------------------

export type DomainsParse =
  { ok: true; domains: string[] } | { ok: false; message: string; invalid: string[] };

/** One domain per line (commas and spaces work too); normalised and deduped, ≤ `max`. */
export function parseDomainsInput(text: string, max: number): DomainsParse {
  const parts = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const d = normalizeDomain(p);
    if (!d) invalid.push(p);
    else if (!domains.includes(d)) domains.push(d);
  }
  if (invalid.length) {
    return {
      ok: false,
      invalid,
      message: `Not a retailer domain: ${invalid.join(', ')}. Use domains like bestbuy.com.`,
    };
  }
  if (domains.length > max) {
    return {
      ok: false,
      invalid: [],
      message: `Up to ${max} retailers (you have ${domains.length}).`,
    };
  }
  return { ok: true, domains };
}

export function domainsText(domains: readonly string[]): string {
  return domains.join('\n');
}

// --- Payout re-login ----------------------------------------------------------------------------

/** Where "Change payout account" sends the OWNER: Log in with PayPal as the new account. */
export const PAYOUT_RELOGIN_URL =
  '/api/auth/paypal/start?purpose=payout&next=%2Fbrand%2Fsettings%3Ftab%3Dpayout';

/** `?reauth=` after the payout re-login (apps/api auth routes). */
export function reauthNotice(search: string): { tone: 'info' | 'error'; message: string } | null {
  switch (new URLSearchParams(search).get('reauth')) {
    case 'ok':
      return {
        tone: 'info',
        message: 'PayPal sign-in confirmed. Review and save the new account.',
      };
    case 'cancelled':
      return {
        tone: 'error',
        message: 'PayPal sign-in was cancelled; the payout account is unchanged.',
      };
    case 'unverified':
      return {
        tone: 'error',
        message:
          'That PayPal account has no confirmed email. Confirm it with PayPal and try again.',
      };
    case 'forbidden':
      return { tone: 'error', message: 'Only a brand owner can change the payout account.' };
    case 'failed':
      return { tone: 'error', message: 'PayPal sign-in failed. Try again.' };
    default:
      return null;
  }
}

// --- Verification -------------------------------------------------------------------------------

/** Copy for a DNS check answer while PENDING. */
export function dnsCheckMessage(a: DnsCheckAnswer): string {
  if (a.verified) return 'Verified: we found your TXT record.';
  if (a.lookup === 'DNS_ERROR') {
    return 'We couldn’t reach your DNS just now. We’ll try again; this can take up to an hour.';
  }
  return 'Record not found yet. DNS changes can take up to an hour; we re-check every 30 seconds.';
}
