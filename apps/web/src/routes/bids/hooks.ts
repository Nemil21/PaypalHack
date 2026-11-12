import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { subscribeBidEvents } from '../../lib/listing-events';

/** `Date.now()`, re-rendered every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** Call `fn` every `ms` while `active` and the tab is visible (D18: 5 s polling in ROUNDS). */
export function usePolling(active: boolean, ms: number, fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') ref.current();
    }, ms);
    return () => window.clearInterval(id);
  }, [active, ms]);
}

/**
 * W15 (v4 §4.1): follow the bid's own SSE stream (`GET /api/bids/:id/events`) and call
 * `onChange` (debounced) on every notice and after a reconnect. Returns whether the stream is
 * open, so the page can fall back to polling while it is not.
 */
export function useBidStream(bidId: string, enabled: boolean, onChange: () => void): boolean {
  const [open, setOpen] = useState(false);
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    if (!enabled || !bidId || typeof EventSource === 'undefined') return;
    let timer: number | undefined;
    const kick = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => ref.current(), 250);
    };
    const stop = subscribeBidEvents(bidId, {
      onEvent: kick,
      onReconnect: kick,
      onStatus: (s) => setOpen(s === 'open'),
    });
    return () => {
      window.clearTimeout(timer);
      stop();
      setOpen(false);
    };
  }, [bidId, enabled]);
  return open;
}

/** Past this many px left, a released swipe opens the cancel confirm (M03). */
export const SWIPE_OPEN_PX = 80;
/** Past this many px down at the top of the page, releasing refreshes (M03). */
export const PULL_REFRESH_PX = 70;

/**
 * Swipe left on a touch card (M03 "swipe left = cancel with confirm"). Horizontal moves only:
 * a mostly vertical drag is a scroll and is left alone. Returns the live offset and handlers.
 */
export function useSwipeLeft(enabled: boolean, onSwiped: () => void) {
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  const [dx, setDx] = useState(0);
  const handlers = {
    onTouchStart(e: TouchEvent) {
      if (!enabled) return;
      const t = e.touches[0]!;
      start.current = { x: t.clientX, y: t.clientY, horizontal: null };
    },
    onTouchMove(e: TouchEvent) {
      const s = start.current;
      if (!s) return;
      const t = e.touches[0]!;
      const mx = t.clientX - s.x;
      const my = t.clientY - s.y;
      if (s.horizontal === null && Math.abs(mx) + Math.abs(my) > 8) {
        s.horizontal = Math.abs(mx) > Math.abs(my);
      }
      if (s.horizontal) setDx(Math.max(-140, Math.min(0, mx)));
    },
    onTouchEnd() {
      const swiped = dx <= -SWIPE_OPEN_PX;
      start.current = null;
      setDx(0);
      if (swiped) onSwiped();
    },
  };
  return { dx, handlers };
}

/** Pull-to-refresh on the page (M03): drag down from the very top, release past the threshold. */
export function usePullToRefresh(onRefresh: () => Promise<unknown>) {
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const handlers = {
    onTouchStart(e: TouchEvent) {
      startY.current = window.scrollY <= 0 && !refreshing ? e.touches[0]!.clientY : null;
    },
    onTouchMove(e: TouchEvent) {
      if (startY.current === null) return;
      const d = e.touches[0]!.clientY - startY.current;
      setPull(d > 0 ? Math.min(120, d * 0.6) : 0);
    },
    onTouchEnd() {
      const go = pull >= PULL_REFRESH_PX * 0.6;
      startY.current = null;
      setPull(0);
      if (go) {
        setRefreshing(true);
        void onRefresh().finally(() => setRefreshing(false));
      }
    },
  };
  return { pull, refreshing, handlers };
}
