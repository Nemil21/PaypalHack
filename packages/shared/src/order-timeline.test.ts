import { describe, expect, it } from 'vitest';
import {
  nowIndex,
  ORDER_PHASE_KEYS,
  orderTimeline,
  type OrderPhase,
  type OrderTimelineFacts,
} from './order-timeline.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 17, 0, 0);
const iso = (h: number) => new Date(T0 + h * H).toISOString();

function facts(over: Partial<OrderTimelineFacts> = {}): OrderTimelineFacts {
  return {
    audience: 'brand',
    listingStatus: 'OPEN',
    windowOpensAt: iso(0),
    windowClosesAt: iso(48),
    roundsStartedAt: null,
    roundsEndAt: null,
    clearByAt: iso(60),
    clearedAt: null,
    cancelledAt: null,
    priceWatch: { on: true, events: 2, released: 1, lastEventAt: iso(5) },
    settlement: null,
    payout: null,
    shipping: null,
    asOf: iso(10),
    ...over,
  };
}

const byKey = (phases: OrderPhase[]) => Object.fromEntries(phases.map((p) => [p.key, p]));

/** A full brand lifecycle: rounds, Clear, fan-out with one decline, paid, shipping started. */
const settled = facts({
  listingStatus: 'PAID_OUT',
  roundsStartedAt: iso(48),
  roundsEndAt: iso(50),
  clearedAt: iso(51),
  settlement: {
    total: 14,
    finished: 14,
    failed: 1,
    charged: 8,
    firstStartedAt: iso(51.001),
    lastFinishedAt: iso(51.003),
  },
  payout: { status: 'SUCCESS', createdAt: iso(51.004), completedAt: iso(51.01) },
  shipping: { expected: 8, shipped: 3, firstShippedAt: iso(60), lastShippedAt: iso(62) },
  asOf: iso(63),
});

describe('HF-060 orderTimeline', () => {
  it('always returns the seven phases in order', () => {
    for (const f of [
      facts(),
      settled,
      facts({ listingStatus: 'CANCELLED', cancelledAt: iso(3) }),
    ]) {
      expect(orderTimeline(f, new Date(T0)).map((p) => p.key)).toEqual([...ORDER_PHASE_KEYS]);
    }
  });

  it('open window: active window with a planned close, Clear upcoming by clearByAt', () => {
    const p = byKey(orderTimeline(facts(), new Date(T0 + 10 * H)));
    expect(p.window).toMatchObject({ state: 'active', planned: true, endAt: iso(48) });
    expect(p.window!.detail).toMatch(/^Holds placed on PayPal\. Closes /);
    expect(p.priceWatch).toMatchObject({ state: 'active', startAt: iso(0) });
    expect(p.priceWatch!.detail).toBe('2 price checks · 1 hold released');
    expect(p.rounds!.state).toBe('skipped');
    expect(p.lock).toMatchObject({
      state: 'upcoming',
      milestone: true,
      planned: true,
      startAt: iso(60),
    });
    expect(p.capture!.state).toBe('upcoming');
    expect(p.payout!.state).toBe('upcoming');
    expect(p.shipping!.state).toBe('upcoming');
  });

  it('settled listing: every phase carries its real timestamps', () => {
    const p = byKey(orderTimeline(settled, new Date(T0 + 63 * H)));
    expect(p.window).toMatchObject({
      state: 'done',
      planned: false,
      startAt: iso(0),
      endAt: iso(48),
    });
    expect(p.priceWatch).toMatchObject({ state: 'done', endAt: iso(51) });
    expect(p.rounds).toMatchObject({ state: 'done', startAt: iso(48), endAt: iso(50) });
    expect(p.lock).toMatchObject({
      state: 'done',
      startAt: iso(51),
      endAt: iso(51),
      planned: false,
    });
    expect(p.capture).toMatchObject({
      state: 'done',
      startAt: iso(51.001),
      endAt: iso(51.003),
      detail: '14 of 14 PayPal calls settled · 1 decline',
    });
    expect(p.payout).toMatchObject({ state: 'done', startAt: iso(51.01), milestone: true });
    expect(p.shipping).toMatchObject({
      state: 'active',
      startAt: iso(60),
      endAt: null,
      detail: '3 of 8 units shipped',
    });
  });

  it('CLEARING: fan-out active, payout waits', () => {
    const f = facts({
      listingStatus: 'CLEARING',
      clearedAt: iso(49),
      settlement: {
        total: 5,
        finished: 2,
        failed: 0,
        charged: 2,
        firstStartedAt: iso(49),
        lastFinishedAt: iso(49),
      },
    });
    const p = byKey(orderTimeline(f, new Date(T0 + 49 * H)));
    expect(p.window!.state).toBe('done');
    expect(p.lock!.state).toBe('done');
    expect(p.capture).toMatchObject({ state: 'active', endAt: null, planned: true });
    expect(p.payout).toMatchObject({ state: 'upcoming', detail: 'After every capture' });
  });

  it('payout failed and nothing-to-pay states', () => {
    const failed = byKey(
      orderTimeline(
        {
          ...settled,
          listingStatus: 'PAYOUT_FAILED',
          payout: { status: 'FAILED', createdAt: iso(52), completedAt: null },
        },
        new Date(T0 + 63 * H),
      ),
    );
    expect(failed.payout).toMatchObject({ state: 'failed', startAt: iso(52) });
    const none = byKey(
      orderTimeline(
        {
          ...settled,
          listingStatus: 'SETTLED',
          payout: null,
          settlement: { ...settled.settlement!, charged: 0 },
        },
        new Date(T0 + 63 * H),
      ),
    );
    expect(none.payout!.state).toBe('skipped');
  });

  it('cancelled: window failed, everything after skipped', () => {
    const p = orderTimeline(
      facts({ listingStatus: 'CANCELLED', cancelledAt: iso(3) }),
      new Date(T0 + 4 * H),
    );
    expect(p[0]).toMatchObject({ key: 'window', state: 'failed', endAt: iso(3) });
    for (const k of ['lock', 'capture', 'payout', 'shipping'] as const) {
      expect(byKey(p)[k]!.state).toBe('skipped');
    }
  });

  it('price watch off: skipped with a plain reason', () => {
    const brand = byKey(
      orderTimeline(
        facts({ priceWatch: { on: false, events: 0, released: 0, lastEventAt: null } }),
        new Date(T0),
      ),
    );
    expect(brand.priceWatch).toMatchObject({
      state: 'skipped',
      detail: 'No public price to watch',
    });
  });

  describe('shopper audience', () => {
    const shopper = (over: Partial<OrderTimelineFacts>) =>
      byKey(orderTimeline({ ...settled, audience: 'shopper', ...over }, new Date(T0 + 63 * H)));

    it('won: charged their own bid, shipped', () => {
      const p = shopper({
        outcome: 'won',
        priceWatch: { on: true, events: 0, released: 0, lastEventAt: null },
        settlement: {
          total: 1,
          finished: 1,
          failed: 0,
          charged: 1,
          firstStartedAt: iso(51.001),
          lastFinishedAt: iso(51.002),
        },
        shipping: { expected: 1, shipped: 1, firstShippedAt: iso(60), lastShippedAt: iso(60) },
      });
      expect(p.lock!.detail).toBe('You won at your own bid');
      expect(p.capture).toMatchObject({
        label: 'Charge or release',
        state: 'done',
        detail: 'Charged your own bid',
      });
      expect(p.payout!.detail).toBe('The brand was paid');
      expect(p.shipping).toMatchObject({ state: 'done', detail: 'Shipped' });
    });

    it('lost: released, never charged; payout and shipping skipped', () => {
      const p = shopper({
        outcome: 'lost',
        settlement: {
          total: 1,
          finished: 1,
          failed: 0,
          charged: 0,
          firstStartedAt: iso(51.002),
          lastFinishedAt: iso(51.003),
        },
        shipping: null,
      });
      expect(p.capture!.detail).toBe('Hold released, never charged');
      expect(p.payout!.state).toBe('skipped');
      expect(p.shipping!.state).toBe('skipped');
    });

    it('declined at capture: failed, "not charged", nothing ships', () => {
      const p = shopper({
        outcome: 'declined',
        settlement: {
          total: 1,
          finished: 1,
          failed: 1,
          charged: 0,
          firstStartedAt: iso(51.001),
          lastFinishedAt: iso(51.002),
        },
      });
      expect(p.lock!.detail).toBe('You won at your own bid');
      expect(p.capture).toMatchObject({ state: 'failed' });
      expect(p.capture!.detail).toMatch(/not charged/);
      expect(p.payout!.state).toBe('skipped');
      expect(p.shipping!.state).toBe('skipped');
    });

    it('never says "charged" before a capture succeeded (D14)', () => {
      const open = orderTimeline({ ...facts(), audience: 'shopper' }, new Date(T0 + H));
      for (const ph of open) expect(ph.detail).not.toMatch(/\bcharged\b/i);
    });
  });

  it('nowIndex: after the last started phase', () => {
    expect(nowIndex(orderTimeline(facts(), new Date(T0 + H)), new Date(T0 + H))).toBe(2);
    expect(nowIndex(orderTimeline(settled, new Date(T0 + 63 * H)), new Date(T0 + 63 * H))).toBe(7);
  });
});
