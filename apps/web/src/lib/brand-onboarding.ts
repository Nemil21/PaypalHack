import { normalizeDomain } from '@holdfast/shared';
import type { BadgeTone } from '../components/ui';
import type { ApiError } from './api';

/**
 * W03 brand verification onboarding helpers (HF-011b; features/01 §Logic 3–5, screens.md §W03),
 * kept pure so they can be tested. The screen talks to `GET/POST /api/brands/verification`.
 */

export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

/** `GET /api/brands/verification` and the `POST` answer (plus `created`). */
export interface OnboardingBrand {
  brandId: string;
  name: string;
  domain: string | null;
  payoutEmail: string;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  dnsTxtRecord: string;
}

export interface OnboardingLoad {
  /** The PayPal login email: the payout email is locked to it. */
  loginEmail: string;
  role: 'OWNER' | 'MANAGER' | 'VIEWER' | null;
  /** `ADMIN_EMAILS` member: sees "Verify now" (HF-011a's admin endpoint). */
  isAdmin: boolean;
  brand: OnboardingBrand | null;
}

export const ONBOARDING_STEPS = ['Company', 'Domain', 'Payout'] as const;
export type OnboardingStep = 0 | 1 | 2;

export interface CompanyValues {
  name: string;
  domain: string;
}

export type CompanyErrors = Partial<Record<keyof CompanyValues, string>>;

export function companyValues(brand: OnboardingBrand | null): CompanyValues {
  return { name: brand?.name ?? '', domain: brand?.domain ?? '' };
}

export function validateCompany(v: CompanyValues): CompanyErrors {
  const e: CompanyErrors = {};
  if (!v.name.trim()) e.name = 'Enter your company or brand name.';
  else if (v.name.trim().length > 120) e.name = 'Keep the name under 120 characters.';
  if (!v.domain.trim()) e.domain = 'Enter your website domain.';
  else if (!normalizeDomain(v.domain)) e.domain = 'Enter a domain like aurelaudio.example.';
  return e;
}

/** The `POST /api/brands/verification` body: domain normalised, payout = login email. */
export function verificationRequest(v: CompanyValues, loginEmail: string) {
  return {
    name: v.name.trim(),
    domain: normalizeDomain(v.domain) ?? v.domain.trim(),
    payoutEmail: loginEmail,
  };
}

/**
 * Whether step 1's values differ from what is saved. Unchanged back/next skips the POST; the
 * server is an upsert anyway, so a re-POST would land on the same brand.
 */
export function companyChanged(v: CompanyValues, brand: OnboardingBrand | null): boolean {
  if (!brand) return true;
  return v.name.trim() !== brand.name || normalizeDomain(v.domain) !== brand.domain;
}

/** Where W03 opens: step 1 with no brand yet, else the domain step (status lives there). */
export function initialStep(brand: OnboardingBrand | null): OnboardingStep {
  return brand ? 1 : 0;
}

export function statusPill(status: VerificationStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'VERIFIED':
      return { label: 'Verified', tone: 'success' };
    case 'REJECTED':
      return { label: 'Failed', tone: 'danger' };
    default:
      return { label: 'Pending', tone: 'held' };
  }
}

/** Error copy for a failed save; `field` puts it under that input. */
export function onboardingError(err: ApiError): { field?: keyof CompanyValues; message: string } {
  if (err.code === 'DUPLICATE') {
    return err.details.field === 'domain'
      ? {
          field: 'domain',
          message:
            'Another brand already claimed this domain. If it’s yours, contact support@holdfast.example.',
        }
      : { message: 'This PayPal account already belongs to another brand.' };
  }
  if (err.code === 'VALIDATION_ERROR' && err.details.field === 'domain') {
    return { field: 'domain', message: 'Enter a domain like aurelaudio.example.' };
  }
  if (err.code === 'VALIDATION_ERROR' && err.details.field === 'name') {
    return { field: 'name', message: 'Enter your company or brand name.' };
  }
  if (err.code === 'UNAUTHENTICATED') {
    return { message: 'Your sign-in expired. Continue with PayPal again.' };
  }
  return { message: err.message };
}

/** Re-check cadence while PENDING (features/01 §Edge cases: "allow re-check every 30 s"). */
export const RECHECK_MS = 30_000;

/**
 * W03 failed-verification card (UI-GAPS W03): what was rejected and what to do next, from the
 * brand row. A rejection is an admin decision (the DNS check refuses REJECTED brands), so the card
 * names the brand and domain checked instead of a generic line.
 */
export function rejectedCopy(brand: Pick<OnboardingBrand, 'name' | 'domain'>): {
  title: string;
  body: string;
  steps: string[];
} {
  const where = brand.domain ? ` on ${brand.domain}` : '';
  return {
    title: `We couldn’t verify ${brand.name}${where}.`,
    body: 'A Holdfast admin reviewed this brand and declined it, so publishing stays off. Your drafts are kept.',
    steps: [
      brand.domain
        ? `Check that ${brand.domain} is your brand’s own site and the TXT record is still published.`
        : 'Add the website domain your brand sells from.',
      'Email support@holdfast.example from your PayPal business email and we’ll review it again.',
    ],
  };
}
