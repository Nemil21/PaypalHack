import { describe, expect, it } from 'vitest';
import type { SettlementView } from '@holdfast/shared';
import { flattenTasks } from '../gantt';
import { fixtureViewAt, settlementFixture } from './fixture';
import { SETTLEMENT_GANTT_IDS, settlementGantt } from './gantt';

const fx = settlementFixture();
const last = fx.frames.length - 1;
const end = fixtureViewAt(fx, last);
const at = (v: SettlementView) => new Date(v.updatedAt);

describe('HF-060 W08 settlement Gantt', () => {
  it('one bar per settlement row, with the real started/finished times', () => {
    const g = settlementGantt(end, at(end));
    const bars = flattenTasks(g.tasks).filter((t) => !t.children && !t.milestone);
    expect(bars.map((b) => b.id).sort()).toEqual(end.rows.map((r) => r.settlementId).sort());
    for (const r of end.rows) {
      const b = bars.find((x) => x.id === r.settlementId)!;
      if (r.status === 'CANCELLED' && !r.startedAt) continue;
      expect(b.startDate).toBe(r.startedAt);
      expect(Date.parse(b.endDate)).toBeGreaterThanOrEqual(Date.parse(r.finishedAt!));
    }
  });

  it('draws the decline → promotion arrow on the unit root', () => {
    const g = settlementGantt(end, at(end));
    const failed = end.rows.find((r) => r.action === 'CAPTURE' && r.status === 'FAILED')!;
    const promoted = end.rows.find(
      (r) => r.action === 'CAPTURE' && r.unitRootBidId === failed.bidId && r.bidId !== failed.bidId,
    )!;
    const arrows = g.dependencies.filter((d) => d.cls === 'hf-dep-promotion');
    expect(arrows).toEqual([
      expect.objectContaining({ fromTask: failed.settlementId, toTask: promoted.settlementId }),
    ]);
    const bars = flattenTasks(g.tasks);
    expect(bars.find((t) => t.id === failed.settlementId)!.name).toBe(
      `${failed.shopperLabel} · Capture declined`,
    );
    const promo = bars.find((t) => t.id === promoted.settlementId)!;
    expect(promo.cls).toContain('hf-promoted');
    expect(promo.amount).toBe('$219');
    expect(promo.detail).toContain('at their own bid $219');
  });

  it('ends on the payout milestone at its completion time, after the captures', () => {
    const g = settlementGantt(end, at(end));
    const payout = g.tasks.at(-1)!;
    expect(payout.id).toBe(SETTLEMENT_GANTT_IDS.payout);
    expect(payout.milestone).toBe(true);
    expect(payout.name).toBe('Payout · Paid');
    expect(payout.startDate).toBe(end.payout!.completedAt);
    const captures = g.tasks.find((t) => t.id === SETTLEMENT_GANTT_IDS.captures)!;
    expect(Date.parse(payout.startDate)).toBeGreaterThanOrEqual(Date.parse(captures.endDate));
    expect(g.dependencies).toContainEqual(
      expect.objectContaining({ fromTask: 'captures', toTask: 'payout' }),
    );
    // Settled: no Now marker, range ends on the payout.
    expect(g.now).toBeNull();
    expect(g.endDate).toBe(payout.endDate);
  });

  it('mid-run: running bars grow to now, queued bars sit at now, payout waits', () => {
    const mid = fixtureViewAt(fx, 4);
    expect(mid.listingStatus).toBe('CLEARING');
    const now = new Date(Date.parse(mid.updatedAt) + 500);
    const g = settlementGantt(mid, now);
    expect(g.now).toBe(now.toISOString());
    const bars = flattenTasks(g.tasks);
    const running = mid.rows.find((r) => r.status === 'RUNNING');
    if (running) {
      const b = bars.find((t) => t.id === running.settlementId)!;
      expect(b.cls).toContain('hf-running');
      expect(Date.parse(b.endDate)).toBeGreaterThanOrEqual(now.getTime());
    }
    const queued = mid.rows.find((r) => r.status === 'QUEUED')!;
    const q = bars.find((t) => t.id === queued.settlementId)!;
    expect(q.cls).toContain('hf-queued');
    expect(q.startDate).toBe(now.toISOString());
    const payout = bars.find((t) => t.id === 'payout')!;
    expect(payout.name).toBe('Payout · Waiting for captures');
    expect(payout.amount).toBeUndefined();
  });

  it('copy: charged only for SUCCEEDED captures, released only for SUCCEEDED voids (D14)', () => {
    for (let i = -1; i <= last; i++) {
      const v = fixtureViewAt(fx, i);
      const bars = flattenTasks(settlementGantt(v, at(v)).tasks);
      for (const r of v.rows) {
        const name = bars.find((t) => t.id === r.settlementId)!.name;
        if (/Charged/.test(name)) expect([r.action, r.status]).toEqual(['CAPTURE', 'SUCCEEDED']);
        if (/· Released/.test(name)) expect([r.action, r.status]).toEqual(['VOID', 'SUCCEEDED']);
        expect(name).not.toMatch(/clearing price|everyone pays/i);
      }
    }
  });

  it('empty settlement: no groups, no payout', () => {
    const g = settlementGantt({ ...fx.initial, rows: [] }, at(fx.initial));
    expect(g.tasks).toEqual([]);
    expect(g.dependencies).toEqual([]);
  });
});
