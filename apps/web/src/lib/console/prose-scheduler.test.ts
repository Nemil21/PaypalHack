import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProseScheduler } from './prose-scheduler';

describe('prose scheduler (explain under the W06 card)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const asked: string[] = [];
    const shown: (string | null)[] = [];
    const s = createProseScheduler({
      explain: async (key) => {
        asked.push(key);
        return `prose for ${key}`;
      },
      onProse: (t) => shown.push(t),
      settleMs: 4_000,
      minIntervalMs: 30_000,
      now: () => Date.now(),
    });
    return { s, asked, shown };
  }

  it('a burst of key changes (one per bid) makes one request, for the settled key', async () => {
    const { s, asked, shown } = setup();
    for (let i = 0; i < 50; i++) {
      s.update(`l:240:21900:${5_400_000 + i * 100}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(asked).toEqual(['l:240:21900:5404900']);
    expect(shown.at(-1)).toBe('prose for l:240:21900:5404900');
  });

  it('settled keys are explained at most once per 30 s', async () => {
    const { s, asked } = setup();
    s.update('a');
    await vi.advanceTimersByTimeAsync(4_000);
    s.update('b');
    await vi.advanceTimersByTimeAsync(10_000);
    s.update('c');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toEqual(['a', 'c']);
  });

  it('hides stale prose, reuses cached prose, and drops an answer for a superseded key', async () => {
    let resolve!: (t: string) => void;
    const shown: (string | null)[] = [];
    const asked: string[] = [];
    const s = createProseScheduler({
      explain: (key) => {
        asked.push(key);
        return new Promise((r) => (resolve = r));
      },
      onProse: (t) => shown.push(t),
      settleMs: 1_000,
      minIntervalMs: 0,
    });
    s.update('a');
    await vi.advanceTimersByTimeAsync(1_000);
    s.update('b');
    resolve('prose a');
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([null, null]);
    s.update('a');
    expect(shown.at(-1)).toBe('prose a');
    expect(asked).toEqual(['a']);
    s.update(null);
    expect(shown.at(-1)).toBeNull();
    s.dispose();
  });

  it('an unavailable answer (null) is not cached', async () => {
    const asked: string[] = [];
    const s = createProseScheduler({
      explain: async (key) => {
        asked.push(key);
        return null;
      },
      onProse: () => {},
      settleMs: 0,
      minIntervalMs: 0,
    });
    s.update('a');
    await vi.advanceTimersByTimeAsync(0);
    s.update('b');
    s.update('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual(['a', 'a']);
  });
});
