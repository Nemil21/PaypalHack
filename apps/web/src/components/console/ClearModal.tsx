import { useEffect, useId, useRef, useState } from 'react';
import {
  formatUsd,
  type ListingPhaseName,
  type Recommendation,
  type SimulateResponse,
} from '@holdfast/shared';
import {
  clearCopy,
  confirmPhrase,
  formatGrossShort,
  isConfirmTyped,
  shortfallNote,
} from '../../lib/console/clear';
import { recommendationClearNote } from '../../lib/console/recommendation';
import { cn } from '../../lib/cn';
import { useSlider } from '../../lib/console/slider-store';
import { useClear } from '../../lib/console/use-clear';
import { Button, ErrorBanner, Skeleton } from '../ui';
import { SlideToConfirm } from '../ui/SlideToConfirm';

/** Phases in which the brand can clear (the server accepts OPEN and ROUNDS). */
export const CLEARABLE: ReadonlySet<ListingPhaseName> = new Set([
  'BIDDING',
  'AWAITING_ROUNDS_OR_CLEAR',
  'ROUNDS_ACTIVE',
  'ROUNDS_ENDED',
]);

/**
 * W06 Clear button + W07 confirmation modal (HF-028, features/08 §Layout 7, screens.md W07).
 * Clears at the slider's committed quantity. During live rounds the button reads "Stop rounds &
 * clear": it stops rounds (the book freezes, D7), re-simulates, then asks for the confirm.
 * VIEWER: the button is disabled (the API refuses with 403 as well). The brand agent's
 * recommendation (HF-051a) is shown next to the numbers when there is one.
 */
export function ClearAction({
  listingId,
  phase,
  viewer,
  recommendation,
  layout = 'bar',
}: {
  listingId: string;
  phase: ListingPhaseName;
  viewer: boolean;
  recommendation?: Recommendation;
  /** `panel`: the full-width orange button in the v4 Clear panel (frame 112:64). */
  layout?: 'bar' | 'panel';
}) {
  const slider = useSlider();
  const clear = useClear(listingId);
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const inputId = useId();

  const quantity = slider.committedQuantity;
  const rounds = phase === 'ROUNDS_ACTIVE';
  const canClear = CLEARABLE.has(phase) && quantity !== null && !slider.dragging;

  useEffect(() => {
    // The listing moved on (cleared elsewhere, cancelled, expired): nothing left to confirm.
    if (!CLEARABLE.has(phase) && clear.step !== 'cleared') dialog.current?.close();
  }, [phase, clear.step]);

  if (!CLEARABLE.has(phase)) return null;

  const open = () => {
    if (!canClear || viewer || quantity === null) return;
    setTyped('');
    dialog.current?.showModal();
    void clear.open({ listingId, quantity, stopRounds: rounds });
  };

  const label = rounds ? 'Stop rounds & clear' : 'Clear';
  const title = viewer
    ? 'Your role can watch this window but not clear it.'
    : quantity === null
      ? 'No held bid is at or above the floor yet.'
      : undefined;

  return (
    <div className={layout === 'panel' ? 'flex' : 'flex justify-end border-t border-line pt-4'}>
      <Button
        variant="primary"
        size="lg"
        block={layout === 'panel'}
        onClick={open}
        disabled={viewer || !canClear}
        title={title}
        data-testid="clear-button"
      >
        {quantity !== null && !viewer
          ? `${label} ${quantity.toLocaleString('en-US')}${layout === 'panel' ? ' units' : ''}`
          : label}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={`${inputId}-title`}
        onClose={() => {
          if (clear.step !== 'cleared') clear.close();
        }}
        className="m-auto w-[min(560px,calc(100vw-32px))] rounded-md border border-line bg-white p-0 shadow-card backdrop:bg-ink/30"
        data-testid="clear-modal"
      >
        {clear.step !== 'closed' && (
          <ClearBody
            clear={clear}
            typed={typed}
            setTyped={setTyped}
            inputId={inputId}
            recommendation={recommendation}
            onClose={() => dialog.current?.close()}
          />
        )}
      </dialog>
    </div>
  );
}

/**
 * The W07 body for every step of the Clear flow. `confirm: 'type'` (W07) asks for `CLEAR 240`;
 * `'slide'` (HF-061's M10 sheet) shows the same numbers with a slide-to-confirm. Both keep the
 * one-click "Confirm $X" after a 409 BOOK_CHANGED.
 */
export function ClearBody({
  clear,
  typed = '',
  setTyped = () => {},
  inputId,
  recommendation,
  onClose,
  confirm = 'type',
}: {
  clear: ReturnType<typeof useClear>;
  typed?: string;
  setTyped?(v: string): void;
  inputId: string;
  recommendation?: Recommendation;
  onClose(): void;
  confirm?: 'type' | 'slide';
}) {
  const { step, summary, quantity, error } = clear;
  const titleId = `${inputId}-title`;
  const slide = confirm === 'slide';
  // After a 409 BOOK_CHANGED the confirm is one click on the new gross, in both modes.
  const oneClick = !slide || clear.previousGrossCents !== null;
  const typedOk = quantity !== null && (slide || isConfirmTyped(typed, quantity));
  const submitting = step === 'submitting';
  const agentNote = quantity === null ? null : recommendationClearNote(recommendation, quantity);

  const heading =
    step === 'holds_too_old'
      ? 'Some holds are too old to clear'
      : step === 'released' || step === 'releasing'
        ? 'Releasing every hold'
        : summary?.cutoffCents != null && quantity !== null
          ? `Fill ${quantity.toLocaleString('en-US')} units at a ${formatUsd(summary.cutoffCents)} cutoff?`
          : `Clear ${quantity?.toLocaleString('en-US') ?? ''} units?`;

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-2">
        <span className="label text-[12px] text-orange">Clear this window</span>
        <h2
          id={titleId}
          className="text-[24px] leading-[1.2] font-medium tracking-headline text-ink"
        >
          {heading}
        </h2>
      </div>

      {step === 'stopping' && <p className="text-[15px] text-body">Stopping rounds…</p>}
      {(step === 'stopping' || step === 'loading') && (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      {step === 'not_clearable' && (
        <>
          <p className="text-[15px] leading-[22px] text-body" role="status">
            This window can no longer be cleared
            {clear.listingStatus ? ` (it is ${clear.listingStatus.toLowerCase()})` : ''}. Nothing
            was charged.
          </p>
          <Footer>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </Footer>
        </>
      )}

      {(step === 'holds_too_old' || step === 'releasing') && (
        <>
          <p className="text-[15px] leading-[22px] text-body" role="alert">
            {clear.agedBidIds.length === 1
              ? "A winner's hold is"
              : `${clear.agedBidIds.length || 'Some'} winners' holds are`}{' '}
            66 hours old or more, too old to charge safely. Release every hold now; shoppers can bid
            again in a new window.
          </p>
          <Footer>
            <Button variant="outline" onClick={onClose}>
              Keep window open
            </Button>
            <Button variant="secondary" onClick={clear.releaseAll} disabled={step === 'releasing'}>
              {step === 'releasing' ? 'Releasing…' : 'Release all'}
            </Button>
          </Footer>
        </>
      )}

      {step === 'released' && (
        <>
          <p className="text-[15px] leading-[22px] text-body" role="status">
            The window is cancelled and every hold is being released. Shoppers' banks may show them
            as pending for a few days.
          </p>
          <Footer>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </Footer>
        </>
      )}

      {step === 'cleared' && (
        <p className="text-[15px] text-body" role="status">
          {slide ? 'Cleared. Charging winners…' : 'Cleared. Opening settlement…'}
        </p>
      )}

      {step === 'error' && clear.failedStage !== 'clear' && error && (
        <>
          <ErrorBanner
            message={error.message}
            onRetry={error.retryable ? clear.retry : undefined}
          />
          <Footer>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </Footer>
        </>
      )}

      {summary &&
        quantity !== null &&
        (step === 'ready' ||
          step === 'submitting' ||
          step === 'book_changed' ||
          (step === 'error' && clear.failedStage === 'clear')) && (
          <>
            {step === 'book_changed' && (
              <div
                role="alert"
                className="rounded-md border border-orange/30 bg-orange-tint px-4 py-3 text-[14px] text-ink"
              >
                Book changed: new gross {formatGrossShort(summary.grossCents)}
                {clear.previousGrossCents !== null &&
                  ` (was ${formatGrossShort(clear.previousGrossCents)})`}
                . Check the numbers and confirm again.
              </div>
            )}
            <MoneyTable sim={summary} />
            <p className="text-[15px] leading-[22px] text-body" data-testid="clear-copy">
              {clearCopy(summary)}
            </p>
            {agentNote && (
              <p className="text-[14px] text-body" data-testid="clear-recommendation">
                {agentNote}
              </p>
            )}
            <div className="flex flex-col gap-2">
              {shortfallNote(quantity, summary.winners) && (
                <p className="text-[14px] text-ink" role="status">
                  {shortfallNote(quantity, summary.winners)}
                </p>
              )}
              {slide ? (
                !oneClick && (
                  <SlideToConfirm
                    label={`Slide to clear ${quantity.toLocaleString('en-US')}`}
                    busyLabel="Clearing…"
                    busy={submitting}
                    disabled={summary.winners < 1}
                    onConfirm={() => void clear.confirm()}
                    testId="clear-slide"
                  />
                )
              ) : (
                <>
                  <label htmlFor={inputId} className="label text-[11px] text-muted">
                    Type <span className="text-ink">{confirmPhrase(quantity)}</span> to confirm
                  </label>
                  <input
                    id={inputId}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={submitting}
                    placeholder={confirmPhrase(quantity)}
                    className="h-11 rounded-sm border border-ink px-3 font-mono text-[15px] text-ink"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && typedOk && !submitting) void clear.confirm();
                    }}
                  />
                </>
              )}
            </div>
            {step === 'error' && error && (
              <ErrorBanner
                message={
                  error.retryable
                    ? `${error.message} Nothing is charged twice: retrying repeats the same Clear.`
                    : error.message
                }
                onRetry={error.retryable ? clear.retry : undefined}
              />
            )}
            <Footer split={!slide}>
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                {slide ? 'Cancel' : 'Keep window open'}
              </Button>
              {oneClick && (
                <Button
                  variant="primary"
                  onClick={() => void clear.confirm()}
                  disabled={!typedOk || submitting || summary.winners < 1}
                  data-testid="clear-confirm"
                >
                  {submitting
                    ? 'Clearing…'
                    : step === 'book_changed'
                      ? `Confirm ${formatGrossShort(summary.grossCents)}`
                      : slide
                        ? 'Confirm'
                        : 'Clear and capture'}
                </Button>
              )}
            </Footer>
          </>
        )}
    </div>
  );
}

function Footer({ children, split = false }: { children: React.ReactNode; split?: boolean }) {
  return (
    <div className={split ? 'flex flex-wrap justify-between gap-2' : 'flex justify-end gap-2'}>
      {children}
    </div>
  );
}

function MoneyTable({ sim }: { sim: SimulateResponse }) {
  const pct = (sim.feeBps / 100).toFixed(sim.feeBps % 100 ? 2 : 0);
  const rows: [string, string, string?][] = [
    ['Gross', formatUsd(sim.grossCents), 'each winner pays their own bid'],
    [
      `Holdfast fee (${pct}%)`,
      `−${formatUsd(sim.feeCents)}`,
      'estimated; final on captured amount',
    ],
    ['Net to you', formatUsd(sim.netCents)],
  ];
  if (sim.liquidationCents !== null) {
    const diff = sim.grossCents - sim.liquidationCents;
    rows.push([
      'vs liquidator quote',
      `${diff >= 0 ? '+' : '−'}${formatUsd(Math.abs(diff))}${
        sim.recoveryMultiple !== null ? ` (${sim.recoveryMultiple.toFixed(1)}×)` : ''
      }`,
    ]);
  }
  return (
    <table className="w-full text-[14px]" data-testid="clear-money">
      <tbody>
        {rows.map(([k, v, note]) => {
          const net = k === 'Net to you';
          return (
            <tr key={k} className="border-t border-line">
              <th
                scope="row"
                className={cn('py-2.5 text-left font-normal', net ? 'text-ink' : 'text-body')}
              >
                {k}
                {note && <span className="text-muted"> ({note})</span>}
              </th>
              <td
                className={cn(
                  'py-2.5 text-right text-ink tabular-nums',
                  net && 'text-[18px] font-medium',
                )}
              >
                {v}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
