import { useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { isSlideComplete, slideFraction, slideKey } from '../../lib/slide-confirm';

const THUMB = 52;

/**
 * Slide-to-confirm (HF-061, M10's Clear sheet instead of the typed `CLEAR 240`). Drag the thumb
 * to the end and let go; short of the end it springs back. Keyboard: the thumb is a slider
 * (arrows step, End jumps) and reaching the end confirms. It stays at the end while `busy`;
 * when `busy` drops without the parent moving on (an error), it springs back to slide again.
 */
export function SlideToConfirm({
  label,
  busyLabel,
  busy = false,
  disabled = false,
  onConfirm,
  testId,
}: {
  /** "Slide to clear 240". */
  label: string;
  /** Shown once confirmed, while the parent works ("Clearing…"). */
  busyLabel: string;
  busy?: boolean;
  disabled?: boolean;
  onConfirm(): void;
  testId?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const [fraction, setFraction] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [travel, setTravel] = useState(0);
  // A confirm the parent finished without leaving (an error to retry): slide again.
  const [wasBusy, setWasBusy] = useState(busy);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) {
      setConfirmed(false);
      setFraction(0);
    }
  }
  const locked = disabled || busy || confirmed;

  const finish = (f: number) => {
    if (isSlideComplete(f)) {
      setFraction(1);
      setConfirmed(true);
      onConfirm();
    } else {
      setFraction(0);
    }
  };

  return (
    <div
      ref={track}
      className={cn(
        'relative h-[56px] w-full touch-none overflow-hidden rounded-sm border select-none',
        locked && !confirmed && !busy
          ? 'border-line bg-surface'
          : 'border-orange/40 bg-orange-tint',
      )}
      data-testid={testId}
    >
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 bg-orange/15"
        style={{ width: `calc(${fraction} * (100% - ${THUMB}px) + ${THUMB}px)` }}
      />
      <span
        aria-hidden
        className="label pointer-events-none absolute inset-0 flex items-center justify-center pl-12 text-[13px] text-charcoal"
      >
        {busy || confirmed ? busyLabel : label}
      </span>
      <div
        role="slider"
        tabIndex={locked ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-disabled={locked || undefined}
        className={cn(
          'absolute top-[2px] left-[2px] flex h-[50px] w-[48px] items-center justify-center rounded-sm text-[20px] text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-charcoal',
          locked && !confirmed && !busy ? 'cursor-not-allowed bg-muted' : 'cursor-grab bg-orange',
          !dragging && 'transition-transform duration-200',
        )}
        style={{ transform: `translateX(${fraction * travel}px)` }}
        onPointerDown={(e) => {
          if (locked) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, from: fraction };
          setTravel(Math.max(0, (track.current?.clientWidth ?? 0) - THUMB));
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const width = track.current?.clientWidth ?? 0;
          setFraction(slideFraction(drag.current.from, e.clientX - drag.current.x, width, THUMB));
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          setDragging(false);
          finish(fraction);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
          setFraction(0);
        }}
        onKeyDown={(e) => {
          if (locked) return;
          const next = slideKey(fraction, e.key);
          if (next === null) return;
          e.preventDefault();
          setTravel(Math.max(0, (track.current?.clientWidth ?? 0) - THUMB));
          if (next >= 1) finish(1);
          else setFraction(next);
        }}
      >
        →
      </div>
    </div>
  );
}
