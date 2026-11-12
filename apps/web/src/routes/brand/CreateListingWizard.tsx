import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatUsd, type CreateListingRequest } from '@holdfast/shared';
import { PageHeader } from '../../components/layout/AppShell';
import { Badge, Button, ErrorBanner, Skeleton, StepBar, useToast } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  buildCreateRequest,
  duplicateListingId,
  emptyWizard,
  estimate,
  estimateLine,
  firstInvalidStep,
  floorHelper,
  HIT_BLOCK_LABEL,
  hitBlock,
  ListingSubmitter,
  needsIdentifier,
  publicLowCents,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_CHARS,
  searchQuery,
  submitErrorMessage,
  validateStep,
  WIZARD_STEPS,
  type ProductSearchHit,
  type WizardErrors,
  type WizardStep,
  type WizardValues,
} from '../../lib/listing-wizard';
import { paths } from '../../lib/routes';
import { useBrand } from './BrandGate';

/**
 * W05 Create listing wizard (HF-013; features/02 §Logic 1–6, screens.md §W05). Four steps:
 * product (Channel3 search, or manual GTIN/MPN entry when Channel3 is down or doesn't have it),
 * quantity & price, window (start now, 24/48 h), review. Save draft works for any brand;
 * Publish needs a VERIFIED brand. On publish → W06 with the share toast.
 *
 * The floor is brand-only: this screen lives under /brand and never on shopper routes.
 */
export function CreateListingWizard() {
  const { me, listings, reloadListings } = useBrand();
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState<WizardStep>(0);
  const [values, setValues] = useState<WizardValues>(emptyWizard);
  const [errors, setErrors] = useState<WizardErrors>({});
  const [busy, setBusy] = useState<null | 'draft' | 'publish'>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  // One submitter (one Idempotency-Key) per wizard session.
  const submitter = useMemo(() => new ListingSubmitter(api), []);

  const verified = me.brand.verificationStatus === 'VERIFIED';
  const notVerified = !verified || submitError?.code === 'BRAND_NOT_VERIFIED';

  if (me.role === 'VIEWER') {
    return (
      <>
        <PageHeader eyebrow={me.brand.name} title="New listing." />
        <p className="text-[15px] text-body">
          Viewers can’t create listings. Ask an owner or manager on your team.
        </p>
      </>
    );
  }

  const set = <K extends keyof WizardValues>(key: K, value: WizardValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({
      ...e,
      [key]: undefined,
      ...(key === 'hit' ? { product: undefined } : {}),
    }));
    setSubmitError(null);
  };

  const goTo = (target: WizardStep) => {
    // Forward moves validate every step in between; back is always allowed.
    if (target > step) {
      for (let s = step; s < target; s++) {
        const e = validateStep(s as WizardStep, values);
        if (Object.keys(e).length) {
          setErrors(e);
          setStep(s as WizardStep);
          return;
        }
      }
    }
    setErrors({});
    setStep(target);
  };

  async function submit(kind: 'draft' | 'publish') {
    if (submitter.busy) return; // double-click: the submitter also shares the in-flight call
    const body = buildCreateRequest(values);
    if (!body) {
      const bad = firstInvalidStep(values) ?? 0;
      setErrors(validateStep(bad, values));
      setStep(bad);
      return;
    }
    setBusy(kind);
    setSubmitError(null);
    try {
      if (kind === 'draft') {
        const draft = await submitter.saveDraft(body);
        toast.show({ title: 'Draft saved', body: 'Publish it when your brand is verified.' });
        navigate(paths.listingConsole(draft.listingId));
      } else {
        const { published } = await submitter.publish(body);
        const url = `${window.location.origin}${published.offerPath}`;
        const copied = await navigator.clipboard?.writeText(url).then(
          () => true,
          () => false,
        );
        toast.show({
          title: 'Window open: share your offer link',
          body: copied ? `Copied ${url}` : url,
          tone: 'success',
          duration: 10_000,
        });
        navigate(paths.listingConsole(published.listingId));
      }
      reloadListings();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.'),
      );
    } finally {
      setBusy(null);
    }
  }

  const duplicateId = submitError
    ? duplicateListingId(submitError, listings, submitter.currentDraft?.productId)
    : null;

  return (
    <>
      <div className="pt-6">
        <Link to={paths.brand} className="label text-[12px] text-body hover:text-ink">
          ← Brand console
        </Link>
      </div>
      <PageHeader
        eyebrow={`New listing · Step ${step + 1} of ${WIZARD_STEPS.length}`}
        title={WIZARD_TITLES[step]}
      />

      {notVerified && (
        <div
          role="status"
          className="mb-6 flex flex-col gap-1 rounded-md border border-orange/40 bg-orange-tint p-4"
        >
          <p className="label text-[12px] text-orange">Brand not verified yet</p>
          <p className="text-[14px] text-ink">
            You can save a draft now. Publishing opens once Holdfast verifies your brand.
          </p>
        </div>
      )}

      <StepBar steps={WIZARD_STEPS} step={step} onStep={(i) => goTo(i as WizardStep)} />

      <div className="mt-8 flex max-w-[760px] flex-col gap-6">
        {step === 0 && (
          <ProductStep values={values} errors={errors} set={set} setValues={setValues} />
        )}
        {step === 1 && <PricingStep values={values} errors={errors} set={set} />}
        {step === 2 && <WindowStep values={values} set={set} />}
        {step === 3 && <ReviewStep values={values} />}

        {submitError && (
          <div className="flex flex-col gap-2">
            <ErrorBanner message={submitErrorMessage(submitError)} />
            {submitError.code === 'DUPLICATE' && (
              <Link
                className="text-[14px] text-ink underline"
                to={duplicateId ? paths.listingConsole(duplicateId) : paths.brand}
              >
                Open the live listing
              </Link>
            )}
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          {step > 0 ? (
            <Button
              variant="outline"
              onClick={() => goTo((step - 1) as WizardStep)}
              disabled={!!busy}
            >
              ← Back
            </Button>
          ) : (
            <span />
          )}
          {step < 3 ? (
            <Button onClick={() => goTo((step + 1) as WizardStep)}>
              Next: {WIZARD_STEPS[step + 1]} →
            </Button>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button variant="outline" onClick={() => submit('draft')} disabled={!!busy}>
                {busy === 'draft' ? 'Saving…' : 'Save draft'}
              </Button>
              <Button
                onClick={() => submit('publish')}
                disabled={!!busy || notVerified}
                title={notVerified ? 'Your brand must be verified to publish.' : undefined}
              >
                {busy === 'publish' ? 'Publishing…' : 'Publish'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** v4 W05 (frame 117:606): each step's page title. */
const WIZARD_TITLES: Record<WizardStep, string> = {
  0: 'Pick the product.',
  1: 'Quantity and floor.',
  2: 'Set the window.',
  3: 'Review and publish.',
};

// --- Step 1: product -----------------------------------------------------------------------------

type SetField = <K extends keyof WizardValues>(key: K, value: WizardValues[K]) => void;

type Search =
  | { state: 'idle' }
  | { state: 'loading'; q: string }
  | { state: 'results'; q: string; hits: ProductSearchHit[] }
  | { state: 'unavailable'; message: string };

function ProductStep({
  values,
  errors,
  set,
  setValues,
}: {
  values: WizardValues;
  errors: WizardErrors;
  set: SetField;
  setValues(fn: (v: WizardValues) => WizardValues): void;
}) {
  const [input, setInput] = useState('');
  // A new object per search, so Enter or Retry on the same text fetches again.
  const [submitted, setSubmitted] = useState<{ q: string } | null>(null);
  const [search, setSearch] = useState<Search>({ state: 'idle' });

  // 400 ms debounce; Enter searches at once.
  useEffect(() => {
    const q = searchQuery(input);
    if (!q || q === submitted?.q) return;
    const t = setTimeout(() => setSubmitted({ q }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input, submitted]);

  useEffect(() => {
    if (!submitted) return;
    const { q } = submitted;
    const ctl = new AbortController();
    setSearch({ state: 'loading', q });
    api
      .request<{ results: ProductSearchHit[] }>({
        method: 'GET',
        path: `/api/products/search?q=${encodeURIComponent(q)}`,
        signal: ctl.signal,
      })
      .then((r) => setSearch({ state: 'results', q, hits: r.results }))
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        const e = err instanceof ApiError ? err : null;
        if (e && (e.code === 'CHANNEL3_ERROR' || e.status === 0 || e.status >= 500)) {
          setSearch({ state: 'unavailable', message: e.message });
          setValues((v) => ({ ...v, manual: true, hit: null }));
        } else {
          setSearch({ state: 'unavailable', message: e?.message ?? 'Search failed.' });
        }
      });
    return () => ctl.abort();
  }, [submitted, setValues]);

  const manual = (on: boolean) => setValues((v) => ({ ...v, manual: on, hit: on ? null : v.hit }));

  if (values.manual) {
    return (
      <>
        {search.state === 'unavailable' && (
          <ErrorBanner
            message={search.message}
            onRetry={() => {
              manual(false);
              setSubmitted((s) => (s ? { q: s.q } : s));
              if (!submitted) setSearch({ state: 'idle' });
            }}
          />
        )}
        <h2 className="text-[22px] font-medium tracking-title text-ink">Enter your product</h2>
        <p className="text-[14px] text-body">
          Without a Channel3 match the public price is unknown, so price watch is off for this
          listing. The GTIN or MPN pins the exact product.
        </p>
        <TextField
          label="Product name"
          value={values.title}
          error={errors.title}
          onChange={(v) => set('title', v)}
          placeholder="Aurel A7 Midnight"
        />
        <IdentifierFields values={values} errors={errors} set={set} />
        <button
          type="button"
          className="self-start text-[14px] text-body underline hover:text-ink"
          onClick={() => manual(false)}
        >
          Search Channel3 instead
        </button>
      </>
    );
  }

  return (
    <>
      <h2 className="text-[22px] font-medium tracking-title text-ink">Find your product</h2>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = searchQuery(input);
          if (q) setSubmitted({ q });
        }}
      >
        <input
          type="search"
          aria-label="Search products"
          autoFocus
          className="h-11 w-full rounded-sm border border-border bg-white px-3 text-[15px] text-ink"
          placeholder="Product name or model, e.g. Tune 770NC"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </form>

      {search.state === 'idle' && (
        <p className="text-[14px] text-muted">
          Type at least {SEARCH_MIN_CHARS} characters. We match your exact product so price
          comparisons can’t be fooled by look-alikes.
        </p>
      )}
      {search.state === 'loading' && (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {search.state === 'unavailable' && <ErrorBanner message={search.message} />}
      {search.state === 'results' && search.hits.length === 0 && (
        <p className="text-[14px] text-body">No products match “{search.q}”.</p>
      )}
      {search.state === 'results' && search.hits.length > 0 && (
        <ul className="flex flex-col border border-line" aria-label="Search results">
          {search.hits.map((h, i) => (
            <HitCard
              key={`${h.channel3Id}:${h.variant ?? ''}`}
              hit={h}
              first={i === 0}
              selected={values.hit?.channel3Id === h.channel3Id && values.hit.variant === h.variant}
              onSelect={() => set('hit', h)}
            />
          ))}
        </ul>
      )}
      {errors.product && <FieldError>{errors.product}</FieldError>}

      {values.hit && needsIdentifier(values) && (
        <div className="flex flex-col gap-4 rounded-md border border-line bg-surface p-4">
          <p className="text-[14px] text-body">
            Channel3 has no GTIN or MPN for this product. Enter one from your packaging so the match
            is exact.
          </p>
          <IdentifierFields values={values} errors={errors} set={set} />
        </div>
      )}

      <button
        type="button"
        className="self-start text-[14px] text-body underline hover:text-ink"
        onClick={() => manual(true)}
      >
        Can’t find it? Enter the GTIN by hand
      </button>
    </>
  );
}

function HitCard({
  hit,
  first,
  selected,
  onSelect,
}: {
  hit: ProductSearchHit;
  first: boolean;
  selected: boolean;
  onSelect(): void;
}) {
  const block = hitBlock(hit);
  return (
    <li className={cn(!first && 'border-t border-line')}>
      <button
        type="button"
        onClick={onSelect}
        disabled={block !== null}
        aria-pressed={selected}
        className={cn(
          'flex w-full items-center gap-4 p-4 text-left',
          block ? 'cursor-not-allowed opacity-60' : 'hover:bg-surface',
          selected && 'bg-orange-tint hover:bg-orange-tint',
        )}
      >
        {hit.imageUrl ? (
          <img src={hit.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-sm object-contain" />
        ) : (
          <div className="h-16 w-16 shrink-0 rounded-sm bg-surface" aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[15px] font-medium text-ink">
            {hit.title}
            {hit.variantLabel && <span className="text-body"> · {hit.variantLabel}</span>}
          </span>
          <span className="font-mono text-[12px] text-body">
            {hit.brandName ?? 'Unknown brand'} · GTIN {hit.gtin ?? '–'} · MPN {hit.mpn ?? '–'}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {block ? (
            <Badge tone="neutral">{HIT_BLOCK_LABEL[block]}</Badge>
          ) : selected ? (
            <Badge tone="held">Selected</Badge>
          ) : null}
          <span className="text-[14px] text-ink tabular-nums">
            {hit.bestPublicPriceCents === null
              ? 'Public low unknown'
              : `Public low ${formatUsd(hit.bestPublicPriceCents)}`}
          </span>
          <span className="text-[12px] text-muted">
            {hit.offerCount} {hit.offerCount === 1 ? 'offer' : 'offers'}
          </span>
        </div>
      </button>
    </li>
  );
}

function IdentifierFields({
  values,
  errors,
  set,
}: {
  values: WizardValues;
  errors: WizardErrors;
  set: SetField;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <TextField
        label="GTIN"
        hint="8, 12, 13 or 14 digits (UPC / EAN)."
        value={values.gtin}
        error={errors.gtin}
        inputMode="numeric"
        onChange={(v) => set('gtin', v)}
      />
      <TextField
        label="MPN"
        hint="If there’s no GTIN."
        value={values.mpn}
        onChange={(v) => set('mpn', v)}
      />
    </div>
  );
}

// --- Step 2: quantity & price --------------------------------------------------------------------

function PricingStep({
  values,
  errors,
  set,
}: {
  values: WizardValues;
  errors: WizardErrors;
  set: SetField;
}) {
  const low = publicLowCents(values);
  return (
    <>
      <h2 className="text-[22px] font-medium tracking-title text-ink">Quantity & price</h2>
      <TextField
        label="Quantity"
        hint="Units you want to clear in this window."
        value={values.quantity}
        error={errors.quantity}
        inputMode="numeric"
        onChange={(v) => set('quantity', v)}
        className="sm:max-w-xs"
      />
      <MoneyField
        label="Floor price per unit"
        hint={floorHelper(low)}
        value={values.floor}
        error={errors.floor}
        onChange={(v) => set('floor', v)}
      />
      {low === null && (
        <Badge tone="neutral" className="self-start">
          Price watch off
        </Badge>
      )}
      <MoneyField
        label="Liquidation quote per unit"
        hint="What your liquidator offered. We compare it on the review step."
        value={values.liquidation}
        error={errors.liquidation}
        onChange={(v) => set('liquidation', v)}
      />
    </>
  );
}

// --- Step 3: window ------------------------------------------------------------------------------

function WindowStep({ values, set }: { values: WizardValues; set: SetField }) {
  const options = [24, 48] as const;
  return (
    <>
      <h2 className="text-[22px] font-medium tracking-title text-ink">Window</h2>
      <Field label="Starts">
        <p className="text-[15px] text-ink">Now, when you publish.</p>
      </Field>
      <Field label="Length">
        <div role="radiogroup" aria-label="Window length" className="flex self-start">
          {options.map((h, i) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={values.windowHours === h}
              onClick={() => set('windowHours', h)}
              className={cn(
                'label h-11 w-24 border border-border text-[14px]',
                i === 0 ? 'rounded-l-sm' : '-ml-px rounded-r-sm',
                values.windowHours === h
                  ? 'border-charcoal bg-charcoal text-white'
                  : 'bg-white text-charcoal hover:bg-surface',
              )}
            >
              {h} h
            </button>
          ))}
        </div>
      </Field>
      <p className="rounded-md border border-line bg-surface p-4 text-[14px] text-body">
        Card holds are guaranteed for 3 days, so a window is 48 hours at most: live rounds and Clear
        must fit before any hold can lapse.
      </p>
    </>
  );
}

// --- Step 4: review ------------------------------------------------------------------------------

function ReviewStep({ values }: { values: WizardValues }) {
  const body: CreateListingRequest | null = buildCreateRequest(values);
  if (!body) {
    return <ErrorBanner message="Some details are missing. Go back and fill them in." />;
  }
  const low = publicLowCents(values);
  const e = estimate(body.quantity, body.floorCents, body.liquidationQuoteCents);
  const max = Math.max(e.holdfastCents, e.liquidationCents, 1);
  const rows: [string, ReactNode][] = [
    [
      'Product',
      values.manual
        ? values.title.trim()
        : `${values.hit!.title}${values.hit!.variantLabel ? ` · ${values.hit!.variantLabel}` : ''}`,
    ],
    [
      'Identifier',
      body.gtin ? `GTIN ${body.gtin}` : body.mpn ? `MPN ${body.mpn}` : 'From Channel3',
    ],
    ['Quantity', `${body.quantity.toLocaleString('en-US')} units`],
    ['Floor (private)', formatUsd(body.floorCents)],
    ['Public low', low === null ? 'Unknown · price watch off' : formatUsd(low)],
    ['Liquidation quote', formatUsd(body.liquidationQuoteCents)],
    ['Window', `Starts now · ${body.windowHours} h`],
  ];
  return (
    <>
      <h2 className="text-[22px] font-medium tracking-title text-ink">Review</h2>
      <dl className="grid grid-cols-1 border border-line sm:grid-cols-[200px_1fr]">
        {rows.map(([k, v], i) => (
          <div key={k} className="contents">
            <dt className={cn('label p-3 text-[12px] text-body', i > 0 && 'border-t border-line')}>
              {k}
            </dt>
            <dd
              className={cn(
                'px-3 pb-3 text-[15px] text-ink tabular-nums sm:pt-3',
                i > 0 && 'sm:border-t sm:border-line',
              )}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>

      <figure className="flex flex-col gap-3 rounded-md border border-line p-4">
        <figcaption className="text-[15px] text-ink">{estimateLine(e)}</figcaption>
        {[
          ['Holdfast at the floor', e.holdfastCents, 'bg-orange'],
          ['Liquidation', e.liquidationCents, 'bg-bar'],
        ].map(([label, cents, tone]) => (
          <div key={label as string} className="flex flex-col gap-1">
            <div className="flex justify-between text-[13px] text-body">
              <span>{label}</span>
              <span className="tabular-nums">{formatUsd(cents as number)}</span>
            </div>
            <div className="h-3 w-full rounded-sm bg-surface" aria-hidden>
              <div
                className={cn('h-full rounded-sm', tone as string)}
                style={{ width: `${((cents as number) / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
        <p className="text-[13px] text-muted">
          {e.units.toLocaleString('en-US')} of {body.quantity.toLocaleString('en-US')} units. Bids
          at or above the floor can only do better.
        </p>
      </figure>
    </>
  );
}

// --- Fields --------------------------------------------------------------------------------------

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="label text-[12px] text-ink">
        {label}
      </label>
      {hint && <p className="text-[13px] text-body">{hint}</p>}
      {children}
    </div>
  );
}

function FieldError({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="text-[13px] text-danger">
      {children}
    </p>
  );
}

function TextField({
  label,
  hint,
  value,
  error,
  onChange,
  placeholder,
  inputMode,
  className,
}: {
  label: string;
  hint?: string;
  value: string;
  error?: string;
  onChange(v: string): void;
  placeholder?: string;
  inputMode?: 'numeric' | 'decimal' | 'text';
  className?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        autoComplete="off"
        inputMode={inputMode}
        placeholder={placeholder}
        className={cn(
          'h-11 w-full rounded-sm border border-border bg-white px-3 text-[15px] text-ink',
          className,
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

function MoneyField({
  label,
  hint,
  value,
  error,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  error?: string;
  onChange(v: string): void;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="relative sm:max-w-xs">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[17px] text-muted">
          $
        </span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          className="h-11 w-full rounded-sm border border-border bg-white pr-3 pl-7 text-[17px] text-ink tabular-nums"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </div>
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}
