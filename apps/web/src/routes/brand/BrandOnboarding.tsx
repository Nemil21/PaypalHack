import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { PageHeader } from '../../components/layout/AppShell';
import { Badge, Button, ButtonLink, ErrorBanner, Skeleton, useToast } from '../../components/ui';
import { ApiAction, ApiError, api } from '../../lib/api';
import {
  companyChanged,
  companyValues,
  initialStep,
  ONBOARDING_STEPS,
  onboardingError,
  RECHECK_MS,
  statusPill,
  validateCompany,
  verificationRequest,
  type CompanyErrors,
  type CompanyValues,
  type OnboardingBrand,
  type OnboardingLoad,
  type OnboardingStep,
  type VerificationStatus,
} from '../../lib/brand-onboarding';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';

/**
 * W03 Brand verification onboarding (HF-011b; features/01 §Logic 3–6, screens.md §W03).
 * Company → Domain → Payout. Step 1 upserts the PENDING brand (`POST /api/brands/verification`),
 * which also swaps HF-010's pending PayPal identity for a brand session, so brand endpoints work
 * from here on without signing in again. Verification is an admin approval in the demo
 * ("Verified by Holdfast team"); admins see "Verify now" (HF-011a). The DNS TXT check is HF-056.
 */

type Load =
  | { state: 'loading' }
  | { state: 'error'; error: ApiError }
  | { state: 'ready'; data: OnboardingLoad };

const toApiError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');

export function BrandOnboarding() {
  const navigate = useNavigate();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [step, setStep] = useState<OnboardingStep>(0);
  const [values, setValues] = useState<CompanyValues>({ name: '', domain: '' });
  const [errors, setErrors] = useState<CompanyErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'next' | 'exit' | 'verify' | 'check'>(null);
  // One action per distinct body: retries of the same save share an Idempotency-Key.
  const saver = useMemo(() => new ApiAction(api), []);
  const verifier = useMemo(() => new ApiAction(api), []);

  const fetchState = useCallback(
    () => api.request<OnboardingLoad>({ method: 'GET', path: '/api/brands/verification' }),
    [],
  );

  useEffect(() => {
    let live = true;
    fetchState().then(
      (data) => {
        if (!live) return;
        setLoad({ state: 'ready', data });
        setValues(companyValues(data.brand));
        setStep(initialStep(data.brand));
      },
      (err) => {
        if (!live) return;
        const e = toApiError(err);
        if (e.status === 401) {
          navigate(`${paths.brandSignIn}?next=${encodeURIComponent(paths.brandOnboarding)}`, {
            replace: true,
          });
        } else setLoad({ state: 'error', error: e });
      },
    );
    return () => {
      live = false;
    };
  }, [fetchState, navigate]);

  const data = load.state === 'ready' ? load.data : null;
  const brand = data?.brand ?? null;
  const pending = brand?.verificationStatus === 'PENDING';

  const setBrand = useCallback((next: OnboardingBrand) => {
    setLoad((l) => (l.state === 'ready' ? { ...l, data: { ...l.data, brand: next } } : l));
  }, []);

  const recheck = useCallback(async () => {
    const fresh = await fetchState();
    setLoad({ state: 'ready', data: fresh });
    return fresh;
  }, [fetchState]);

  // While PENDING on the domain step, re-check every 30 s (admin approval lands here).
  useEffect(() => {
    if (step !== 1 || !pending) return;
    const t = setInterval(() => void recheck().catch(() => undefined), RECHECK_MS);
    return () => clearInterval(t);
  }, [step, pending, recheck]);

  if (load.state === 'loading') {
    return (
      <div className="flex flex-col gap-4 pt-8" aria-busy>
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-[220px] w-full max-w-[760px]" />
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <div className="pt-8">
        <ErrorBanner message={load.error.message} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  const { loginEmail, isAdmin } = load.data;
  const readOnly = brand !== null && !pending;

  /** Save step 1 when it changed; returns false (with errors shown) when it didn't go through. */
  async function save(): Promise<boolean> {
    const e = validateCompany(values);
    setErrors(e);
    setSaveError(null);
    if (Object.keys(e).length) {
      setStep(0);
      return false;
    }
    if (readOnly || !companyChanged(values, brand)) return true;
    try {
      const saved = await saver.run<OnboardingBrand & { created: boolean }>({
        method: 'POST',
        path: '/api/brands/verification',
        body: verificationRequest(values, loginEmail),
      });
      setBrand(saved);
      setValues(companyValues(saved));
      return true;
    } catch (err) {
      const mapped = onboardingError(toApiError(err));
      if (mapped.field) setErrors({ [mapped.field]: mapped.message });
      else setSaveError(mapped.message);
      setStep(0);
      return false;
    }
  }

  const goTo = async (target: OnboardingStep) => {
    if (busy) return;
    // Leaving step 1 forward saves it first: the brand must exist for the DNS record.
    if (target > 0 && (step === 0 || !brand)) {
      setBusy('next');
      const ok = await save();
      setBusy(null);
      if (!ok) return;
    }
    setStep(target);
  };

  const saveAndExit = async () => {
    if (busy) return;
    setBusy('exit');
    const ok = step === 0 ? await save() : true;
    setBusy(null);
    if (ok) navigate(paths.brand);
  };

  const verifyNow = async () => {
    if (!brand || busy) return;
    setBusy('verify');
    try {
      await verifier.run({ method: 'POST', path: `/api/admin/brands/${brand.brandId}/verify` });
      verifier.reset();
      await recheck();
      toast.show({ title: 'Brand verified', body: brand.name, tone: 'success' });
    } catch (err) {
      setSaveError(toApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const checkNow = async () => {
    if (busy) return;
    setBusy('check');
    try {
      await recheck();
    } catch (err) {
      setSaveError(toApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={brand?.name ?? 'Brand verification'}
        title="Verify your brand."
        lede="Only real brands sell on Holdfast. Tell us who you are; we verify you before your first window opens."
      />

      {brand?.verificationStatus === 'VERIFIED' && <VerifiedCard brand={brand} />}
      {brand?.verificationStatus === 'REJECTED' && <RejectedCard />}

      <Stepper step={step} onStep={(s) => void goTo(s)} />

      <div className="mt-8 flex max-w-[760px] flex-col gap-6">
        {step === 0 && (
          <CompanyStep
            values={values}
            errors={errors}
            loginEmail={loginEmail}
            status={brand?.verificationStatus ?? null}
            onChange={(k, v) => {
              setValues((x) => ({ ...x, [k]: v }));
              setErrors((x) => ({ ...x, [k]: undefined }));
              setSaveError(null);
            }}
          />
        )}
        {step === 1 && brand && (
          <DomainStep
            brand={brand}
            isAdmin={isAdmin}
            busy={busy}
            onCheck={checkNow}
            onVerify={verifyNow}
          />
        )}
        {step === 2 && brand && <PayoutStep brand={brand} />}

        {saveError && <ErrorBanner message={saveError} />}

        <div className="flex flex-col-reverse gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          {step > 0 ? (
            <Button
              variant="ghost"
              onClick={() => void goTo((step - 1) as OnboardingStep)}
              disabled={!!busy}
            >
              Back
            </Button>
          ) : (
            <span />
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button variant="outline" onClick={() => void saveAndExit()} disabled={!!busy}>
              {busy === 'exit' ? 'Saving…' : 'Save and exit'}
            </Button>
            {step < 2 ? (
              <Button
                variant="secondary"
                onClick={() => void goTo((step + 1) as OnboardingStep)}
                disabled={!!busy}
                aria-busy={busy === 'next'}
              >
                {busy === 'next' ? 'Saving…' : 'Next'}
              </Button>
            ) : brand?.verificationStatus === 'VERIFIED' ? (
              <ButtonLink to={paths.newListing}>Create your first listing</ButtonLink>
            ) : (
              <Button onClick={() => navigate(paths.brand)} disabled={!!busy}>
                Finish
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// --- Stepper ---------------------------------------------------------------------------------

function Stepper({ step, onStep }: { step: OnboardingStep; onStep(s: OnboardingStep): void }) {
  return (
    <ol className="flex flex-wrap gap-2" aria-label="Steps">
      {ONBOARDING_STEPS.map((label, i) => (
        <li key={label}>
          <button
            type="button"
            onClick={() => onStep(i as OnboardingStep)}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'label flex items-center gap-2 rounded-sm border px-3 py-2 text-[12px]',
              i === step
                ? 'border-charcoal bg-charcoal text-white'
                : i < step
                  ? 'border-border bg-white text-ink hover:bg-surface'
                  : 'border-line bg-white text-muted hover:bg-surface',
            )}
          >
            <span className="font-mono">{i + 1}</span>
            {label}
          </button>
        </li>
      ))}
    </ol>
  );
}

// --- Step 1: company -------------------------------------------------------------------------

function CompanyStep({
  values,
  errors,
  loginEmail,
  status,
  onChange,
}: {
  values: CompanyValues;
  errors: CompanyErrors;
  loginEmail: string;
  /** Null before step 1 is saved. Only a PENDING brand (or none yet) can edit these. */
  status: VerificationStatus | null;
  onChange(key: keyof CompanyValues, value: string): void;
}) {
  const readOnly = status === 'VERIFIED' || status === 'REJECTED';
  return (
    <section aria-label="Company" className="flex flex-col gap-5">
      <TextField
        label="Company name"
        value={values.name}
        error={errors.name}
        placeholder="Aurel Audio"
        readOnly={readOnly}
        onChange={(v) => onChange('name', v)}
      />
      <TextField
        label="Website domain"
        hint="The site your products are sold on. You'll prove you own it next."
        value={values.domain}
        error={errors.domain}
        placeholder="aurelaudio.example"
        readOnly={readOnly}
        onChange={(v) => onChange('domain', v)}
      />
      <TextField
        label="Payout PayPal email"
        hint="Locked to the PayPal account you signed in with, so a payout can't go to a typo."
        value={loginEmail}
        readOnly
        onChange={() => undefined}
      />
      {status === 'VERIFIED' && (
        <p className="text-[13px] text-body">
          Your brand is verified; change these details in brand settings.
        </p>
      )}
      {status === 'REJECTED' && (
        <p className="text-[13px] text-body">
          This brand was rejected, so these details are locked. Contact support@holdfast.example to
          have it reviewed.
        </p>
      )}
    </section>
  );
}

// --- Step 2: domain --------------------------------------------------------------------------

function DomainStep({
  brand,
  isAdmin,
  busy,
  onCheck,
  onVerify,
}: {
  brand: OnboardingBrand;
  isAdmin: boolean;
  busy: string | null;
  onCheck(): void;
  onVerify(): void;
}) {
  const toast = useToast();
  const pill = statusPill(brand.verificationStatus);
  const copy = async () => {
    const ok = await navigator.clipboard?.writeText(brand.dnsTxtRecord).then(
      () => true,
      () => false,
    );
    toast.show({ title: ok ? 'Record copied' : 'Copy failed: select the record instead' });
  };
  return (
    <section aria-label="Prove domain" className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <h2 className="text-[22px] font-medium text-ink">Prove you own {brand.domain}</h2>
        <Badge tone={pill.tone}>{pill.label}</Badge>
      </div>
      <p className="text-[15px] leading-[23px] text-body">
        Add this TXT record to <span className="font-mono text-ink">{brand.domain}</span> at your
        DNS provider.
      </p>
      <div className="flex flex-col gap-3 rounded-sm border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <code className="font-mono text-[14px] break-all text-ink">{brand.dnsTxtRecord}</code>
        <Button variant="outline" onClick={() => void copy()}>
          Copy
        </Button>
      </div>

      {brand.verificationStatus === 'PENDING' && (
        <div
          role="status"
          className="flex flex-col gap-1 rounded-md border border-orange/40 bg-orange-tint p-4"
        >
          <p className="label text-[12px] text-orange">Pending</p>
          <p className="text-[14px] text-ink">
            DNS changes can take up to an hour. During the demo the Holdfast team verifies brands by
            hand; this page re-checks every 30 seconds.
          </p>
        </div>
      )}
      {brand.verificationStatus === 'VERIFIED' && (
        <p role="status" className="text-[14px] text-success">
          Verified by Holdfast team.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        {brand.verificationStatus === 'PENDING' && (
          <Button variant="secondary" onClick={onCheck} disabled={!!busy}>
            {busy === 'check' ? 'Checking…' : 'Check now'}
          </Button>
        )}
        {isAdmin && brand.verificationStatus === 'PENDING' && (
          <Button onClick={onVerify} disabled={!!busy} title="Admin only (ADMIN_EMAILS)">
            {busy === 'verify' ? 'Verifying…' : 'Verify now'}
          </Button>
        )}
      </div>
    </section>
  );
}

// --- Step 3: payout --------------------------------------------------------------------------

function PayoutStep({ brand }: { brand: OnboardingBrand }) {
  return (
    <section aria-label="Payout account" className="flex flex-col gap-5">
      <h2 className="text-[22px] font-medium text-ink">Payout account</h2>
      <div className="flex flex-col gap-2 border border-line bg-white p-5">
        <p className="label text-[12px] text-muted">PayPal business account</p>
        <p className="font-mono text-[16px] break-all text-ink">{brand.payoutEmail}</p>
        <p className="text-[14px] text-body">
          The account you signed in with. Cleared windows pay out here; payouts already in flight
          keep the email they were cleared with.
        </p>
      </div>
      <div className="flex items-start gap-2">
        <Badge tone="sim">Sandbox</Badge>
        <p className="text-[13px] text-muted">
          Any sandbox business email is accepted. PayPal has no zero-amount test payout, so the
          account is confirmed by your PayPal sign-in.
        </p>
      </div>
    </section>
  );
}

// --- States ----------------------------------------------------------------------------------

function VerifiedCard({ brand }: { brand: OnboardingBrand }) {
  return (
    <div
      role="status"
      className="mb-6 flex flex-col gap-3 border border-success/40 bg-white p-5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-col gap-1">
        <p className="label text-[12px] text-success">Verified by Holdfast team</p>
        <p className="text-[15px] text-ink">
          {brand.name} is verified. Shoppers see the Verified brand badge on your offers.
        </p>
      </div>
      <ButtonLink to={paths.newListing}>Create your first listing</ButtonLink>
    </div>
  );
}

function RejectedCard() {
  return (
    <div
      role="alert"
      className="mb-6 flex flex-col gap-1 rounded-md border border-danger/40 bg-danger-tint p-4"
    >
      <p className="label text-[12px] text-danger">Verification failed</p>
      <p className="text-[14px] text-ink">
        We couldn’t verify this brand. Contact support@holdfast.example and we’ll review it with
        you.
      </p>
    </div>
  );
}

// --- Fields ----------------------------------------------------------------------------------

function TextField({
  label,
  hint,
  value,
  error,
  placeholder,
  readOnly,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  error?: string;
  placeholder?: string;
  readOnly?: boolean;
  onChange(v: string): void;
}): ReactNode {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="label text-[12px] text-ink">
        {label}
      </label>
      {hint && <p className="text-[13px] text-body">{hint}</p>}
      <input
        id={id}
        autoComplete="off"
        placeholder={placeholder}
        readOnly={readOnly}
        className={cn(
          'h-11 w-full rounded-sm border border-border bg-white px-3 text-[15px] text-ink',
          readOnly && 'bg-surface text-body',
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
