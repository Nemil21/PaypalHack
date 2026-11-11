import { describe, expect, it } from 'vitest';
import { parseListingEvent, type SettlementRow, type SettlementView } from '@holdfast/shared';
import { applySettlementEvent, fixtureViewAt, settlementFixture } from './fixture';
import type { LOG_FILTERS } from './model';
import {
  countsFromRows,
  doneFraction,
  logRows,
  matchesFilter,
  partialNote,
  payoutCard,
  progressBars,
  settlementPhase,
} from './model';

const fx = settlementFixture();
const last = fx.frames.length - 1;
const end = fixtureViewAt(fx, last);

/** Every string the screen derives from a view. */
function allCopy(v: SettlementView): string[] {
  const card = payoutCard(v);
  return [
    ...progressBars(v).flatMap((b) => [b.label, b.caption]),
    ...logRows(v).flatMap((r) => [r.action, r.note ?? '']),
    card.headline,
    card.statusLabel,
    card.detail ?? '',
    card.feeLabel,
    partialNote(v) ?? '',
  ];
}

describe('HF-035 fixture stream', () => {
  it('every frame is a valid shared ListingEvent', () => {
    for (const f of fx.frames) expect(() => parseListingEvent(f.event)).not.toThrow();
  });

  it('counts match the settlement rows at every frame and at the end', () => {
    for (let i = 0; i <= last; i++) {
      const v = fixtureViewAt(fx, i);
      expect(v.counts).toEqual(countsFromRows(v.rows));
    }
    expect(end.counts).toMatchObject({
      total: 14,
      captured: 7,
      capturePending: 1,
      released: 4,
      failed: 1,
      promoted: 1,
      cancelled: 1,
      queued: 0,
      running: 0,
    });
    expect(end.listingStatus).toBe('PAID_OUT');
    expect(doneFraction(end)).toBe(1);
  });

  it('phase goes running → promoting → running → done', () => {
    const phases = fx.frames.map((_, i) => settlementPhase(fixtureViewAt(fx, i)));
    const seq = phases.filter((p, i) => i === 0 || p !== phases[i - 1]);
    expect(seq).toEqual(['running', 'promoting', 'running', 'done']);
  });
});

describe('HF-035 log rows', () => {
  const rows = logRows(end);
  const promoted = rows.find((r) => r.promoted)!;
  const failed = rows.find((r) => r.kind === 'capture-failed')!;

  it('the promoted row links to the failed winner and shows the promoted bid amount', () => {
    expect(promoted).toMatchObject({
      shopperLabel: 'Shopper #241',
      amountCents: 21_900,
      linkedBidId: failed.bidId,
      highlight: true,
      action: 'Charged',
    });
    expect(promoted.note).toBe(
      'Decline → promoted Shopper #241 at their own bid $219 (replaces Shopper #207)',
    );
    expect(failed).toMatchObject({ shopperLabel: 'Shopper #207', linkedBidId: promoted.bidId });
    expect(failed.note).toBe('Decline → promoted Shopper #241 at their own bid $219');
    expect(failed.action).toBe('Capture declined');
  });

  it('falls back to unit_root_bid_id when promotedFromBidId is missing', () => {
    const v: SettlementView = {
      ...end,
      rows: end.rows.map((r) => ({ ...r, promotedFromBidId: null })),
    };
    const p = logRows(v).find((r) => r.promoted)!;
    expect(p.linkedBidId).toBe('bid-207');
  });

  it('"charged" only for SUCCEEDED captures, "released" only for SUCCEEDED voids', () => {
    for (let i = 0; i <= last; i++) {
      const v = fixtureViewAt(fx, i);
      const byId = new Map(v.rows.map((r) => [r.settlementId, r] as const));
      for (const r of logRows(v)) {
        const src = byId.get(r.settlementId)!;
        if (/charged/i.test(r.action)) {
          expect(src).toMatchObject({ action: 'CAPTURE', status: 'SUCCEEDED' });
        }
        if (/released/i.test(r.action)) {
          expect(src).toMatchObject({ action: 'VOID', status: 'SUCCEEDED' });
        }
        if (src.action === 'CAPTURE' && src.status === 'SUCCEEDED') {
          expect(r.action).toBe(src.paypalStatus === 'PENDING' ? 'Charged (pending)' : 'Charged');
        }
      }
    }
    expect(rows.find((r) => r.shopperLabel === 'Shopper #219')!.action).toBe('Charged (pending)');
  });

  it('no uniform-price wording anywhere (D14)', () => {
    for (let i = 0; i <= last; i++) {
      for (const s of allCopy(fixtureViewAt(fx, i))) {
        expect(s).not.toMatch(
          /clearing price|uniform|same price|one price|everyone pays|single price/i,
        );
      }
    }
  });

  it('filters partition the log sensibly', () => {
    const count = (k: (typeof LOG_FILTERS)[number]['key']) =>
      rows.filter((r) => matchesFilter(r, k)).length;
    expect(count('all')).toBe(rows.length);
    expect(count('charges')).toBe(8);
    expect(count('problems')).toBe(1);
    expect(count('promotions')).toBe(3); // the failed winner, the promoted capture, its claimed void
    expect(count('releases')).toBe(5);
  });

  it('newest activity first, queued rows last', () => {
    const mid = logRows(fixtureViewAt(fx, 5));
    const firstQueued = mid.findIndex((r) => r.at === null);
    expect(firstQueued).toBeGreaterThan(0);
    expect(mid.slice(firstQueued).every((r) => r.at === null)).toBe(true);
    const timed = mid.slice(0, firstQueued).map((r) => r.at!);
    expect([...timed].sort().reverse()).toEqual(timed);
  });
});

describe('HF-035 progress and payout card', () => {
  it('bars at the end of the run', () => {
    const bars = Object.fromEntries(progressBars(end).map((b) => [b.key, b]));
    expect(bars.captured).toMatchObject({ value: 8, total: 8 });
    expect(bars.captured!.caption).toBe('7 charged · 1 charged (pending) of 8 units');
    expect(bars.released).toMatchObject({ value: 4, total: 4 });
    expect(bars.failed).toMatchObject({ value: 1 });
    expect(bars.promoted).toMatchObject({ value: 1, total: 1 });
    expect(bars.promoted!.caption).toBe('1 of 1 promoted bid charged at their own bid');
  });

  it('payout status follows payout.updated: waiting → pending → succeeded', () => {
    const states = fx.frames.map((_, i) => payoutCard(fixtureViewAt(fx, i)).state);
    expect(states.filter((s, i) => i === 0 || s !== states[i - 1])).toEqual([
      'waiting',
      'pending',
      'succeeded',
    ]);
    const card = payoutCard(end);
    const gross = end.capturedCents;
    expect(card).toMatchObject({
      headline: `Cleared $1,838 · Captured $1,828`,
      feeCents: Math.round(gross * 0.09),
      netCents: gross - Math.round(gross * 0.09),
      statusLabel: 'Paid',
      estimate: false,
    });
  });

  it('a failed payout offers the admin retry', () => {
    const settled = fixtureViewAt(
      fx,
      fx.frames.findIndex((f) => f.event.type === 'payout.updated'),
    );
    const failed = applySettlementEvent(settled, {
      type: 'payout.updated',
      listingId: settled.listingId,
      at: new Date().toISOString(),
      payout: {
        ...settled.payout!,
        status: 'FAILED',
        itemStatus: 'UNCLAIMED',
        failureReason: 'The receiver has not claimed it.',
      },
    });
    expect(failed.listingStatus).toBe('PAYOUT_FAILED');
    expect(payoutCard(failed)).toMatchObject({
      state: 'failed',
      retryable: true,
      detail: 'The receiver has not claimed it.',
    });
  });

  it('partial: unfilled units are called out; nothing captured means nothing to pay', () => {
    expect(partialNote(end)).toBeNull();
    expect(partialNote({ ...end, unfilledUnits: 2 })).toBe(
      '2 units went unfilled: 6 of 8 sold. The payout covers only what was charged.',
    );
    const none: SettlementView = {
      ...end,
      listingStatus: 'SETTLED',
      capturedCents: 0,
      payout: null,
      rows: [] as SettlementRow[],
    };
    expect(payoutCard(none)).toMatchObject({ state: 'nothing', statusLabel: 'Nothing to pay' });
  });
});
