import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  rejectedCopy,
  companyChanged,
  companyValues,
  initialStep,
  onboardingError,
  statusPill,
  validateCompany,
  verificationRequest,
  type OnboardingBrand,
} from './brand-onboarding';

const brand: OnboardingBrand = {
  brandId: 'b1',
  name: 'Aurel Audio',
  domain: 'aurelaudio.example',
  payoutEmail: 'sb-brand@business.example.com',
  verificationStatus: 'PENDING',
  verifiedAt: null,
  dnsTxtRecord: 'holdfast-verify=abc',
};

describe('W03 onboarding helpers (HF-011b)', () => {
  it('validates step 1', () => {
    expect(validateCompany({ name: '', domain: '' })).toEqual({
      name: expect.any(String),
      domain: expect.any(String),
    });
    expect(validateCompany({ name: 'Aurel', domain: 'not a domain' }).domain).toMatch(/domain/);
    expect(validateCompany({ name: 'Aurel', domain: 'https://www.AurelAudio.example/x' })).toEqual(
      {},
    );
  });

  it('builds the request: domain normalised, payout email locked to the login email', () => {
    expect(
      verificationRequest(
        { name: ' Aurel Audio ', domain: 'HTTPS://www.AurelAudio.example/' },
        'sb-brand@business.example.com',
      ),
    ).toEqual({
      name: 'Aurel Audio',
      domain: 'aurelaudio.example',
      payoutEmail: 'sb-brand@business.example.com',
    });
  });

  it('back/next with unchanged values does not re-save', () => {
    expect(companyChanged(companyValues(null), null)).toBe(true);
    expect(companyChanged(companyValues(brand), brand)).toBe(false);
    expect(companyChanged({ name: 'Aurel Audio', domain: 'www.aurelaudio.example' }, brand)).toBe(
      false,
    );
    expect(companyChanged({ name: 'Aurel', domain: 'aurelaudio.example' }, brand)).toBe(true);
  });

  it('opens on step 1 without a brand, the domain step with one', () => {
    expect(initialStep(null)).toBe(0);
    expect(initialStep(brand)).toBe(1);
  });

  it('status pill', () => {
    expect(statusPill('PENDING')).toEqual({ label: 'Pending', tone: 'held' });
    expect(statusPill('VERIFIED')).toEqual({ label: 'Verified', tone: 'success' });
    expect(statusPill('REJECTED')).toEqual({ label: 'Failed', tone: 'danger' });
  });

  it('maps API errors to fields and copy', () => {
    const dup = new ApiError(409, 'DUPLICATE', 'x', { field: 'domain' });
    expect(onboardingError(dup)).toMatchObject({ field: 'domain', message: /contact/ });
    expect(
      onboardingError(new ApiError(409, 'DUPLICATE', 'x', { field: 'paypalAccount' })),
    ).toEqual({ message: expect.stringMatching(/PayPal account/) });
    expect(onboardingError(new ApiError(401, 'UNAUTHENTICATED', 'x')).message).toMatch(/PayPal/);
    expect(onboardingError(new ApiError(500, 'INTERNAL', 'Boom.'))).toEqual({ message: 'Boom.' });
  });
});

describe('W03 failed verification (UI-GAPS W03)', () => {
  it('names the brand and domain and gives next steps', () => {
    const c = rejectedCopy({ name: 'Aurel Audio', domain: 'aurelaudio.com' });
    expect(c.title).toBe('We couldn’t verify Aurel Audio on aurelaudio.com.');
    expect(c.steps[0]).toMatch(/aurelaudio\.com/);
    expect(c.steps).toHaveLength(2);
  });

  it('without a domain, asks for one', () => {
    const c = rejectedCopy({ name: 'Aurel Audio', domain: null });
    expect(c.title).toBe('We couldn’t verify Aurel Audio.');
    expect(c.steps[0]).toMatch(/domain/);
  });
});
