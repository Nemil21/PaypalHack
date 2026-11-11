import { describe, expect, it } from 'vitest';
import type { ConsoleKpis } from '../../lib/console/kpis';
import { createKpiStore, kpiTile } from './KpiTiles';

const k: ConsoleKpis = {
  heldCents: 6_120_000,
  simulatedHeldCents: 124_000,
  liveBids: 281,
  quantity: 240,
  cutoffCents: 21_900,
  grossCents: 5_424_000,
  winners: 240,
  recoveryMultiple: 5.95,
  hasLiquidationQuote: true,
  releasedByPriceWatch: 3,
};

describe('kpiTile', () => {
  it('Held demand shows "incl. $X simulated" as caption and on hover', () => {
    const t = kpiTile('held', k);
    expect(t).toMatchObject({ label: 'Held demand', value: '$61.2k', emphasis: true });
    expect(t.caption).toBe('incl. $1,240 simulated');
    expect(t.hover).toBe('$61,200 held · incl. $1,240 simulated');
    expect(kpiTile('held', { ...k, simulatedHeldCents: 0 }).hover).toBeUndefined();
  });

  it('projected cutoff + gross, recovery ×, released count', () => {
    expect(kpiTile('projected', k)).toMatchObject({
      label: 'Projected cutoff',
      value: '$219',
      caption: 'At 240 units: $54.2k gross from 240 winners',
    });
    expect(kpiTile('recovery', k).value).toBe('×6.0');
    expect(kpiTile('recovery', { ...k, recoveryMultiple: null, winners: 0 }).caption).toBe(
      'Shown once bids clear the floor',
    );
    expect(
      kpiTile('recovery', { ...k, recoveryMultiple: null, hasLiquidationQuote: false }).caption,
    ).toBe('No liquidation quote');
    expect(kpiTile('released', k).value).toBe('3');
    expect(kpiTile('bids', k).value).toBe('281');
  });
});

describe('createKpiStore', () => {
  it('notifies subscribers and unsubscribes', () => {
    const s = createKpiStore();
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.set(k);
    expect(s.get()).toBe(k);
    off();
    s.set(null);
    expect(calls).toBe(1);
  });
});
