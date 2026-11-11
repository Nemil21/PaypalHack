import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookResponse } from '@holdfast/shared';
import {
  amountLabel,
  armRaiseExpiry,
  compareRank,
  createBidRowTracker,
  heldBySource,
  RAISE_FLASH_MS,
  rankLabel,
  sourceLabel,
  type BidRow,
} from './bids-grid';
import { bookFromInput, clearInput, heldBid } from './book.fixtures';

interface B {
  id: string;
  cents: number;
  /** Shopper label number; stable per shopper like the server's. */
  shopper: number;
  sim?: boolean;
}

const FLOOR = 19_900;

/** A `/book` body for these bids, with per-shopper labels (the fixture numbers by position). */
function book(bids: B[], floorCents = FLOOR): BookResponse {
  const input = clearInput(
    bids.map((b, i) =>
      heldBid(i, b.cents, {
        id: b.id,
        shopperId: `s${b.shopper}`,
        isSimulated: b.sim ?? false,
      }),
    ),
    10,
    floorCents,
  );
  const body = bookFromInput(input);
  const byId = new Map(bids.map((b) => [b.id, b]));
  return {
    ...body,
    bids: body.bids.map((r) => ({
      ...r,
      shopperLabel: `Shopper #${1000 + byId.get(r.id)!.shopper}`,
      source: byId.get(r.id)!.sim ? 'SIM' : 'OFFER_PAGE',
    })),
  };
}

const T0 = 1_000_000;

describe('createBidRowTracker', () => {
  it('first book: every bid is an add, keyed by bid id', () => {
    const t = createBidRowTracker();
    const d = t.apply(
      book([
        { id: 'a', cents: 24_100, shopper: 1 },
        { id: 'b', cents: 21_900, shopper: 2, sim: true },
      ]),
      T0,
    );
    expect(d.add.map((r) => r.rowId)).toEqual(['a', 'b']);
    expect(d.update).toEqual([]);
    expect(d.remove).toEqual([]);
    expect(d.add[0]).toMatchObject({ rank: 1, status: 'held', source: 'OFFER_PAGE' });
    expect(d.add[1]).toMatchObject({
      isSimulated: true,
      source: 'SIM',
      shopperLabel: 'Shopper #1002',
    });
  });

  it('a new bid is added; existing rows only update when something changed (rank shifts)', () => {
    const t = createBidRowTracker();
    t.apply(book([{ id: 'a', cents: 22_000, shopper: 1 }]), T0);
    const d = t.apply(
      book([
        { id: 'a', cents: 22_000, shopper: 1 },
        { id: 'b', cents: 25_000, shopper: 2 },
      ]),
      T0 + 1,
    );
    expect(d.add.map((r) => r.rowId)).toEqual(['b']);
    expect(d.update.map((r) => [r.rowId, r.rank])).toEqual([['a', 2]]);
    expect(
      t.apply(
        book([
          { id: 'a', cents: 22_000, shopper: 1 },
          { id: 'b', cents: 25_000, shopper: 2 },
        ]),
        T0 + 2,
      ),
    ).toEqual({
      add: [],
      update: [],
      remove: [],
      raised: [],
    });
  });

  it('a voided bid (gone from the book) is removed', () => {
    const t = createBidRowTracker();
    t.apply(
      book([
        { id: 'a', cents: 22_000, shopper: 1 },
        { id: 'b', cents: 25_000, shopper: 2 },
      ]),
      T0,
    );
    const d = t.apply(book([{ id: 'b', cents: 25_000, shopper: 2 }]), T0 + 1);
    expect(d.remove.map((r) => r.rowId)).toEqual(['a']);
    expect(d.add).toEqual([]);
    expect(t.rows().map((r) => r.rowId)).toEqual(['b']);
  });

  it('a raise (bid.raised notice first) updates the same row in place with old → new', () => {
    const t = createBidRowTracker();
    t.apply(book([{ id: 'a', cents: 21_900, shopper: 1 }]), T0);
    t.noteRaise('a2', 'a');
    const d = t.apply(book([{ id: 'a2', cents: 24_100, shopper: 1 }]), T0 + 10);
    expect(d.add).toEqual([]);
    expect(d.remove).toEqual([]);
    expect(d.raised).toEqual(['a']);
    expect(d.update).toHaveLength(1);
    expect(d.update[0]).toMatchObject({
      rowId: 'a',
      bidId: 'a2',
      amountCents: 24_100,
      raisedFromCents: 21_900,
      raisedUntil: T0 + 10 + RAISE_FLASH_MS,
    });
    expect(amountLabel(d.update[0]!)).toBe('$219 → $241');
  });

  it('a raise whose notice was missed (reconnect) still keeps its row, by shopper label', () => {
    const t = createBidRowTracker();
    t.apply(
      book([
        { id: 'a', cents: 21_900, shopper: 1 },
        { id: 'b', cents: 23_000, shopper: 2 },
      ]),
      T0,
    );
    const d = t.apply(
      book([
        { id: 'a2', cents: 24_100, shopper: 1 },
        { id: 'b', cents: 23_000, shopper: 2 },
      ]),
      T0 + 1,
    );
    expect(d.add).toEqual([]);
    expect(d.remove).toEqual([]);
    expect(d.raised).toEqual(['a']);
    expect(t.rows().find((r) => r.rowId === 'a')).toMatchObject({
      bidId: 'a2',
      amountCents: 24_100,
    });
  });

  it('race: the book with the old bid VOIDING and the new one not yet HELD drops the row, the raise brings it back as one add', () => {
    // Between the raise's two halves the book can briefly lack both (old voiding, new pending).
    const t = createBidRowTracker();
    t.apply(
      book([
        { id: 'a', cents: 21_900, shopper: 1 },
        { id: 'b', cents: 23_000, shopper: 2 },
      ]),
      T0,
    );
    const gap = t.apply(book([{ id: 'b', cents: 23_000, shopper: 2 }]), T0 + 1);
    expect(gap.remove.map((r) => r.rowId)).toEqual(['a']);
    t.noteRaise('a2', 'a');
    const d = t.apply(
      book([
        { id: 'a2', cents: 24_100, shopper: 1 },
        { id: 'b', cents: 23_000, shopper: 2 },
      ]),
      T0 + 2,
    );
    expect(d.add.map((r) => r.bidId)).toEqual(['a2']);
    expect(d.remove).toEqual([]);
  });

  it('chained raises keep one row; a notice for an unseen bid is ignored until it lands', () => {
    const t = createBidRowTracker();
    t.apply(book([{ id: 'a', cents: 20_000, shopper: 1 }]), T0);
    t.noteRaise('a2', 'a');
    t.noteRaise('a3', 'a2');
    // Both raises landed between two refetches: only a3 is in the book.
    const d = t.apply(book([{ id: 'a3', cents: 26_000, shopper: 1 }]), T0 + 1);
    expect(d.update[0]).toMatchObject({ rowId: 'a', bidId: 'a3', raisedFromCents: 20_000 });
    t.noteRaise('a4', 'a3');
    const d2 = t.apply(book([{ id: 'a4', cents: 27_000, shopper: 1 }]), T0 + 2);
    expect(d2.update[0]).toMatchObject({ rowId: 'a', bidId: 'a4', raisedFromCents: 26_000 });
    expect(d2.add).toEqual([]);
  });

  it('the raise flash expires; unrelated refetches keep it until then', () => {
    const t = createBidRowTracker();
    t.apply(book([{ id: 'a', cents: 21_900, shopper: 1 }]), T0);
    t.noteRaise('a2', 'a');
    t.apply(book([{ id: 'a2', cents: 24_100, shopper: 1 }]), T0);
    expect(t.nextRaiseExpiry()).toBe(T0 + RAISE_FLASH_MS);

    const mid = t.apply(
      book([
        { id: 'a2', cents: 24_100, shopper: 1 },
        { id: 'c', cents: 20_000, shopper: 3 },
      ]),
      T0 + 1_000,
    );
    expect(mid.update).toEqual([]);
    expect(t.rows().find((r) => r.rowId === 'a')!.raisedFromCents).toBe(21_900);

    expect(t.expireRaises(T0 + RAISE_FLASH_MS - 1)).toEqual([]);
    const done = t.expireRaises(T0 + RAISE_FLASH_MS);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ rowId: 'a', raisedFromCents: null, raisedUntil: null });
    expect(amountLabel(done[0]!)).toBe('$241');
    expect(t.nextRaiseExpiry()).toBeNull();
  });

  it('a lower replacement (cancel and re-bid) keeps the row without a raise flash', () => {
    const t = createBidRowTracker();
    t.apply(book([{ id: 'a', cents: 24_000, shopper: 1 }]), T0);
    const d = t.apply(book([{ id: 'a2', cents: 22_000, shopper: 1 }]), T0 + 1);
    expect(d.raised).toEqual([]);
    expect(d.update[0]).toMatchObject({ rowId: 'a', bidId: 'a2', raisedFromCents: null });
  });

  it('below-floor bids have no rank and read "below floor"', () => {
    const t = createBidRowTracker();
    const d = t.apply(
      book([
        { id: 'a', cents: 21_000, shopper: 1 },
        { id: 'low', cents: 18_000, shopper: 2 },
      ]),
      T0,
    );
    const low = d.add.find((r) => r.rowId === 'low')!;
    expect(low).toMatchObject({ rank: null, belowFloor: true });
    expect(rankLabel(low)).toBe('below floor');
    expect(rankLabel(d.add.find((r) => r.rowId === 'a')!)).toBe('1');
  });

  it('reset forgets rows (a remounted grid re-adds them) but keeps pending raise aliases', () => {
    const t = createBidRowTracker();
    t.apply(book([{ id: 'a', cents: 21_900, shopper: 1 }]), T0);
    t.noteRaise('a2', 'a');
    t.reset();
    expect(t.rows()).toEqual([]);
    const d = t.apply(book([{ id: 'a2', cents: 24_100, shopper: 1 }]), T0 + 1);
    expect(d.add.map((r) => r.rowId)).toEqual(['a2']);
  });

  it('placed time is converted from µs to ms exactly', () => {
    const t = createBidRowTracker();
    const b = book([{ id: 'a', cents: 21_900, shopper: 1 }]);
    b.bids[0]!.placedAtUs = '1762862400123456';
    expect(t.apply(b, T0).add[0]!.placedAtMs).toBe(1_762_862_400_123);
  });

  it('5k-bid book diff is cheap (5k-row grids apply deltas, not resets)', () => {
    const many: B[] = Array.from({ length: 5_000 }, (_, i) => ({
      id: `b${i}`,
      cents: 20_000 + (i % 700) * 10,
      shopper: i,
    }));
    const t = createBidRowTracker();
    t.apply(book(many), T0);
    const next = book([...many, { id: 'new', cents: 30_000, shopper: 9_999 }]);
    const start = performance.now();
    const d = t.apply(next, T0 + 1);
    expect(performance.now() - start).toBeLessThan(100);
    expect(d.add.map((r) => r.rowId)).toEqual(['new']);
  });
});

describe('labels and helpers', () => {
  it('source labels', () => {
    expect(
      ['OFFER_PAGE', 'BUYER_AGENT', 'MCP', 'SIM', null].map((s) => sourceLabel(s as never)),
    ).toEqual(['Offer page', 'Agent', 'MCP', 'SIM', 'Other']);
  });

  it('rank order: ranked first, then below floor by amount', () => {
    const rows = [
      { rank: null, amountCents: 18_000 },
      { rank: 2, amountCents: 22_000 },
      { rank: null, amountCents: 19_000 },
      { rank: 1, amountCents: 25_000 },
    ];
    expect([...rows].sort(compareRank).map((r) => r.amountCents)).toEqual([
      25_000, 22_000, 19_000, 18_000,
    ]);
  });

  it('held by source, largest first, with SIM counts', () => {
    const row = (source: BidRow['source'], cents: number, sim = false) =>
      ({ source, amountCents: cents, isSimulated: sim }) as BidRow;
    expect(
      heldBySource([
        row('SIM', 20_000, true),
        row('OFFER_PAGE', 25_000),
        row('SIM', 21_000, true),
        row('MCP', 1_000),
      ]),
    ).toEqual([
      { source: 'SIM', label: 'SIM', count: 2, heldCents: 41_000, simulated: 2 },
      { source: 'OFFER_PAGE', label: 'Offer page', count: 1, heldCents: 25_000, simulated: 0 },
      { source: 'MCP', label: 'MCP', count: 1, heldCents: 1_000, simulated: 0 },
    ]);
  });
});

describe('armRaiseExpiry', () => {
  afterEach(() => vi.useRealTimers());

  it('staggered raises each clear on time with no new book (the timer re-arms)', () => {
    vi.useFakeTimers({ now: T0 });
    const t = createBidRowTracker();
    t.apply(
      book([
        { id: 'a', cents: 21_900, shopper: 1 },
        { id: 'b', cents: 22_000, shopper: 2 },
      ]),
      Date.now(),
    );
    const cleared: string[][] = [];
    const onExpired = (rows: BidRow[]) => cleared.push(rows.map((r) => r.rowId));

    // Raise A at t=0; the grid arms on that book.
    t.noteRaise('a2', 'a');
    t.apply(
      book([
        { id: 'a2', cents: 24_100, shopper: 1 },
        { id: 'b', cents: 22_000, shopper: 2 },
      ]),
      Date.now(),
    );
    let cancel = armRaiseExpiry(t, onExpired);

    // Raise B at t=1s; the grid re-arms on the new book (cancelling the old timer).
    vi.advanceTimersByTime(1_000);
    t.noteRaise('b2', 'b');
    t.apply(
      book([
        { id: 'a2', cents: 24_100, shopper: 1 },
        { id: 'b2', cents: 25_000, shopper: 2 },
      ]),
      Date.now(),
    );
    cancel();
    cancel = armRaiseExpiry(t, onExpired);

    vi.advanceTimersByTime(RAISE_FLASH_MS - 1_000 + 50); // ≈ 4 s: A clears
    expect(cleared).toEqual([['a']]);
    vi.advanceTimersByTime(1_000); // ≈ 5 s: B clears, with no new book in between
    expect(cleared).toEqual([['a'], ['b']]);
    expect(t.rows().every((r) => r.raisedFromCents === null)).toBe(true);
    expect(t.nextRaiseExpiry()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    cancel();
  });

  it('cancel stops the pending timer', () => {
    vi.useFakeTimers({ now: T0 });
    const t = createBidRowTracker();
    t.apply(book([{ id: 'a', cents: 21_900, shopper: 1 }]), Date.now());
    t.noteRaise('a2', 'a');
    t.apply(book([{ id: 'a2', cents: 24_100, shopper: 1 }]), Date.now());
    const onExpired = vi.fn();
    const cancel = armRaiseExpiry(t, onExpired);
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    vi.advanceTimersByTime(RAISE_FLASH_MS * 2);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
