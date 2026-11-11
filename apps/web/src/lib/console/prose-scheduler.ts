/**
 * When to ask Claude to explain the recommendation (HF-051b, the prose under the W06 card).
 *
 * The recommendation's key (`explainKey`) changes with almost every bid above the cutoff, and each
 * explain call spends a slot in the brand user's `agent` rate bucket (20/min), which the Ask panel
 * shares. So a key must be **stable for `settleMs`** before it is explained, and requests are at
 * least **`minIntervalMs` apart**: a live bid burst costs one call, not one per bid, and never
 * starves the brand's own questions. An answer is shown only while its key is still the current
 * one, so the prose never quotes numbers the card no longer shows. No React: the hook drives it.
 */

export const PROSE_SETTLE_MS = 4_000;
export const PROSE_MIN_INTERVAL_MS = 30_000;

export interface ProseSchedulerOptions {
  /** One explain request; resolves to the prose, or null (Claude down, unverified numbers). */
  explain: (key: string) => Promise<string | null>;
  /** Called with the prose for the current key, or null when there is none (yet). */
  onProse: (text: string | null) => void;
  settleMs?: number;
  minIntervalMs?: number;
  now?: () => number;
}

export interface ProseScheduler {
  /** The current recommendation key (null: nothing to explain). */
  update(key: string | null): void;
  dispose(): void;
}

export function createProseScheduler(opts: ProseSchedulerOptions): ProseScheduler {
  const settleMs = opts.settleMs ?? PROSE_SETTLE_MS;
  const minIntervalMs = opts.minIntervalMs ?? PROSE_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  /** Real answers only: "unavailable" may recover on a later key. */
  const cache = new Map<string, string>();
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = -Infinity;
  let disposed = false;

  const fire = (key: string) => {
    timer = undefined;
    if (disposed || key !== current) return;
    lastSentAt = now();
    opts.explain(key).then(
      (text) => {
        if (text) cache.set(key, text);
        if (!disposed && key === current) opts.onProse(text);
      },
      () => {
        if (!disposed && key === current) opts.onProse(null);
      },
    );
  };

  return {
    update(key) {
      if (key === current) return;
      current = key;
      clearTimeout(timer);
      timer = undefined;
      if (!key) return opts.onProse(null);
      const cached = cache.get(key);
      if (cached) return opts.onProse(cached);
      // The old prose describes another recommendation: hide it until this one is explained.
      opts.onProse(null);
      const wait = Math.max(settleMs, lastSentAt + minIntervalMs - now());
      timer = setTimeout(() => fire(key), wait);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
