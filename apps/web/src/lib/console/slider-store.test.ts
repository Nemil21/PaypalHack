import { describe, expect, it, vi } from 'vitest';
import { clear, clearBidsFromBook } from '@holdfast/shared';
import { bookFromInput, clearInput, heldBid } from './book.fixtures';
import { bidWouldWin, createSliderStore } from './slider-store';

const amounts = [25_900, 23_900, 23_900, 21_900, 19_900, 15_000];
const bookOf = (n: number, quantity = 4, targetQuantity: number | null = null) =>
  bookFromInput(
    clearInput(
      amounts.slice(0, n).map((a, i) => heldBid(i, a)),
      quantity,
    ),
    { targetQuantity },
  );

describe('slider store', () => {
  it('starts at the listing quantity with the exact clear() result', () => {
    const s = createSliderStore();
    const book = bookOf(6);
    s.setBook(book);
    const st = s.get();
    expect(st).toMatchObject({ quantity: 4, committedQuantity: 4, max: 4, clamped: false });
    const expected = clear(clearBidsFromBook(book.bids), 4, book.listing.floorCents);
    expect(st.clearResult).toEqual(expected);
    expect(st.numbers).toMatchObject({ cutoffCents: 21_900, grossCents: 95_600, winners: 4 });
  });

  it('starts at the rounds target quantity when one is set', () => {
    const s = createSliderStore();
    s.setBook(bookOf(6, 4, 2));
    expect(s.get().quantity).toBe(2);
  });

  it('drag moves on prefix sums and keeps the committed result; release makes it exact', () => {
    const s = createSliderStore();
    s.setBook(bookOf(6));
    const committed = s.get().clearResult;
    const fn = vi.fn();
    s.subscribe(fn);

    s.drag(2);
    expect(s.get()).toMatchObject({ quantity: 2, dragging: true, committedQuantity: 4 });
    expect(s.get().numbers).toMatchObject({ cutoffCents: 23_900, grossCents: 49_800, winners: 2 });
    expect(s.get().clearResult).toBe(committed);
    s.drag(2); // same position: no publish
    expect(fn).toHaveBeenCalledTimes(1);

    s.release();
    expect(s.get()).toMatchObject({ quantity: 2, committedQuantity: 2, dragging: false });
    expect(s.get().clearResult!.grossCents).toBe(49_800);
    expect(s.get().clearResult!.winners).toHaveLength(2);
    s.release(); // not dragging: no-op
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clamps to the bids at or above the floor and grows back as bids arrive', () => {
    const s = createSliderStore();
    s.setBook(bookOf(2, 4)); // 2 qualifying bids, listing quantity 4
    expect(s.get()).toMatchObject({ requested: 4, quantity: 2, max: 2, clamped: true });
    s.setBook(bookOf(3, 4));
    expect(s.get()).toMatchObject({ requested: 4, quantity: 3, max: 3, clamped: true });
    s.setBook(bookOf(6, 4));
    expect(s.get()).toMatchObject({ requested: 4, quantity: 4, max: 4, clamped: false });
    expect(s.get().clearResult!.grossCents).toBe(95_600);
  });

  it('keeps the brand’s chosen quantity across live book updates', () => {
    const s = createSliderStore();
    s.setBook(bookOf(4, 4));
    s.drag(2);
    s.release();
    s.setBook(bookOf(6, 4));
    expect(s.get()).toMatchObject({ requested: 2, quantity: 2 });
    // A higher bid arrived ahead of the old #2: the exact result reflects the new book.
    const book = bookFromInput(
      clearInput([...amounts.map((a, i) => heldBid(i, a)), heldBid(9, 30_000)], 4),
    );
    s.setBook(book);
    expect(s.get().clearResult!.grossCents).toBe(30_000 + 25_900);
  });

  it('a book change mid-drag stays on the prefix path and recomputes the committed result', () => {
    const s = createSliderStore();
    s.setBook(bookOf(6));
    s.drag(3);
    s.setBook(bookOf(2));
    expect(s.get()).toMatchObject({ quantity: 2, dragging: true });
    expect(s.get().clearResult!.winners).toHaveLength(2);
    s.release();
    expect(s.get()).toMatchObject({ quantity: 2, dragging: false });
  });

  it('is empty, not throwing, with no bid at or above the floor (clear() rejects Q ≤ 0)', () => {
    const s = createSliderStore();
    s.setBook(bookFromInput(clearInput([heldBid(0, 9_900)], 4)));
    expect(s.get()).toMatchObject({ quantity: null, max: 0, numbers: null, clearResult: null });
    s.drag(1);
    expect(s.get().dragging).toBe(false);
  });

  it('setSliderQuantity() applies exactly, clamps, survives the first load and rejects Q ≤ 0', () => {
    const s = createSliderStore();
    s.setSliderQuantity(3); // before the book ("Apply to slider" racing the first load)
    s.setBook(bookOf(6));
    expect(s.get()).toMatchObject({ quantity: 3, committedQuantity: 3 });
    s.setSliderQuantity(1);
    expect(s.get().clearResult!.grossCents).toBe(25_900);
    s.setSliderQuantity(50);
    expect(s.get()).toMatchObject({ requested: 50, quantity: 4, clamped: false });
    expect(() => s.setSliderQuantity(0)).toThrow(RangeError);
  });

  it('bidWouldWin reads the current slider position', () => {
    const s = createSliderStore();
    const book = bookOf(6);
    s.setBook(book);
    s.drag(1);
    const [first, second] = book.bids;
    expect(bidWouldWin(s.get(), first!.id)).toBe(true);
    expect(bidWouldWin(s.get(), second!.id)).toBe(false);
  });

  it('a new listing resets to its own quantity', () => {
    const s = createSliderStore();
    s.setBook(bookOf(6));
    s.setSliderQuantity(1);
    const other = bookOf(6, 3);
    other.listing.id = 'listing-2';
    s.setBook(other);
    expect(s.get().quantity).toBe(3);
    s.setBook(null);
    expect(s.get().book).toBeNull();
  });
});
