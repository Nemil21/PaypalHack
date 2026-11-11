import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { OrderTimelineFacts } from '@holdfast/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  orderTimelineGantt,
  phaseWhen,
  STATE_LABEL,
  timelineFrom,
  type OrderPhase,
} from '../../lib/order-timeline';
import { ErrorBanner, Skeleton } from '../ui';

const BryntumGantt = lazy(() => import('./BryntumGantt').then((m) => m.loadBryntumGantt()));

/** The Now marker moves on this tick; facts are re-read on the slower one. */
const CLOCK_MS = 30_000;
const REFRESH_MS = 60_000;
const WIDE = '(min-width: 640px)';

/** Bryntum Gantt from 640 px; below that, a vertical list (W06 / W09 / W15) or a slimmer Gantt (W08). */
export function useWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(WIDE).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; facts: OrderTimelineFacts }
  | { state: 'error'; message: string };

/**
 * Read the timeline facts (`GET /api/listings/:id/timeline` or `/api/bids/:id/order-timeline`)
 * and re-read them every minute while the tab is visible; `refreshKey` forces a re-read (e.g. on
 * a listing SSE notice).
 */
export function useOrderTimelineFacts(path: string | null, refreshKey?: unknown) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const fetchFacts = useCallback(
    (quiet: boolean) => {
      if (!path) return () => {};
      let live = true;
      if (!quiet) setLoad({ state: 'loading' });
      api
        .request<OrderTimelineFacts>({ method: 'GET', path })
        .then((facts) => live && setLoad({ state: 'ready', facts }))
        .catch((e: unknown) => {
          // A failed background refresh keeps the last good timeline on screen.
          if (live && !quiet) {
            setLoad({ state: 'error', message: e instanceof Error ? e.message : 'Failed.' });
          }
        });
      return () => {
        live = false;
      };
    },
    [path],
  );
  useEffect(() => fetchFacts(false), [fetchFacts]);
  useEffect(() => {
    if (refreshKey === undefined) return;
    return fetchFacts(true);
  }, [refreshKey, fetchFacts]);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') fetchFacts(true);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [fetchFacts]);
  return { load, retry: () => fetchFacts(false) };
}

export interface OrderTimelineProps {
  /** Facts endpoint; null renders nothing (no listing chosen yet). */
  path: string | null;
  title?: string;
  refreshKey?: unknown;
  className?: string;
}

/**
 * The order-status timeline (HF-060 part 2): window → price watch → rounds → Clear → capture
 * fan-out → payout → shipping with a "Now" marker, shared by W06, W09 and W15. Bryntum Gantt from
 * 640 px up (lazy chunk); a vertical list below that, so it works at 375 px.
 */
export function OrderTimeline({
  path,
  title = 'Order timeline',
  refreshKey,
  className,
}: OrderTimelineProps) {
  const { load, retry } = useOrderTimelineFacts(path, refreshKey);
  const wide = useWide();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  const view = useMemo(
    () => (load.state === 'ready' ? timelineFrom(load.facts, new Date(now)) : null),
    [load, now],
  );
  const gantt = useMemo(
    () => (view && wide ? orderTimelineGantt(view.phases, new Date(now)) : null),
    [view, wide, now],
  );
  if (!path) return null;

  return (
    <section aria-label={title} className={cn('flex flex-col gap-3', className)}>
      <h2 className="label text-[11px] text-muted">{title}</h2>
      {load.state === 'error' && <ErrorBanner message={load.message} onRetry={retry} />}
      {load.state === 'loading' && <Skeleton className="h-[300px] w-full" />}
      {view &&
        (gantt ? (
          <div className="overflow-hidden rounded-md border border-line">
            <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
              <BryntumGantt
                data={gantt}
                nameHeader="Step"
                nameWidth={190}
                height={300}
                ariaLabel={`${title}: ${view.phases.map((p) => `${p.label} ${STATE_LABEL[p.state]}`).join(', ')}`}
              />
            </Suspense>
            <PhaseLegend phases={view.phases} />
          </div>
        ) : (
          <PhaseList phases={view.phases} nowAt={view.nowAt} now={now} />
        ))}
    </section>
  );
}

const DOT: Record<OrderPhase['state'], string> = {
  done: 'bg-success border-success',
  active: 'bg-orange border-orange',
  upcoming: 'bg-page border-muted border-dashed',
  skipped: 'bg-line border-line',
  failed: 'bg-danger border-danger',
};

/** Under the Gantt: each phase's one-line detail (the bars carry only names). */
function PhaseLegend({ phases }: { phases: OrderPhase[] }) {
  return (
    <ul className="grid gap-x-6 gap-y-1.5 border-t border-line px-4 py-3 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
      {phases.map((p) => (
        <li key={p.key} className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn('size-2 shrink-0 translate-y-[-1px] rounded-full border', DOT[p.state])}
          />
          <span className={cn('shrink-0 text-ink', p.state === 'skipped' && 'text-muted')}>
            {p.label}
          </span>
          <span className="truncate text-body" title={p.detail}>
            {p.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 375 px: the same phases as a vertical list, with a Now divider. */
function PhaseList({ phases, nowAt, now }: { phases: OrderPhase[]; nowAt: number; now: number }) {
  const nowLine = (
    <li key="now" className="flex items-center gap-2 py-1" aria-label="Now">
      <span className="label rounded-sm bg-orange px-1.5 py-0.5 text-[10px] text-white">Now</span>
      <span className="h-px flex-1 bg-orange" />
      <span className="font-mono text-[11px] text-muted">
        {new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
      </span>
    </li>
  );
  const items = phases.map((p) => {
    const when = phaseWhen(p);
    return (
      <li key={p.key} className="relative flex gap-3 pb-4 last:pb-0" data-state={p.state}>
        <span
          aria-hidden
          className={cn('mt-1.5 size-2.5 shrink-0 rounded-full border', DOT[p.state])}
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                'text-[15px] font-medium',
                p.state === 'skipped' ? 'text-muted' : 'text-ink',
              )}
            >
              {p.label}
            </span>
            <span className="label text-[10px] text-muted">{STATE_LABEL[p.state]}</span>
          </div>
          <span className="text-[13px] text-body">{p.detail}</span>
          {when && <span className="font-mono text-[11px] text-muted">{when}</span>}
        </div>
      </li>
    );
  });
  items.splice(nowAt, 0, nowLine);
  return (
    <ol
      className="flex flex-col rounded-md border border-line p-4"
      data-testid="order-timeline-list"
    >
      {items}
    </ol>
  );
}
