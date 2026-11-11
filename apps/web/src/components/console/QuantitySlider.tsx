import { useEffect, useId, useRef } from 'react';
import { formatUsd } from '@holdfast/shared';
import { cn } from '../../lib/cn';
import { formatUsdCompact } from '../../lib/console/kpis';
import { clampNote } from '../../lib/console/slider';
import { useSlider, useSliderStore } from '../../lib/console/slider-store';

/** Commit after this long without movement (keyboard repeat, assistive tech, missed pointerup). */
const IDLE_COMMIT_MS = 200;

/**
 * The quantity slider (HF-024, features/08 §Layout 4): range 1 … min(quantity, eligible bids).
 * Dragging moves the store on the prefix-sum path; letting go (pointer up, key up, blur or a
 * short pause) runs the shared `clear()` for the exact numbers.
 */
export function QuantitySlider({ disabled = false }: { disabled?: boolean }) {
  const store = useSliderStore();
  const s = useSlider();
  const id = useId();
  const noteId = useId();
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (idle.current && clearTimeout(idle.current)), []);

  const release = () => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    store.release();
  };

  if (!s.book) return null;
  const floor = formatUsd(s.book.floorCents);
  const note = clampNote(s.book, s.requested, floor);
  const empty = s.quantity === null;
  const n = s.numbers;

  return (
    <div className="flex flex-col gap-3" data-testid="quantity-slider">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id} className="label text-[11px] text-muted">
          Units to clear
        </label>
        <span className="text-[14px] text-body tabular-nums" aria-live="polite">
          {n && n.cutoffCents !== null ? (
            <>
              <span className="text-ink">{n.quantity.toLocaleString('en-US')}</span> at ≥{' '}
              <span className="text-ink">{formatUsd(n.cutoffCents)}</span> ·{' '}
              <span className="text-ink">{formatUsdCompact(n.grossCents)}</span> gross
              {n.recoveryMultiple !== null && <> · ×{n.recoveryMultiple.toFixed(1)} liquidation</>}
            </>
          ) : (
            'Nothing to clear yet'
          )}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-6 text-right text-[12px] text-muted tabular-nums">{empty ? 0 : 1}</span>
        <input
          id={id}
          type="range"
          min={1}
          max={Math.max(1, s.max)}
          step={1}
          value={s.quantity ?? 1}
          disabled={disabled || empty}
          aria-describedby={note ? noteId : undefined}
          aria-valuetext={
            n && n.cutoffCents !== null
              ? `${n.quantity} units, cutoff ${formatUsd(n.cutoffCents)}, gross ${formatUsd(n.grossCents)}`
              : undefined
          }
          title={note ?? undefined}
          className={cn(
            'h-2 min-w-0 flex-1 cursor-pointer accent-orange',
            (disabled || empty) && 'cursor-not-allowed opacity-50',
          )}
          onChange={(e) => {
            store.drag(Number(e.currentTarget.value));
            if (idle.current) clearTimeout(idle.current);
            idle.current = setTimeout(release, IDLE_COMMIT_MS);
          }}
          onPointerUp={release}
          onKeyUp={release}
          onBlur={release}
        />
        <span className="min-w-6 text-[12px] text-muted tabular-nums">
          {s.max.toLocaleString('en-US')}
        </span>
      </div>
      {note && (
        <p id={noteId} role="note" className="text-[13px] text-body">
          {note}
        </p>
      )}
    </div>
  );
}
