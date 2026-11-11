import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedRefetch } from './refetch';

describe('createCoalescedRefetch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A fetch that takes `ms` to answer, counting calls. */
  function slowFetch(ms: number) {
    const fn = vi.fn(() => new Promise((r) => setTimeout(r, ms)));
    return fn;
  }

  it('a burst of 50 notices triggers at most a few refetches', async () => {
    const run = slowFetch(120);
    const r = createCoalescedRefetch(run);
    // 50 events over ~1 s (one every 20 ms), as `dev:bids --interval 0` or sim:stream bursts.
    for (let i = 0; i < 50; i++) {
      r.trigger();
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(run.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('50 simultaneous notices → exactly one refetch, 250 ms later', async () => {
    const run = slowFetch(10);
    const r = createCoalescedRefetch(run);
    for (let i = 0; i < 50; i++) r.trigger();
    await vi.advanceTimersByTimeAsync(249);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a steady stream still refetches every maxWait (KPIs keep moving)', async () => {
    const run = slowFetch(10);
    const r = createCoalescedRefetch(run, { debounceMs: 250, maxWaitMs: 1000 });
    for (let i = 0; i < 30; i++) {
      r.trigger();
      await vi.advanceTimersByTimeAsync(100); // faster than the debounce: never quiet
    }
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('never overlaps fetches; triggers during a fetch queue exactly one follow-up', async () => {
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 500));
      active--;
    });
    const r = createCoalescedRefetch(run);
    r.now();
    await vi.advanceTimersByTimeAsync(10);
    r.now();
    r.now();
    r.trigger();
    await vi.advanceTimersByTimeAsync(3000);
    expect(maxActive).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failed fetch does not stop later ones; cancel stops everything', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const r = createCoalescedRefetch(run);
    r.now();
    await vi.advanceTimersByTimeAsync(0);
    r.trigger();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    r.cancel();
    r.trigger();
    r.now();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
