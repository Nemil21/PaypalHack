import { useEffect, useId, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import {
  formatUsd,
  type BookResponse,
  type ListingPhaseName,
  type Recommendation,
} from '@holdfast/shared';
import { ClearBody, CLEARABLE } from '../../components/console/ClearModal';
import { KpiTile, type KpiKind, type KpiStore } from '../../components/console/KpiTiles';
import { M10_LABELS, RecommendationCard } from '../../components/console/RecommendationCard';
import { Badge, Button, ErrorBanner, Skeleton } from '../../components/ui';
import { cn } from '../../lib/cn';
import { compactCurve } from '../../lib/console/compact-curve';
import { buildCurveModel } from '../../lib/console/curve';
import {
  closingAlert,
  consoleLayout,
  M10_MEDIA_QUERY,
  m10State,
  type ConsoleLayout,
  type M10State,
} from '../../lib/console/m10';
import type { PhaseView } from '../../lib/console/phase';
import { useSlider, useSliderStore, type SliderStore } from '../../lib/console/slider-store';
import { useClear } from '../../lib/console/use-clear';
import { useRecommendationProse } from '../../lib/console/use-recommendation-prose';
import { paths } from '../../lib/routes';
import { doneFraction, partialNote, payoutCard, progressBars } from '../../lib/settlement/model';
import { useSettlementView } from '../../lib/settlement/use-settlement-view';
import { color } from '../../lib/tokens';

const MINI_KPIS: KpiKind[] = ['held', 'bids', 'projected', 'recovery'];

const subscribeNarrow = (fn: () => void) => {
  const mq = window.matchMedia(M10_MEDIA_QUERY);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
};
const isNarrow = () => window.matchMedia(M10_MEDIA_QUERY).matches;

/** Phone → M10, wider → W06; `?view=mobile|desktop` overrides (lib/console/m10.ts). */
export function useConsoleLayout(): ConsoleLayout {
  const { search } = useLocation();
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  return consoleLayout(search, narrow);
}

/**
 * M10 brand mobile alert + clear approval (HF-061, screens.md M10). The `brand_window_closing`
 * push lands here on a phone. Same book, slider store, KPI store and Clear flow as W06: the
 * mini KPIs and compact curve read the slider's quantity, the recommendation card sets it, and
 * "Review & clear" opens W07's numbers in a bottom sheet with a slide-to-confirm (`useClear`, so
 * BOOK_CHANGED / NOT_CLEARABLE behave exactly as on W06). After Clear the screen stays here and
 * shows settlement progress instead of switching to the W08 grid.
 */
export function MobileListing({
  book,
  phase,
  now,
  viewer,
  store,
  slider,
  banners,
  clearedHere,
  onCleared,
}: {
  book: BookResponse | null;
  phase: PhaseView | null;
  now: number;
  viewer: boolean;
  store: KpiStore;
  slider: SliderStore;
  banners: ReactNode;
  /** This phone's Clear got a 202 (progress shows before the book reads CLEARING). */
  clearedHere: boolean;
  onCleared(): void;
}) {
  const state: M10State | null = phase ? m10State(phase.phase, clearedHere) : null;
  const alert =
    book && phase ? closingAlert(phase.phase, phase.deadlineAt, now, book.stats.heldCents) : null;
  const listingId = book?.listing.id ?? '';

  return (
    <div className="flex flex-col gap-4 pt-4 pb-28" data-testid="m10">
      <header className="flex flex-col gap-2">
        <Link to={paths.brand} className="label text-[11px] text-muted">
          ← Listings
        </Link>
        {book ? (
          <h1 className="text-[22px] leading-[1.2] font-medium tracking-headline text-ink">
            {book.listing.product.title ?? 'Untitled product'}
          </h1>
        ) : (
          <Skeleton className="h-7 w-56" />
        )}
        {phase && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={phase.tone} className="uppercase" title={phase.phase}>
              {phase.pill}
            </Badge>
            {phase.deadline && (
              <span className="font-mono text-[12px] text-body tabular-nums">{phase.deadline}</span>
            )}
          </div>
        )}
      </header>

      {alert && (
        <p
          role="status"
          className="rounded-md border border-orange/30 bg-orange-tint px-4 py-3 text-[15px] font-medium text-ink tabular-nums"
          data-testid="m10-alert"
        >
          {alert}
        </p>
      )}

      {banners}

      {(state === 'clearing' || state === 'done') && listingId && (
        <ClearingProgress listingId={listingId} />
      )}

      {/* After Clear the book is settlement's: the progress card replaces the numbers. */}
      {state !== 'clearing' && state !== 'done' && (
        <>
          <section
            aria-label="Key numbers"
            className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line"
          >
            {MINI_KPIS.map((k) => (
              <MiniKpi key={k} kind={k} store={store} />
            ))}
          </section>

          {book && <CompactCurve book={book} slider={slider} />}
        </>
      )}

      {book && phase && state && (state === 'open' || state === 'rounds') && (
        <>
          {book.recommendation && <Agent book={book} recommendation={book.recommendation} />}
          <QuantityStepper disabled={viewer} />
          {viewer ? (
            <p className="text-[14px] text-body">
              View only. Your role can watch this window but not clear it.
            </p>
          ) : (
            <MobileClear
              listingId={book.listing.id}
              phase={phase.phase}
              recommendation={book.recommendation}
              onCleared={onCleared}
            />
          )}
        </>
      )}
    </div>
  );
}

function MiniKpi({ kind, store }: { kind: KpiKind; store: KpiStore }) {
  const kpis = useSyncExternalStore(store.subscribe, store.get, store.get);
  return <KpiTile kind={kind} kpis={kpis} />;
}

const W = 320;
const H = 120;

/** The W06 curve model as a small SVG step line; the cutoff follows the quantity to clear. */
function CompactCurve({ book, slider }: { book: BookResponse; slider: SliderStore }) {
  const model = useMemo(() => buildCurveModel(book), [book]);
  const cutoffCents = useSyncExternalStore(
    slider.subscribe,
    () => slider.get().numbers?.cutoffCents ?? null,
    () => slider.get().numbers?.cutoffCents ?? null,
  );
  const c = compactCurve(model, cutoffCents, { width: W, height: H });
  return (
    <section
      aria-label="Demand curve"
      className="flex flex-col gap-2 rounded-md border border-line bg-white p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="label text-[11px] text-muted">Committed demand</h2>
        {c.maxBids > 0 && (
          <span className="text-[12px] text-muted tabular-nums">up to {c.maxBids} bids</span>
        )}
      </div>
      {c.line ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-[120px] w-full"
          role="img"
          aria-label={c.markers.map((m) => m.label).join(' · ')}
          data-testid="m10-curve"
        >
          <path d={c.area} fill={color.orange} fillOpacity={0.08} />
          <path d={c.line} fill="none" stroke={color.charcoal} strokeWidth={2} />
          {c.markers.map((m) => (
            <line
              key={m.kind}
              x1={m.x}
              x2={m.x}
              y1={0}
              y2={H}
              stroke={m.kind === 'cutoff' ? color.orange : color.muted}
              strokeWidth={m.kind === 'cutoff' ? 2 : 1}
              strokeDasharray={m.kind === 'cutoff' ? undefined : '3 3'}
            />
          ))}
        </svg>
      ) : (
        <p className="py-6 text-center text-[14px] text-body">
          The curve appears with the first held bid.
        </p>
      )}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-body tabular-nums">
        {c.markers.map((m) => (
          <li key={m.kind} className={cn(m.kind === 'cutoff' && 'text-orange')}>
            {m.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Agent({ book, recommendation }: { book: BookResponse; recommendation: Recommendation }) {
  const prose = useRecommendationProse(book.listing.id, recommendation);
  return <RecommendationCard recommendation={recommendation} prose={prose} labels={M10_LABELS} />;
}

/** No slider on a phone: − / + on the same slider store (exact `clear()` at each step). */
function QuantityStepper({ disabled }: { disabled: boolean }) {
  const store = useSliderStore();
  const s = useSlider();
  const q = s.committedQuantity;
  if (q === null) {
    return <p className="text-[14px] text-body">No held bid is at or above your floor yet.</p>;
  }
  const set = (n: number) => store.setSliderQuantity(Math.min(s.max, Math.max(1, n)));
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-white px-4 py-3">
      <div className="flex flex-col">
        <span className="label text-[11px] text-muted">Units to clear</span>
        <span className="text-[13px] text-body tabular-nums">
          {s.max.toLocaleString('en-US')} can clear now
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => set(q - 1)}
          disabled={disabled || q <= 1}
          aria-label="One unit fewer"
        >
          −
        </Button>
        <span
          className="min-w-12 text-center font-mono text-[20px] text-ink tabular-nums"
          data-testid="m10-quantity"
        >
          {q.toLocaleString('en-US')}
        </span>
        <Button
          variant="outline"
          onClick={() => set(q + 1)}
          disabled={disabled || q >= s.max}
          aria-label="One unit more"
        >
          +
        </Button>
      </div>
    </div>
  );
}

/**
 * Sticky "Review & clear" (or "Stop rounds & clear") and the bottom sheet: W07's `ClearBody`
 * with `confirm="slide"` on the shared `useClear()` flow.
 */
function MobileClear({
  listingId,
  phase,
  recommendation,
  onCleared,
}: {
  listingId: string;
  phase: ListingPhaseName;
  recommendation?: Recommendation;
  onCleared(): void;
}) {
  const slider = useSlider();
  const dialog = useRef<HTMLDialogElement>(null);
  const cleared = useRef(onCleared);
  useEffect(() => {
    cleared.current = onCleared;
  }, [onCleared]);
  const clear = useClear(listingId, {
    onCleared: useMemo(
      () => () => {
        dialog.current?.close();
        cleared.current();
      },
      [],
    ),
  });
  const id = useId();

  const quantity = slider.committedQuantity;
  const rounds = phase === 'ROUNDS_ACTIVE';
  const canClear = CLEARABLE.has(phase) && quantity !== null && !slider.dragging;

  useEffect(() => {
    if (!CLEARABLE.has(phase) && clear.step !== 'cleared') dialog.current?.close();
  }, [phase, clear.step]);

  const open = () => {
    if (!canClear || quantity === null) return;
    dialog.current?.showModal();
    void clear.open({ listingId, quantity, stopRounds: rounds });
  };
  const label = rounds ? 'Stop rounds & clear' : 'Review & clear';

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur">
        <Button
          variant="primary"
          size="lg"
          block
          onClick={open}
          disabled={!canClear}
          data-testid="m10-review-clear"
        >
          {quantity !== null ? `${label} ${quantity.toLocaleString('en-US')}` : label}
        </Button>
      </div>
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        onClose={() => {
          if (clear.step !== 'cleared') clear.close();
        }}
        className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-md border-t border-line bg-white p-0 shadow-card backdrop:bg-ink/30"
        data-testid="m10-clear-sheet"
      >
        {clear.step !== 'closed' && (
          <ClearBody
            clear={clear}
            inputId={id}
            recommendation={recommendation}
            onClose={() => dialog.current?.close()}
            confirm="slide"
          />
        )}
      </dialog>
    </>
  );
}

/** Clearing progress / done (W08's model, compact): captured and released bars, payout. */
function ClearingProgress({ listingId }: { listingId: string }) {
  const s = useSettlementView(listingId);
  const view = s.view;
  if (s.error && !view) return <ErrorBanner message={s.error.message} onRetry={s.refresh} />;
  if (!view) {
    return (
      <section className="flex flex-col gap-2 rounded-md border border-line bg-white p-4" aria-busy>
        <p className="text-[15px] text-ink" role="status">
          Cleared. Charging winners…
        </p>
        <Skeleton className="h-16 w-full" />
      </section>
    );
  }
  const done = view.listingStatus !== 'CLEARING';
  const pct = Math.round(doneFraction(view) * 100);
  const bars = progressBars(view).filter((b) => b.key !== 'promoted' || b.value > 0);
  const payout = payoutCard(view);
  const partial = partialNote(view);
  return (
    <section
      aria-label="Settlement"
      className="flex flex-col gap-3 rounded-md border border-line bg-white p-4"
      data-testid="m10-progress"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[17px] font-medium text-ink" role="status">
          {done ? 'Cleared' : 'Clearing…'}
        </h2>
        <span className="font-mono text-[13px] text-body tabular-nums">{pct}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Settlement progress"
      >
        <div className="h-full bg-orange transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <ul className="flex flex-col gap-1 text-[14px] text-body tabular-nums">
        {bars.map((b) => (
          <li key={b.key}>{b.caption}</li>
        ))}
      </ul>
      {partial && <p className="text-[14px] text-ink">{partial}</p>}
      <p className="border-t border-line pt-3 text-[14px] text-body tabular-nums">
        {payout.headline}
      </p>
      <p className="text-[14px] text-ink tabular-nums" data-testid="m10-payout">
        Payout: {payout.statusLabel}
        {payout.state !== 'nothing' && payout.state !== 'waiting'
          ? ` · ${formatUsd(payout.netCents)} net`
          : ''}
        {payout.detail && <span className="block text-[13px] text-body">{payout.detail}</span>}
      </p>
      {s.stale && <ErrorBanner message="We could not refresh progress." onRetry={s.refresh} />}
      <Link className="text-[14px] underline" to={paths.listingSettlement(listingId)}>
        Open full settlement
      </Link>
    </section>
  );
}
