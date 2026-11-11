import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  formatUsd,
  type BrandBidView,
  type SettlementRow,
  type SettlementView,
} from '@holdfast/shared';
import { Badge, Button, ErrorBanner, Skeleton, type BadgeTone } from '../../components/ui';
import { cn } from '../../lib/cn';
import type { ListingEventsStatus } from '../../lib/listing-events';
import {
  doneFraction,
  LOG_FILTERS,
  logRows,
  partialNote,
  payoutCard,
  progressBars,
  RESERVE_HINT,
  settlementPhase,
  type LogFilter,
  type LogRow,
  type PayoutCard,
  type ProgressBar,
} from '../../lib/settlement/model';

const SettlementLogGrid = lazy(() => import('../../components/ag/SettlementLogGrid'));

/** "Download statement" links to HF-059b's statement; hidden until that ships. */
const STATEMENT_URL: ((listingId: string) => string) | null = null;

export interface SettlementScreenProps {
  view: SettlementView | null;
  title: string | null;
  /** Console link (live route only). */
  backHref?: string;
  stream?: ListingEventsStatus;
  stale?: boolean;
  onRefresh?(): void;
  /** Admin payout retry (HF-032). Absent: no button. */
  retryPayout?: {
    run(): Promise<void>;
    pending: boolean;
    error: string | null;
  };
  /** Brand-scoped bid view for the drawer; absent in the fixture replay. */
  loadBid?(bidId: string): Promise<BrandBidView>;
  /** Extra controls above the screen (fixture player). */
  toolbar?: ReactNode;
}

/**
 * W08 settlement live view (HF-035; screens.md §W08, features 11 and 12): progress ring and bars
 * (Captured, Released, Failed, Promoted), the payout card, the partial state, the live log on AG
 * Grid and the bid detail drawer. Pure presentation over one `SettlementView`; the live route
 * re-reads it on SSE notices, the dev route replays the recorded fixture.
 */
export function SettlementScreen(props: SettlementScreenProps) {
  const { view } = props;
  const [filter, setFilter] = useState<LogFilter>('all');
  const [search, setSearch] = useState('');
  const [openBid, setOpenBid] = useState<string | null>(null);

  const rows = useMemo(() => (view ? logRows(view) : []), [view]);
  const phase = view ? settlementPhase(view) : null;
  const partial = view ? partialNote(view) : null;

  return (
    <div className="flex flex-col gap-6 pb-12">
      {props.toolbar}
      <Header {...props} phase={phase} partial={!!partial} />

      {props.stream === 'reconnecting' && (
        <Note tone="neutral">Live updates paused. Reconnecting…</Note>
      )}
      {props.stale && (
        <ErrorBanner
          message="We could not refresh settlement. The numbers may be out of date."
          onRetry={props.onRefresh}
        />
      )}
      {partial && <Note tone="held">{partial}</Note>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Progress view={view} />
        <Payout card={view ? payoutCard(view) : null} retry={props.retryPayout} />
      </div>

      <section aria-label="Live log" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter the log">
            {LOG_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'label h-8 rounded-sm px-3 text-[12px]',
                  filter === f.key ? 'bg-charcoal text-white' : 'text-body hover:bg-surface',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a bidder or PayPal ID"
            aria-label="Find a bidder or PayPal ID"
            className="h-9 w-full rounded-sm border border-border px-3 text-[14px] sm:w-72"
          />
        </div>
        {view ? (
          <Suspense fallback={<Skeleton className="h-[460px] w-full" />}>
            <SettlementLogGrid
              rows={rows}
              filter={filter}
              search={search}
              onOpen={(r) => setOpenBid(r.bidId)}
            />
          </Suspense>
        ) : (
          <Skeleton className="h-[460px] w-full" />
        )}
      </section>

      {view && openBid && (
        <BidDrawer
          key={openBid}
          view={view}
          bidId={openBid}
          rows={rows}
          loadBid={props.loadBid}
          onOpen={setOpenBid}
          onClose={() => setOpenBid(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const PHASE: Record<string, { label: string; tone: BadgeTone }> = {
  running: { label: 'Settling', tone: 'held' },
  promoting: { label: 'Promoting', tone: 'held' },
  done: { label: 'Done', tone: 'success' },
};

function Header({
  view,
  title,
  backHref,
  phase,
  partial,
}: SettlementScreenProps & { phase: string | null; partial: boolean }) {
  return (
    <header className="flex flex-col gap-4 border-b border-line pt-8 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="label text-[13px] text-orange">Settlement</span>
        {title ? (
          <h1 className="text-[26px] leading-[1.15] font-medium tracking-headline text-ink sm:text-[32px]">
            {title}
          </h1>
        ) : (
          <Skeleton className="h-8 w-72" />
        )}
        {view && phase && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PHASE[phase]!.tone}>{PHASE[phase]!.label}</Badge>
            {partial && <Badge tone="danger">Partial</Badge>}
            <span className="text-[14px] text-body">
              Each winner is charged their own bid. Everyone else&apos;s hold is released.
            </span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {backHref && (
          <Link className="label text-[13px] text-body underline" to={backHref}>
            Back to console
          </Link>
        )}
        {view && STATEMENT_URL && (
          <a className="label text-[13px] text-body underline" href={STATEMENT_URL(view.listingId)}>
            Download statement
          </a>
        )}
      </div>
    </header>
  );
}

function Progress({ view }: { view: SettlementView | null }) {
  if (!view) return <Skeleton className="h-[220px] w-full" />;
  const bars = progressBars(view);
  const frac = doneFraction(view);
  const settled = view.counts.total - view.counts.queued - view.counts.running;
  return (
    <section
      aria-label="Progress"
      className="flex flex-col gap-6 rounded-md border border-line p-5 sm:flex-row sm:items-center"
    >
      <Ring fraction={frac} label={`${settled} of ${view.counts.total}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {bars.map((b) => (
          <Bar key={b.key} bar={b} />
        ))}
        {view.counts.released < bars.find((b) => b.key === 'released')!.total && (
          <p className="text-[13px] text-muted">{RESERVE_HINT}</p>
        )}
      </div>
    </section>
  );
}

function Ring({ fraction, label }: { fraction: number; label: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div
      className="relative mx-auto size-[136px] shrink-0"
      role="img"
      aria-label={`${Math.round(fraction * 100)}% settled`}
    >
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--color-line)" strokeWidth="8" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="var(--color-orange)"
          strokeWidth="8"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fraction)}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[22px] font-medium text-ink tabular-nums">{label}</span>
        <span className="label text-[10px] text-muted">settled</span>
      </div>
    </div>
  );
}

const BAR_FILL: Record<ProgressBar['tone'], string> = {
  success: 'bg-success',
  neutral: 'bg-charcoal',
  danger: 'bg-danger',
  held: 'bg-orange',
};

function Bar({ bar }: { bar: ProgressBar }) {
  const pct = bar.total === 0 ? 0 : Math.min(100, (bar.value / bar.total) * 100);
  return (
    <div className="flex flex-col gap-1.5" data-testid={`bar-${bar.key}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="label text-[11px] text-muted">{bar.label}</span>
        <span className="text-[13px] text-body tabular-nums">{bar.caption}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-sm bg-surface"
        role="progressbar"
        aria-label={bar.label}
        aria-valuemin={0}
        aria-valuemax={bar.total}
        aria-valuenow={bar.value}
      >
        <div
          className={cn('h-full transition-[width] duration-500', BAR_FILL[bar.tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const PAYOUT_TONE: Record<PayoutCard['state'], BadgeTone> = {
  waiting: 'neutral',
  nothing: 'neutral',
  pending: 'held',
  succeeded: 'success',
  failed: 'danger',
};

function Payout({
  card,
  retry,
}: {
  card: PayoutCard | null;
  retry?: SettlementScreenProps['retryPayout'];
}) {
  if (!card) return <Skeleton className="h-[220px] w-full" />;
  return (
    <section aria-label="Payout" className="flex flex-col gap-4 rounded-md border border-line p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="label text-[11px] text-muted">Payout</span>
        <Badge tone={PAYOUT_TONE[card.state]} className="uppercase">
          {card.statusLabel}
        </Badge>
      </div>
      <p className="text-[15px] font-medium text-ink tabular-nums" data-testid="payout-headline">
        {card.headline}
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[14px] tabular-nums">
        <dt className="text-body">Captured</dt>
        <dd className="text-right text-ink">{formatUsd(card.capturedCents)}</dd>
        <dt className="text-body">{card.feeLabel}</dt>
        <dd className="text-right text-ink">−{formatUsd(card.feeCents)}</dd>
        <dt className="border-t border-line pt-2 font-medium text-ink">
          Net to you{card.estimate ? ' (so far)' : ''}
        </dt>
        <dd className="border-t border-line pt-2 text-right text-[20px] font-medium text-orange">
          {formatUsd(card.netCents)}
        </dd>
      </dl>
      {card.detail && <p className="text-[13px] text-body">{card.detail}</p>}
      {card.paypalBatchId && (
        <p className="font-mono text-[12px] text-muted">
          Batch {card.paypalBatchId}
          {card.attempt && card.attempt > 1 ? ` · attempt ${card.attempt}` : ''}
        </p>
      )}
      {card.retryable && retry && (
        <div className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => void retry.run()} disabled={retry.pending}>
            {retry.pending ? 'Retrying…' : 'Retry payout'}
          </Button>
          {retry.error && <p className="text-[13px] text-danger">{retry.error}</p>}
        </div>
      )}
    </section>
  );
}

function Note({ tone, children }: { tone: 'neutral' | 'held'; children: ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-md border px-4 py-3 text-[14px]',
        tone === 'held'
          ? 'border-orange/30 bg-orange-tint text-ink'
          : 'border-line bg-surface text-body',
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Bid detail drawer
// ---------------------------------------------------------------------------------------------

type BidLoad =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; bid: BrandBidView }
  | { state: 'error'; message: string };

const ACTION_LABEL: Record<string, string> = {
  BID_HELD: 'Hold placed',
  BID_WON: 'Won at Clear',
  BID_LOST: 'Below the cutoff at Clear',
  CAPTURE_REQUESTED: 'Capture requested',
  CAPTURE_SUCCEEDED: 'Charged',
  CAPTURE_FAILED: 'Capture failed',
  BID_VOID_REQUESTED: 'Release requested',
  BID_VOIDED: 'Released',
  VOID_REQUESTED: 'Release requested',
  VOID_SUCCEEDED: 'Released',
  VOID_FAILED: 'Release failed',
  PROMOTED: 'Promoted into a unit',
  UNFILLED_UNIT: 'Unit left unfilled',
};

function BidDrawer({
  view,
  bidId,
  rows,
  loadBid,
  onOpen,
  onClose,
}: {
  view: SettlementView;
  bidId: string;
  rows: LogRow[];
  loadBid?(bidId: string): Promise<BrandBidView>;
  onOpen(bidId: string): void;
  onClose(): void;
}) {
  const [load, setLoad] = useState<BidLoad>(loadBid ? { state: 'loading' } : { state: 'none' });
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!loadBid) return;
    let live = true;
    loadBid(bidId)
      .then((bid) => live && setLoad({ state: 'ready', bid }))
      .catch(
        (e: unknown) =>
          live && setLoad({ state: 'error', message: e instanceof Error ? e.message : 'Failed.' }),
      );
    return () => {
      live = false;
    };
  }, [bidId, loadBid]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const settlementRows: SettlementRow[] = view.rows.filter((r) => r.bidId === bidId);
  const logs = rows.filter((r) => r.bidId === bidId);
  const head = settlementRows[0];
  const linked = logs.find((l) => l.linkedBidId)?.linkedBidId ?? null;
  const linkedLabel = linked ? view.rows.find((r) => r.bidId === linked)?.shopperLabel : null;
  const bid = load.state === 'ready' ? load.bid : null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <button
        type="button"
        aria-label="Close bid detail"
        className="absolute inset-0 bg-ink/20"
        onClick={onClose}
        tabIndex={-1}
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Bid detail: ${head?.shopperLabel ?? 'bid'}`}
        className="relative flex h-full w-full max-w-[440px] flex-col gap-5 overflow-y-auto border-l border-line bg-page p-6"
        data-testid="bid-drawer"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="label text-[11px] text-muted">Bid detail</span>
            <h2 className="text-[22px] font-medium text-ink">
              {head?.shopperLabel ?? bid?.shopperLabel ?? 'Bid'}
            </h2>
            <span className="text-[14px] text-body tabular-nums">
              Own bid {formatUsd(head?.amountCents ?? bid?.amountCents ?? 0)}
            </span>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {logs.find((l) => l.note) && (
          <div className="rounded-md border border-orange/30 bg-orange-tint px-4 py-3 text-[14px] text-ink">
            {logs.find((l) => l.note)!.note}
            {linked && (
              <button type="button" className="mt-2 block underline" onClick={() => onOpen(linked)}>
                Open {linkedLabel ?? 'linked bid'}
              </button>
            )}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <h3 className="label text-[11px] text-muted">Settlement</h3>
          {settlementRows.map((r) => {
            const l = logs.find((x) => x.settlementId === r.settlementId)!;
            return (
              <dl
                key={r.settlementId}
                className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 rounded-md border border-line p-3 text-[13px]"
              >
                <dt className="text-muted">Action</dt>
                <dd>
                  <Badge
                    tone={
                      l.kind === 'capture-failed' || l.kind === 'release-failed'
                        ? 'danger'
                        : 'neutral'
                    }
                  >
                    {l.action}
                  </Badge>
                </dd>
                <dt className="text-muted">Amount</dt>
                <dd className="tabular-nums text-ink">{formatUsd(r.amountCents)}</dd>
                <dt className="text-muted">PayPal ID</dt>
                <dd className="font-mono text-[12px] break-all text-ink">{r.paypalId ?? '–'}</dd>
                <dt className="text-muted">PayPal status</dt>
                <dd className="text-ink">{r.paypalStatus ?? '–'}</dd>
                <dt className="text-muted">Attempts</dt>
                <dd className="tabular-nums text-ink">{r.attempts}</dd>
                {(r.errorCode || r.errorClass) && (
                  <>
                    <dt className="text-muted">Error</dt>
                    <dd className="font-mono text-[12px] text-danger">
                      {[r.errorClass, r.errorCode].filter(Boolean).join(' · ')}
                    </dd>
                  </>
                )}
                <dt className="text-muted">Reserve</dt>
                <dd className="text-ink">{r.isReserve ? 'Yes' : 'No'}</dd>
                <dt className="text-muted">Finished</dt>
                <dd className="text-ink">
                  {r.finishedAt ? new Date(r.finishedAt).toLocaleString('en-US') : '–'}
                </dd>
              </dl>
            );
          })}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="label text-[11px] text-muted">Bid</h3>
          {load.state === 'none' && (
            <p className="text-[13px] text-muted">The bid history loads on live listings.</p>
          )}
          {load.state === 'loading' && <Skeleton className="h-32 w-full" />}
          {load.state === 'error' && <ErrorBanner message={load.message} />}
          {bid && (
            <>
              <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                <dt className="text-muted">Status</dt>
                <dd className="text-ink">{bid.status.replaceAll('_', ' ')}</dd>
                <dt className="text-muted">Source</dt>
                <dd className="text-ink">
                  {bid.source ?? '–'}
                  {bid.isSimulated ? ' (simulated)' : ''}
                </dd>
                <dt className="text-muted">Payment</dt>
                <dd className="text-ink">{bid.paymentMethod ?? '–'}</dd>
                <dt className="text-muted">Placed</dt>
                <dd className="text-ink">{new Date(bid.placedAt).toLocaleString('en-US')}</dd>
                <dt className="text-muted">Raises</dt>
                <dd className="tabular-nums text-ink">{bid.raiseCount}</dd>
                {bid.promotedFrom && (
                  <>
                    <dt className="text-muted">Replaced</dt>
                    <dd className="text-ink">{bid.promotedFrom.shopperLabel} (declined)</dd>
                  </>
                )}
                {bid.promotedTo && (
                  <>
                    <dt className="text-muted">Unit went to</dt>
                    <dd className="text-ink">
                      {bid.promotedTo.shopperLabel} at their own bid{' '}
                      {formatUsd(bid.promotedTo.amountCents)}
                    </dd>
                  </>
                )}
              </dl>
              <ol className="flex flex-col gap-2 border-l border-line pl-4">
                {bid.timeline.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex flex-col text-[13px]">
                    <span className="text-ink">
                      {ACTION_LABEL[e.action] ?? e.action.replaceAll('_', ' ').toLowerCase()}
                    </span>
                    <span className="font-mono text-[11px] text-muted">
                      {new Date(e.at).toLocaleString('en-US')}
                      {e.paypalId ? ` · ${e.paypalId}` : ''}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </aside>
    </div>
  );
}
