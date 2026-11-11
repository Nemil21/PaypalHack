import { describe, expect, it } from 'vitest';
import type { OrderTimelineFacts } from '@holdfast/shared';
import { orderTimelineGantt, phaseWhen, timelineFrom } from './order-timeline';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 17, 0, 0);
const iso = (h: number) => new Date(T0 + h * H).toISOString();

const facts: OrderTimelineFacts = {
  audience: 'brand',
  listingStatus: 'CLEARING',
  windowOpensAt: iso(0),
  windowClosesAt: iso(48),
  roundsStartedAt: null,
  roundsEndAt: null,
  clearByAt: iso(60),
  clearedAt: iso(49),
  cancelledAt: null,
  priceWatch: { on: true, events: 3, released: 0, lastEventAt: iso(4) },
  settlement: {
    total: 10,
    finished: 4,
    failed: 0,
    charged: 4,
    firstStartedAt: iso(49),
    lastFinishedAt: iso(49.001),
  },
  payout: null,
  shipping: null,
  asOf: iso(49.01),
};

describe('HF-060 order timeline → Gantt', () => {
  const now = new Date(T0 + 49.01 * H);
  const { phases, nowAt } = timelineFrom(facts, now);
  const g = orderTimelineGantt(phases, now);
  const task = (id: string) => g.tasks.find((t) => t.id === id)!;

  it('one row per phase, real dates on what happened, no bar for what has not', () => {
    expect(g.tasks.map((t) => t.id)).toEqual([
      'window',
      'priceWatch',
      'rounds',
      'lock',
      'capture',
      'payout',
      'shipping',
    ]);
    expect(task('window')).toMatchObject({ startDate: iso(0), endDate: iso(48), cls: 'hf-done' });
    expect(task('lock')).toMatchObject({ milestone: true, startDate: iso(49) });
    expect(task('rounds').unscheduled).toBe(true);
    expect(task('payout').unscheduled).toBe(true);
    expect(task('shipping').unscheduled).toBe(true);
  });

  it('the running fan-out reaches now and stays visible on a 49 h scale', () => {
    const c = task('capture');
    expect(c.cls).toContain('hf-active');
    expect(Date.parse(c.endDate)).toBeGreaterThanOrEqual(now.getTime());
    expect(Date.parse(c.endDate) - Date.parse(c.startDate)).toBeGreaterThan(0.01 * 49 * H);
  });

  it('Now marker and range cover the whole window', () => {
    expect(g.now).toBe(now.toISOString());
    expect(g.startDate).toBe(iso(0));
    expect(Date.parse(g.endDate)).toBeGreaterThanOrEqual(now.getTime());
    expect(nowAt).toBe(5);
  });

  it('list copy: planned milestones are labelled, open phases say "Since"', () => {
    const open = timelineFrom(
      { ...facts, listingStatus: 'OPEN', clearedAt: null, settlement: null },
      new Date(T0 + H),
    );
    const lock = open.phases.find((p) => p.key === 'lock')!;
    expect(phaseWhen(lock)).toMatch(/\(planned\)$/);
    expect(phaseWhen(phases.find((p) => p.key === 'capture')!)).toMatch(/^Since /);
  });
});
