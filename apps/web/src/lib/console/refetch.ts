/**
 * Debounced, coalesced refetch for the console (HF-023). SSE notices only say *what* changed
 * (HF-008), so every notice means "re-read the book". A burst of notices (50 SIM bids) must not
 * become 50 requests:
 *
 * - `trigger()` waits `debounceMs` (250 ms) of quiet before fetching; a steady stream still
 *   fetches at least every `maxWaitMs`, so KPIs keep moving during `sim:stream`;
 * - at most one fetch runs at a time; triggers during a fetch queue exactly one follow-up;
 * - `now()` fetches immediately (reconnect, retry), still coalesced with one in flight.
 */
export interface CoalescedRefetch {
  trigger(): void;
  now(): void;
  cancel(): void;
}

export interface RefetchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: RefetchTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export function createCoalescedRefetch(
  run: () => Promise<unknown>,
  opts: { debounceMs?: number; maxWaitMs?: number; timers?: RefetchTimers } = {},
): CoalescedRefetch {
  const debounceMs = opts.debounceMs ?? 250;
  const maxWaitMs = opts.maxWaitMs ?? 1000;
  const t = opts.timers ?? realTimers;

  let timer: unknown = null;
  let firstPendingAt: number | null = null;
  let inFlight = false;
  let again = false;
  let cancelled = false;

  const clearTimer = () => {
    if (timer !== null) t.clearTimeout(timer);
    timer = null;
  };

  const fire = () => {
    clearTimer();
    firstPendingAt = null;
    if (cancelled) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (again && !cancelled) {
          again = false;
          fire();
        }
      });
  };

  return {
    trigger() {
      if (cancelled) return;
      const at = t.now();
      firstPendingAt ??= at;
      clearTimer();
      const wait = Math.min(debounceMs, Math.max(0, firstPendingAt + maxWaitMs - at));
      timer = t.setTimeout(fire, wait);
    },
    now: fire,
    cancel() {
      cancelled = true;
      clearTimer();
    },
  };
}
