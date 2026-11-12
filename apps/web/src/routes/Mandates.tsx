import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  formatUsd,
  MANDATE_PAUSE_CONFIRM,
  MANDATE_REVOKE_CONFIRM,
  type MandateBody,
  type MandateListBody,
  type MandateProduct,
  type MandateState,
  type MandateView,
} from '@holdfast/shared';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorBanner,
  Skeleton,
  useToast,
  type BadgeTone,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import { cn } from '../lib/cn';
import {
  capUsage,
  createRequest,
  formFromMandate,
  mandateCaption,
  mandateName,
  newMandateForm,
  paymentMethodRow,
  readPrefill,
  stepDollars,
  updateRequest,
  validateMandateForm,
  type MandateFormErrors,
  type MandateFormValues,
} from '../lib/mandate-form';
import { paths } from '../lib/routes';
import { useApiAction } from '../lib/use-api-action';

/**
 * W17 / M09 mandate settings (HF-017b; screens.md §W17, §M09, features/05; v4 frame 120:784).
 * Mandate cards on the left, the editor card on the right from `lg`; one column at 375 px.
 *   /mandates              list (state "none set" when empty)
 *   /mandates/new          create; W13 "Let my agent manage this" prefills ?productId&maxPriceCents
 *   /mandates/:mandateId   edit, live holds vs cap, pause (confirm) / resume, revoke (confirm, v4)
 */

type Load<T> =
  { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; data: T };

function useMandates() {
  const [state, setState] = useState<Load<MandateListBody>>({ status: 'loading' });
  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: 'loading' });
    try {
      const data = await api.request<MandateListBody>({
        method: 'GET',
        path: '/api/mandates',
        signal,
      });
      setState({ status: 'ready', data });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setState({
        status: 'error',
        error:
          err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.'),
      });
    }
  }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);
  return { state, reload: () => void load(), setState };
}

const STATE_BADGE: Record<MandateState, { tone: BadgeTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  paused: { tone: 'neutral', label: 'Paused' },
  expired: { tone: 'sim', label: 'Expired' },
  fulfilled: { tone: 'neutral', label: 'Done · item bought' },
  revoked: { tone: 'neutral', label: 'Revoked' },
};

function StateBadge({ state }: { state: MandateState }) {
  const b = STATE_BADGE[state];
  return <Badge tone={b.tone}>{b.label}</Badge>;
}

function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  if (error.status === 401) {
    return (
      <EmptyState
        message="Place a bid first, or sign in, to set up an agent mandate."
        action={<ButtonLink to={paths.demo}>Back to demo hub</ButtonLink>}
      />
    );
  }
  return <ErrorBanner message={error.message} onRetry={onRetry} />;
}

function productLabel(p: MandateProduct | undefined, id: string): string {
  return p?.title ?? `Product ${id.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------------------------
// /mandates, /mandates/new, /mandates/:mandateId: one screen (frame 120:784). Mandate cards on
// the left, the editor on the right. Below `lg` the list and the editor are separate pages.
// ---------------------------------------------------------------------------------------------

export function MandatesPage() {
  return <MandatesScreen />;
}

export function MandateEditorPage() {
  const { mandateId } = useParams();
  return <MandatesScreen creating={!mandateId} />;
}

function MandatesScreen({ creating = false }: { creating?: boolean }) {
  const { mandateId } = useParams();
  const [params] = useSearchParams();
  const { state, reload, setState } = useMandates();
  // An editor route makes the editor the page on phones; /mandates shows the list there.
  const focused = creating || !!mandateId;

  const upsert = useCallback(
    (m: MandateView) =>
      setState((s) => {
        if (s.status !== 'ready') return s;
        const known = s.data.mandates.some((x) => x.mandateId === m.mandateId);
        const mandates = known
          ? s.data.mandates.map((x) => (x.mandateId === m.mandateId ? m : x))
          : [m, ...s.data.mandates];
        return { status: 'ready', data: { ...s.data, mandates } };
      }),
    [setState],
  );

  let body: ReactNode;
  if (state.status === 'loading') body = <Skeleton className="h-96" />;
  else if (state.status === 'error') body = <LoadError error={state.error} onRetry={reload} />;
  else {
    const { mandates } = state.data;
    const selected = creating
      ? undefined
      : mandateId
        ? mandates.find((m) => m.mandateId === mandateId)
        : (mandates.find((m) => m.state === 'active') ?? mandates[0]);
    if (!creating && mandates.length === 0) {
      body = (
        <EmptyState
          message="No mandate yet. Set a max price and your agent keeps bidding within it."
          action={<ButtonLink to={paths.newMandate()}>Set up a mandate</ButtonLink>}
        />
      );
    } else if (mandateId && !selected) {
      body = (
        <EmptyState
          message="We couldn't find that mandate."
          action={
            <ButtonLink to={paths.mandates} variant="outline">
              All mandates
            </ButtonLink>
          }
        />
      );
    } else {
      body = (
        <div
          className={cn(
            'grid grid-cols-1 gap-6',
            mandates.length > 0 && 'lg:grid-cols-[270px_minmax(0,1fr)]',
          )}
        >
          {mandates.length > 0 && (
            <nav
              aria-label="Your mandates"
              className={cn('flex-col gap-3', focused ? 'hidden lg:flex' : 'flex')}
            >
              {mandates.map((m) => (
                <MandateCard
                  key={m.mandateId}
                  mandate={m}
                  selected={m.mandateId === selected?.mandateId}
                />
              ))}
            </nav>
          )}
          <div className={cn('min-w-0 flex-col gap-4', focused ? 'flex' : 'hidden lg:flex')}>
            {focused && mandates.length > 0 && (
              <Link
                to={paths.mandates}
                className="label text-[12px] text-body hover:text-ink lg:hidden"
              >
                ← All mandates
              </Link>
            )}
            <MandateEditor
              key={selected?.mandateId ?? 'new'}
              initial={selected}
              list={state.data}
              prefill={readPrefill(params)}
              onChange={upsert}
            />
          </div>
        </div>
      );
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4 pt-8 pb-6 sm:flex-row sm:items-end sm:justify-between lg:pt-16 lg:pb-8">
        <div className="flex flex-col gap-3">
          <span className="label text-[13px] text-orange">Your agent’s limits</span>
          <h1 className="text-[32px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[44px] lg:text-[56px]">
            Mandates
          </h1>
        </div>
        {!creating && state.status === 'ready' && state.data.mandates.length > 0 && (
          <ButtonLink to={paths.newMandate()} className="self-start sm:self-auto">
            + New mandate
          </ButtonLink>
        )}
      </div>
      {body}
    </>
  );
}

function MandateCard({ mandate: m, selected }: { mandate: MandateView; selected: boolean }) {
  const live = m.state === 'active' || m.state === 'paused';
  return (
    <Link
      to={paths.mandate(m.mandateId)}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'flex items-start justify-between gap-3 rounded-md border bg-white p-4 transition-colors hover:border-ink',
        selected ? 'border-ink' : 'border-line',
      )}
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[15px] font-medium text-ink">{mandateName(m)}</span>
        <span className="text-[13px] text-body tabular-nums">{mandateCaption(m)}</span>
        {m.needsPaymentMethod && live && (
          <span className="text-[12px] text-orange">Payment method needs update</span>
        )}
      </span>
      <StateBadge state={m.state} />
    </Link>
  );
}

function CapMeter({ percent }: { percent: number }) {
  return (
    <div
      role="meter"
      aria-label="Live holds against your cap"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-2 w-full overflow-hidden rounded-sm bg-surface-line"
    >
      <div className="h-full bg-orange" style={{ width: `${percent}%` }} />
    </div>
  );
}

function MandateEditor({
  initial,
  list,
  prefill,
  onChange,
}: {
  initial: MandateView | undefined;
  list: MandateListBody;
  prefill: ReturnType<typeof readPrefill>;
  /** Keeps the mandate cards on the left in step with what the server returned. */
  onChange: (m: MandateView) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [mandate, setLocal] = useState(initial);
  const setMandate = (m: MandateView) => {
    setLocal(m);
    onChange(m);
  };
  const [values, setValues] = useState<MandateFormValues>(() =>
    initial ? formFromMandate(initial) : newMandateForm(prefill),
  );
  const [capTouched, setCapTouched] = useState(!!initial);
  const [errors, setErrors] = useState<MandateFormErrors>({});
  const [confirming, setConfirming] = useState<'pause' | 'revoke' | null>(null);
  const save = useApiAction<MandateBody>();
  const pause = useApiAction<MandateBody>();
  const resume = useApiAction<MandateBody>();
  const revoke = useApiAction<MandateBody>();

  const ended =
    mandate?.status === 'FULFILLED' ||
    mandate?.status === 'EXPIRED' ||
    mandate?.status === 'REVOKED';
  const liveHoldCents = mandate?.liveHoldCents ?? 0;
  const catalog = new Map<string, MandateProduct>();
  for (const p of [...list.productOptions, ...(mandate?.products ?? [])])
    catalog.set(p.productId, p);
  const needsPaymentMethod = mandate ? mandate.needsPaymentMethod : !list.savedPaymentMethod;
  const saved = mandate ? mandate.savedPaymentMethod : list.savedPaymentMethod;

  const set = <K extends keyof MandateFormValues>(key: K, value: MandateFormValues[K]) => {
    setValues((v) => {
      const next = { ...v, [key]: value };
      // A new mandate's cap follows the max price until the shopper edits it (cap = one item).
      if (key === 'maxPrice' && !capTouched) next.totalCap = value as string;
      return next;
    });
    if (key === 'totalCap') setCapTouched(true);
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const found = validateMandateForm(values, { liveHoldCents });
    setErrors(found);
    if (Object.keys(found).length) return;
    if (!mandate) {
      const res = await save.run({
        method: 'POST',
        path: '/api/mandates',
        body: createRequest(values),
      });
      if (res) {
        save.reset();
        onChange(res.mandate);
        toast.show({
          title: 'Mandate set',
          body: 'Your agent can now bid within these limits.',
          tone: 'success',
        });
        navigate(paths.mandate(res.mandate.mandateId), { replace: true });
      }
      return;
    }
    const body = updateRequest(mandate, values);
    if (!body) {
      toast.show({ title: 'Nothing to save' });
      return;
    }
    const res = await save.run({
      method: 'PATCH',
      path: `/api/mandates/${mandate.mandateId}`,
      body,
    });
    if (res) {
      save.reset();
      setMandate(res.mandate);
      setValues(formFromMandate(res.mandate));
      toast.show({ title: 'Saved', tone: 'success' });
    }
  }

  async function onPause() {
    if (!mandate) return;
    const res = await pause.run({
      method: 'PATCH',
      path: `/api/mandates/${mandate.mandateId}`,
      body: { status: 'PAUSED' },
    });
    setConfirming(null);
    if (!res) return;
    pause.reset();
    const released = mandate.liveHolds.filter((h) => h.status === 'HELD');
    setMandate(res.mandate);
    toast.show({
      title: 'Mandate paused',
      body: released.length
        ? `Released ${formatUsd(released.reduce((s, h) => s + h.amountCents, 0))} in ${released.length} ${released.length === 1 ? 'hold' : 'holds'}. Your bank may show them as pending for a few days.`
        : 'Your agent won’t place new holds.',
      tone: 'success',
    });
  }

  async function onRevoke() {
    if (!mandate) return;
    const res = await revoke.run({
      method: 'PATCH',
      path: `/api/mandates/${mandate.mandateId}`,
      body: { status: 'REVOKED' },
    });
    setConfirming(null);
    if (!res) return;
    revoke.reset();
    const released = mandate.liveHolds.filter((h) => h.status === 'HELD');
    setMandate(res.mandate);
    toast.show({
      title: 'Mandate revoked',
      body: released.length
        ? `Released ${formatUsd(released.reduce((s, h) => s + h.amountCents, 0))} in ${released.length} ${released.length === 1 ? 'hold' : 'holds'}. Your bank may show them as pending for a few days.`
        : 'Your agent won’t bid under this mandate again.',
      tone: 'success',
    });
  }

  async function onResume() {
    if (!mandate) return;
    const res = await resume.run({
      method: 'PATCH',
      path: `/api/mandates/${mandate.mandateId}`,
      body: { status: 'ACTIVE' },
    });
    if (!res) return;
    resume.reset();
    setMandate(res.mandate);
    toast.show({ title: 'Mandate resumed', tone: 'success' });
  }

  // A cap below the live holds comes back as MANDATE_EXCEEDED: show it on the cap field.
  const saveError = save.status === 'error' ? save.error : null;
  const capServerError = saveError?.code === 'MANDATE_EXCEEDED' ? saveError.message : undefined;
  const actionError =
    (saveError && !capServerError ? saveError : null) ??
    (pause.status === 'error' ? pause.error : null) ??
    (resume.status === 'error' ? resume.error : null) ??
    (revoke.status === 'error' ? revoke.error : null);
  const usage = capUsage(liveHoldCents, mandate?.totalHoldCapCents ?? 0);
  const options = list.productOptions.filter((p) => !values.productIds.includes(p.productId));
  const payment = paymentMethodRow(
    saved,
    values.productIds.map((id) => catalog.get(id) ?? { listingSlug: null }),
    list.productOptions,
  );
  const warnPayment = needsPaymentMethod && !ended;

  return (
    <>
      <form
        onSubmit={onSubmit}
        noValidate
        className="flex flex-col gap-5 rounded-md border border-line bg-white p-4 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="label min-w-0 truncate text-[12px] text-muted">
            {mandate ? `Edit · ${mandateName(mandate)}` : 'New mandate'}
          </h2>
          {mandate && (
            <div className="flex items-center gap-2">
              {mandate.expiresAt && (
                <span className="font-mono text-[12px] text-body">
                  {mandate.state === 'expired' ? 'Ended' : 'Ends'}{' '}
                  {new Date(mandate.expiresAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              )}
              <StateBadge state={mandate.state} />
            </div>
          )}
        </div>
        {ended && (
          <p className="rounded-md border border-line bg-surface p-4 text-[14px] text-body">
            {mandate?.status === 'FULFILLED'
              ? 'This mandate is done: your agent bought the item. Set up a new one to keep bidding.'
              : mandate?.status === 'REVOKED'
                ? 'You revoked this mandate. Set up a new one to keep bidding.'
                : 'This mandate has ended. Set up a new one to keep bidding.'}
          </p>
        )}

        <fieldset disabled={ended || save.status === 'pending'} className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <MoneyField
              label="Max per item"
              hint="Your agent never bids more than this for one item."
              value={values.maxPrice}
              error={errors.maxPrice}
              onChange={(v) => set('maxPrice', v)}
            />
            <MoneyField
              label="Total hold cap"
              hint="All live holds together stay under this. Default: your max price, so you never win two."
              value={values.totalCap}
              error={errors.totalCap ?? capServerError}
              onChange={(v) => set('totalCap', v)}
            />
          </div>

          <Field
            label="Allowed products"
            hint="Leave empty to let your agent bid on any product within your limits."
          >
            {values.productIds.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {values.productIds.map((id) => (
                  <li
                    key={id}
                    className="flex items-center gap-1 rounded-sm border border-border bg-white py-1 pr-1 pl-3 text-[14px] text-ink"
                  >
                    <span className="max-w-[220px] truncate">
                      {productLabel(catalog.get(id), id)}
                    </span>
                    <button
                      type="button"
                      className="label rounded-sm px-2 py-1 text-[12px] text-muted hover:bg-surface hover:text-ink"
                      aria-label={`Remove ${productLabel(catalog.get(id), id)}`}
                      onClick={() =>
                        set(
                          'productIds',
                          values.productIds.filter((p) => p !== id),
                        )
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {options.length > 0 ? (
              <select
                className="h-11 w-full rounded-sm border border-border bg-white px-3 text-[15px] text-ink"
                value=""
                aria-label="Add a product"
                onChange={(e) =>
                  e.target.value && set('productIds', [...values.productIds, e.target.value])
                }
              >
                <option value="">Add a product…</option>
                {options.map((p) => (
                  <option key={p.productId} value={p.productId}>
                    {productLabel(p, p.productId)}
                  </option>
                ))}
              </select>
            ) : (
              values.productIds.length === 0 && (
                <p className="text-[14px] text-muted">No live listings to add right now.</p>
              )
            )}
            {errors.productIds && <FieldError>{errors.productIds}</FieldError>}
          </Field>

          <Field label="Expires" hint="Default: 30 days. Live holds stay until their window ends.">
            <input
              type="date"
              className="h-11 w-full rounded-sm border border-border bg-white px-3 text-[15px] text-ink"
              value={values.expiresOn}
              onChange={(e) => set('expiresOn', e.target.value)}
              aria-invalid={!!errors.expiresOn}
            />
            {errors.expiresOn && <FieldError>{errors.expiresOn}</FieldError>}
          </Field>

          <div className="flex flex-col divide-y divide-line border-t border-line">
            <Toggle
              label="Auto-roll into the next window"
              hint="If a bid loses, your agent re-bids in the brand’s next window, within these limits."
              checked={values.autoRoll}
              onChange={(v) => set('autoRoll', v)}
            />
            <Toggle
              label="Notify me on every action"
              hint="A notification each time your agent places, raises or releases a hold."
              checked={values.notifyEveryAction}
              onChange={(v) => set('notifyEveryAction', v)}
            />
          </div>
        </fieldset>

        <div
          role={warnPayment ? 'status' : undefined}
          className={cn(
            'flex items-start justify-between gap-4',
            warnPayment
              ? 'rounded-md border border-orange/40 bg-orange-tint p-4'
              : 'border-t border-line pt-4',
          )}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span className={cn('text-[15px]', warnPayment ? 'text-orange' : 'text-ink')}>
              {warnPayment ? 'Payment method needs update' : 'Payment method'}
            </span>
            <span className="text-[13px] text-body">{payment.detail}</span>
          </div>
          {payment.action && !ended && (
            <Link
              to={paths.offer(payment.action.slug)}
              className="shrink-0 text-[14px] font-medium text-ink hover:text-orange"
            >
              {payment.action.label} →
            </Link>
          )}
        </div>

        {actionError && <ErrorBanner message={actionError.message} />}

        {!ended && (
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row">
              {mandate?.status === 'ACTIVE' && (
                <Button
                  variant="outline"
                  block
                  className="sm:w-auto"
                  onClick={() => setConfirming('pause')}
                >
                  Pause
                </Button>
              )}
              {mandate?.status === 'PAUSED' && (
                <Button
                  variant="secondary"
                  block
                  className="sm:w-auto"
                  onClick={onResume}
                  disabled={resume.status === 'pending'}
                >
                  {resume.status === 'pending' ? 'Resuming…' : 'Resume'}
                </Button>
              )}
              {(mandate?.status === 'ACTIVE' || mandate?.status === 'PAUSED') && (
                <Button
                  variant="outline"
                  block
                  className="sm:w-auto"
                  onClick={() => setConfirming('revoke')}
                >
                  Revoke
                </Button>
              )}
            </div>
            <Button type="submit" block className="sm:w-auto" disabled={save.status === 'pending'}>
              {save.status === 'pending' ? 'Saving…' : mandate ? 'Save' : 'Set mandate'}
            </Button>
          </div>
        )}
        {!ended && (
          <p className="text-[12px] text-muted">
            {mandate
              ? 'Pause and Revoke release every live hold this mandate made. You confirm first.'
              : 'Your agent only holds money within these limits. A hold is never a charge unless you win.'}
          </p>
        )}
      </form>

      {mandate && (
        <section className="flex flex-col gap-4 rounded-md border border-line bg-white p-4 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="label text-[12px] text-muted">Live holds</h2>
            <span className="font-mono text-[12px] text-ink tabular-nums">{usage.text}</span>
          </div>
          <CapMeter percent={usage.percent} />
          {mandate.liveHolds.length === 0 ? (
            <p className="text-[14px] text-body">No live holds under this mandate.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {mandate.liveHolds.map((h) => (
                <li key={h.bidId}>
                  <Link
                    to={`${paths.bids}/${h.bidId}`}
                    className="flex items-center justify-between gap-3 py-3 hover:text-ink"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] text-ink">
                        {h.productTitle ?? 'Listing'}
                      </span>
                      <span className="label text-[11px] text-muted">
                        {h.status === 'HELD' ? 'Held · not charged' : h.status.replace('_', ' ')}
                      </span>
                    </span>
                    <span className="shrink-0 text-[15px] font-medium text-ink tabular-nums">
                      {formatUsd(h.amountCents)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {mandate && (
        <ConfirmSheet
          kind={confirming ?? 'pause'}
          open={confirming !== null}
          pending={pause.status === 'pending' || revoke.status === 'pending'}
          heldCents={mandate.liveHolds
            .filter((h) => h.status === 'HELD')
            .reduce((s, h) => s + h.amountCents, 0)}
          heldCount={mandate.liveHolds.filter((h) => h.status === 'HELD').length}
          onCancel={() => setConfirming(null)}
          onConfirm={confirming === 'revoke' ? onRevoke : onPause}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Form pieces
// ---------------------------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
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

/** Dollar input with −$10 / +$10 steppers (M09). */
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
  onChange: (v: string) => void;
}) {
  const id = useId();
  const stepper =
    'label h-11 w-12 shrink-0 border border-border bg-white text-[14px] text-charcoal hover:bg-surface';
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="flex items-stretch">
        <button
          type="button"
          className={cn(stepper, 'rounded-l-sm')}
          aria-label={`${label}: minus $10`}
          onClick={() => onChange(stepDollars(value, -1_000))}
        >
          −
        </button>
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[17px] text-muted">
            $
          </span>
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            className="h-11 w-full border-y border-border bg-white pr-3 pl-7 text-[17px] text-ink tabular-nums"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
          />
        </div>
        <button
          type="button"
          className={cn(stepper, 'rounded-r-sm')}
          aria-label={`${label}: plus $10`}
          onClick={() => onChange(stepDollars(value, 1_000))}
        >
          +
        </button>
      </div>
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="flex flex-col gap-1">
        <span id={id} className="text-[15px] text-ink">
          {label}
        </span>
        <span className="text-[13px] text-body">{hint}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-1 h-7 w-12 shrink-0 rounded-full transition-colors',
          checked ? 'bg-orange' : 'bg-bar',
        )}
      >
        <span
          className={cn(
            'absolute top-1 left-1 size-5 rounded-full bg-white shadow-card transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
    </div>
  );
}

const CONFIRM_COPY = {
  pause: {
    title: 'Pause this mandate?',
    lead: `${MANDATE_PAUSE_CONFIRM}.`,
    idle: 'You have no live holds right now. Your agent stops placing new ones.',
    keep: 'Keep active',
    confirm: 'Pause and release',
  },
  revoke: {
    title: 'Revoke this mandate?',
    lead: MANDATE_REVOKE_CONFIRM,
    idle: 'You have no live holds right now. You can’t resume a revoked mandate.',
    keep: 'Keep it',
    confirm: 'Revoke and release',
  },
} as const;

/** Pause / revoke confirm: a bottom sheet on phones (M09), a centred dialog from `sm`. */
function ConfirmSheet({
  kind,
  open,
  pending,
  heldCents,
  heldCount,
  onCancel,
  onConfirm,
}: {
  kind: keyof typeof CONFIRM_COPY;
  open: boolean;
  pending: boolean;
  heldCents: number;
  heldCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const copy = CONFIRM_COPY[kind];
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onCancel();
      }}
      className="m-0 mt-auto w-full max-w-none rounded-t-md border border-line bg-white p-0 text-ink backdrop:bg-ink/40 sm:m-auto sm:max-w-md sm:rounded-md"
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id={titleId} className="text-[23px] font-medium tracking-title">
          {copy.title}
        </h2>
        <p className="text-[16px] text-ink">{copy.lead}</p>
        <p className="text-[14px] text-body">
          {heldCount > 0
            ? `${formatUsd(heldCents)} across ${heldCount} ${heldCount === 1 ? 'hold' : 'holds'} goes back to you. Bids already won keep settling.`
            : copy.idle}
        </p>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            block
            className="sm:w-auto"
            onClick={onCancel}
            disabled={pending}
          >
            {copy.keep}
          </Button>
          <Button
            variant="secondary"
            block
            className="sm:w-auto"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Releasing…' : copy.confirm}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
