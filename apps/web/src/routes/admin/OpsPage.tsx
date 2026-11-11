import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Skeleton,
  StatTile,
  useToast,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import type { BrandMe } from '../../lib/brand-gate';
import { cn } from '../../lib/cn';
import {
  actionRequest,
  actionResultText,
  AUDIT_ENTITIES,
  auditSearchPath,
  EMPTY_SEARCH,
  healthTiles,
  OPS_ACTIONS,
  type AuditPage,
  type AuditRow,
  type AuditSearch,
  type OpsActionInput,
  type OpsActionSpec,
  type OpsHealth,
} from '../../lib/ops';
import { paths } from '../../lib/routes';
import { useApiAction } from '../../lib/use-api-action';

const AuditEventsGrid = lazy(() => import('../../components/ag/AuditEventsGrid'));

const HEALTH_REFRESH_MS = 30_000;
const field = 'h-9 rounded-sm border border-border bg-white px-2 text-[14px]';

type Access =
  { state: 'loading' } | { state: 'signed-out' } | { state: 'forbidden' } | { state: 'admin' };

/**
 * W20 Ops / audit log (HF-058; screens.md §W20, features/15 §Logic 4). Admins only (`ADMIN_EMAILS`):
 * search every money event by brand, listing, bid or PayPal id; health tiles (PayPal token,
 * Channel3, settlement queue, webhooks, alerts) that turn red when degraded; and the four
 * actions, each confirmed and audited server-side.
 */
export function OpsPage() {
  const [access, setAccess] = useState<Access>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    api
      .request<{ brandUser: BrandMe | null }>({ method: 'GET', path: '/api/me' })
      .then((me) => {
        if (!live) return;
        if (!me.brandUser) setAccess({ state: 'signed-out' });
        else setAccess({ state: me.brandUser.isAdmin ? 'admin' : 'forbidden' });
      })
      .catch(() => live && setAccess({ state: 'signed-out' }));
    return () => {
      live = false;
    };
  }, []);

  if (access.state === 'loading') {
    return (
      <div className="flex flex-col gap-4 pt-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  if (access.state !== 'admin') {
    return (
      <div className="pt-8">
        <EmptyState
          message={
            access.state === 'signed-out'
              ? 'Sign in with an admin account to see the ops screen.'
              : 'Ops is for Holdfast admins only (ADMIN_EMAILS).'
          }
          action={
            access.state === 'signed-out' ? (
              <Link className="label text-[13px] text-orange underline" to={paths.brandSignIn}>
                Sign in
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }
  return <OpsScreen />;
}

function OpsScreen() {
  const [params, setParams] = useSearchParams();
  const [form, setForm] = useState<AuditSearch>(() => ({
    ...EMPTY_SEARCH,
    q: params.get('q') ?? '',
    entity: params.get('entity') ?? '',
  }));
  const [search, setSearch] = useState<AuditSearch>(form);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [eventsError, setEventsError] = useState<ApiError | null>(null);
  const [health, setHealth] = useState<OpsHealth | null>(null);
  const [healthError, setHealthError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [inputs, setInputs] = useState<OpsActionInput>({ brandId: '', listingId: '', price: '' });

  const loadEvents = useCallback(async (s: AuditSearch) => {
    setEventsError(null);
    try {
      setPage(await api.request<AuditPage>({ method: 'GET', path: auditSearchPath(s) }));
    } catch (err) {
      setEventsError(err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Failed.'));
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await api.request<OpsHealth>({ method: 'GET', path: '/api/admin/health' }));
      setHealthError(null);
    } catch (err) {
      setHealthError(err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Failed.'));
    }
  }, []);

  useEffect(() => {
    setPage(null);
    void loadEvents(search);
  }, [search, loadEvents]);

  useEffect(() => {
    void loadHealth();
    const timer = setInterval(() => void loadHealth(), HEALTH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadHealth]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSearch({ ...form });
    const next = new URLSearchParams();
    if (form.q.trim()) next.set('q', form.q.trim());
    if (form.entity) next.set('entity', form.entity);
    setParams(next, { replace: true });
  };

  const loadOlder = async () => {
    if (!page?.nextBeforeId) return;
    setLoadingMore(true);
    try {
      const older = await api.request<AuditPage>({
        method: 'GET',
        path: auditSearchPath(search, page.nextBeforeId),
      });
      setPage({ rows: [...page.rows, ...older.rows], nextBeforeId: older.nextBeforeId });
    } catch (err) {
      setEventsError(err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Failed.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const select = (row: AuditRow) => {
    setSelected(row);
    setInputs((i) => ({
      ...i,
      brandId: row.brandId ?? i.brandId,
      listingId: row.listingId ?? i.listingId,
    }));
  };

  const afterAction = () => {
    void loadHealth();
    void loadEvents(search);
  };

  return (
    <div className="flex flex-col gap-8 pt-8 pb-16" data-testid="ops-page">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="label text-[11px] text-muted">Admin · W20</span>
          <h1 className="text-[28px] leading-[34px] font-medium tracking-headline text-ink">
            Ops &amp; audit log
          </h1>
        </div>
        {health && (
          <Badge tone={health.status === 'healthy' ? 'success' : 'danger'}>
            {health.status === 'healthy' ? 'All systems healthy' : 'Degraded'}
          </Badge>
        )}
      </header>

      <HealthPanel health={health} error={healthError} onRefresh={loadHealth} />

      <section className="flex flex-col gap-4" aria-labelledby="ops-events">
        <h2 id="ops-events" className="label text-[12px] text-muted">
          Events
        </h2>
        <SearchBar form={form} setForm={setForm} onSubmit={submit} />
        {eventsError ? (
          <ErrorBanner message={eventsError.message} onRetry={() => void loadEvents(search)} />
        ) : !page ? (
          <Skeleton className="h-[520px] w-full" />
        ) : page.rows.length === 0 ? (
          <EmptyState
            message={
              search.q
                ? `No events for “${search.q}”. Try a PayPal capture, authorization or order id, or a brand, listing or bid id.`
                : 'No events match these filters.'
            }
          />
        ) : (
          <>
            <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
              <AuditEventsGrid rows={page.rows} onSelect={select} />
            </Suspense>
            <div className="flex items-center justify-between text-[13px] text-muted">
              <span>
                {page.rows.length} events
                {search.q &&
                  ' · orange PayPal ids match the search; the rest are the same bid’s events'}
              </span>
              {page.nextBeforeId && (
                <Button variant="outline" onClick={() => void loadOlder()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load older'}
                </Button>
              )}
            </div>
          </>
        )}
        {selected && <SelectedEvent row={selected} />}
      </section>

      <ActionsPanel inputs={inputs} setInputs={setInputs} onDone={afterAction} />
    </div>
  );
}

function HealthPanel({
  health,
  error,
  onRefresh,
}: {
  health: OpsHealth | null;
  error: ApiError | null;
  onRefresh(): void;
}) {
  if (error && !health) return <ErrorBanner message={error.message} onRetry={onRefresh} />;
  const tiles = health ? healthTiles(health) : null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ops-health">
      <div className="flex items-center justify-between">
        <h2 id="ops-health" className="label text-[12px] text-muted">
          Health
        </h2>
        <Button variant="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tiles
          ? tiles.map((t) => (
              <StatTile
                key={t.key}
                label={t.label}
                value={t.value}
                caption={t.caption}
                className={cn(!t.ok && 'border-danger/40 bg-danger-tint')}
              />
            ))
          : Array.from({ length: 5 }, (_, i) => <StatTile key={i} label="…" value={undefined} />)}
      </div>
    </section>
  );
}

function SearchBar({
  form,
  setForm,
  onSubmit,
}: {
  form: AuditSearch;
  setForm(f: AuditSearch): void;
  onSubmit(e: FormEvent): void;
}) {
  const id = useId();
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" role="search">
      <div className="flex min-w-[280px] flex-1 flex-col gap-1">
        <label htmlFor={`${id}-q`} className="label text-[11px] text-muted">
          Brand, listing, bid or PayPal id
        </label>
        <input
          id={`${id}-q`}
          value={form.q}
          onChange={(e) => setForm({ ...form, q: e.target.value })}
          placeholder="e.g. a capture id"
          className={cn(field, 'font-mono')}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-entity`} className="label text-[11px] text-muted">
          Entity
        </label>
        <select
          id={`${id}-entity`}
          value={form.entity}
          onChange={(e) => setForm({ ...form, entity: e.target.value })}
          className={field}
        >
          <option value="">All</option>
          {AUDIT_ENTITIES.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-from`} className="label text-[11px] text-muted">
          From
        </label>
        <input
          id={`${id}-from`}
          type="date"
          value={form.from}
          onChange={(e) => setForm({ ...form, from: e.target.value })}
          className={field}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-to`} className="label text-[11px] text-muted">
          To
        </label>
        <input
          id={`${id}-to`}
          type="date"
          value={form.to}
          onChange={(e) => setForm({ ...form, to: e.target.value })}
          className={field}
        />
      </div>
      <Button type="submit" variant="secondary">
        Search
      </Button>
      <Button type="button" variant="ghost" onClick={() => setForm(EMPTY_SEARCH)}>
        Clear
      </Button>
    </form>
  );
}

function SelectedEvent({ row }: { row: AuditRow }) {
  return (
    <details className="rounded-md border border-line bg-white p-4" open>
      <summary className="label cursor-pointer text-[12px] text-muted">
        Event #{row.id} · {row.action}
      </summary>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 font-mono text-[12px]">
        {(
          [
            ['Actor', `${row.actorType} ${row.actorId ?? ''}`],
            ['Brand', row.brandId ? `${row.brandName ?? ''} ${row.brandId}` : '–'],
            ['Listing', row.listingId ?? '–'],
            ['Entity', `${row.entity} ${row.entityId ?? ''}`],
            ['PayPal id', row.paypalId ?? '–'],
            ['Request id', row.requestId ?? '–'],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="break-all text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <pre className="mt-3 overflow-x-auto rounded-sm bg-surface p-3 text-[12px] text-ink">
        {JSON.stringify(row.data, null, 2)}
      </pre>
    </details>
  );
}

function ActionsPanel({
  inputs,
  setInputs,
  onDone,
}: {
  inputs: OpsActionInput;
  setInputs(i: OpsActionInput): void;
  onDone(): void;
}) {
  const id = useId();
  const [pending, setPending] = useState<OpsActionSpec | null>(null);
  return (
    <section className="flex flex-col gap-4" aria-labelledby="ops-actions">
      <h2 id="ops-actions" className="label text-[12px] text-muted">
        Actions
      </h2>
      <p className="text-[14px] text-body">
        Click an event to fill in its brand and listing. Every action asks for confirmation and is
        written to the audit log as you.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(
          [
            ['brandId', 'Brand id', 'font-mono'],
            ['listingId', 'Listing id', 'font-mono'],
            ['price', 'New public price ($, replay only)', 'tabular-nums'],
          ] as const
        ).map(([key, label, cls]) => (
          <div key={key} className="flex flex-col gap-1">
            <label htmlFor={`${id}-${key}`} className="label text-[11px] text-muted">
              {label}
            </label>
            <input
              id={`${id}-${key}`}
              value={inputs[key] ?? ''}
              onChange={(e) => setInputs({ ...inputs, [key]: e.target.value })}
              className={cn(field, cls)}
              inputMode={key === 'price' ? 'decimal' : undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {OPS_ACTIONS.map((a) => (
          <Button
            key={a.kind}
            variant={a.kind === 'void-dangling' ? 'secondary' : 'outline'}
            onClick={() => setPending(a)}
          >
            {a.label}
            {a.demo ? ' · demo' : ''}
          </Button>
        ))}
      </div>
      <ConfirmAction
        spec={pending}
        inputs={inputs}
        onClose={() => setPending(null)}
        onDone={onDone}
      />
    </section>
  );
}

function ConfirmAction({
  spec,
  inputs,
  onClose,
  onDone,
}: {
  spec: OpsActionSpec | null;
  inputs: OpsActionInput;
  onClose(): void;
  onDone(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const action = useApiAction<unknown>();
  const toast = useToast();
  const req = spec ? actionRequest(spec.kind, inputs) : null;
  const { reset } = action;

  useEffect(() => {
    // A new action is asked for: a fresh Idempotency-Key, then the confirm dialog.
    if (spec) {
      reset();
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [spec, reset]);

  const confirm = async () => {
    if (!spec || !req?.ok) return;
    const body = await action.run(req.request);
    if (body !== undefined) {
      toast.show({ title: spec.label, body: actionResultText(spec.kind, body), tone: 'success' });
      onDone();
      onClose();
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-md border border-line bg-white p-0 shadow-card backdrop:bg-ink/30"
      data-testid="ops-confirm"
    >
      {spec && (
        <div className="flex flex-col gap-4 p-6">
          <h3 id={titleId} className="text-[20px] font-medium text-ink">
            {spec.label}?
            {spec.demo && (
              <Badge tone="sim" className="ml-2 align-middle">
                Demo · labelled replay
              </Badge>
            )}
          </h3>
          <p className="text-[15px] leading-[22px] text-body">{spec.confirm}</p>
          {spec.fields.length > 0 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[12px]">
              {spec.fields.map((f) => (
                <div key={f} className="contents">
                  <dt className="text-muted">{f === 'price' ? 'price' : f}</dt>
                  <dd className="break-all text-ink">{inputs[f] || '–'}</dd>
                </div>
              ))}
            </dl>
          )}
          {req && !req.ok && (
            <p role="alert" className="text-[14px] text-danger">
              {req.error}
            </p>
          )}
          {action.status === 'error' && (
            <p role="alert" className="text-[14px] text-danger">
              {action.error.message}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void confirm()}
              disabled={!req?.ok || action.status === 'pending'}
              data-testid="ops-confirm-run"
            >
              {action.status === 'pending' ? '…' : 'Confirm'}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
