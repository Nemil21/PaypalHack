import { createContext, useContext, useSyncExternalStore } from 'react';
import type { BookResponse, ClearResult } from '@holdfast/shared';
import {
  clampQuantity,
  exactAt,
  prepareSlider,
  previewAt,
  wouldWin,
  type SliderBook,
  type SliderNumbers,
} from './slider';

/**
 * The console slider store (HF-024). One per open listing; the console creates it and provides it
 * through `SliderContext`. Readers: the KPI row, the demand curve's cutoff marker, the bids grid's
 * "Would win?" column (HF-025), the Clear modal (HF-028 sends `clearResult.grossCents` as
 * `expectedGrossCents`), rounds (HF-037a/b) and the brand agent card (HF-051a). Writers: the
 * slider, "Apply to slider" (HF-051a) and the rounds target-quantity input (HF-037a) through
 * `setSliderQuantity()`.
 *
 * `clearResult` is always the shared `clear()` at `committedQuantity`. While the brand drags,
 * `quantity` and `numbers` move on the prefix-sum path and `clearResult` keeps the last released
 * value; on release they agree again.
 */
export interface SliderState {
  /** The ranked book; null until the first book loads. */
  book: SliderBook | null;
  /** What the brand last asked for (may exceed `max` while bids are short; see `clamped`). */
  requested: number;
  /** The slider position, in `1 … max`; null while no bid is at or above the floor. */
  quantity: number | null;
  /** The quantity `clearResult` was computed at. */
  committedQuantity: number | null;
  /** Slider upper bound: min(listing quantity, bids at or above the floor). */
  max: number;
  /** The slider stopped short of `requested` because too few bids qualify. */
  clamped: boolean;
  dragging: boolean;
  /** Cutoff, gross, winners and recovery at `quantity` (prefix sums while dragging). */
  numbers: SliderNumbers | null;
  /** Shared `clear()` at `committedQuantity`: the exact numbers Clear will use. */
  clearResult: ClearResult | null;
}

export interface SliderStore {
  get(): SliderState;
  subscribe(fn: () => void): () => void;
  /** A new book snapshot: re-rank once, keep the brand's quantity (clamped), recompute exactly. */
  setBook(book: BookResponse | null): void;
  /** While dragging: move the position; numbers from prefix sums. */
  drag(quantity: number): void;
  /** Drag released: shared `clear()` at the current position. */
  release(): void;
  /** Set the quantity from outside the slider ("Apply to slider", rounds target). Exact at once. */
  setSliderQuantity(quantity: number): void;
}

const EMPTY: SliderState = {
  book: null,
  requested: 0,
  quantity: null,
  committedQuantity: null,
  max: 0,
  clamped: false,
  dragging: false,
  numbers: null,
  clearResult: null,
};

export function createSliderStore(): SliderStore {
  let state = EMPTY;
  let lastBook: BookResponse | null = null;
  /** A `setSliderQuantity()` that arrived before the first book. */
  let pending: number | null = null;
  const subs = new Set<() => void>();

  const publish = (next: SliderState) => {
    state = next;
    subs.forEach((fn) => fn());
  };

  /** Exact state for `requested` on `sb` (not dragging). */
  const settle = (sb: SliderBook, requested: number): SliderState => {
    const q = clampQuantity(sb, requested);
    const exact = q === null ? null : exactAt(sb, q);
    return {
      book: sb,
      requested,
      quantity: q,
      committedQuantity: q,
      max: sb.max,
      clamped: q === null ? requested > 0 : q < Math.min(requested, sb.listingQuantity),
      dragging: false,
      numbers: exact?.numbers ?? null,
      clearResult: exact?.result ?? null,
    };
  };

  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    setBook(book) {
      if (book === lastBook) return;
      const first = lastBook === null || lastBook.listing.id !== book?.listing.id;
      lastBook = book;
      if (!book) return publish(EMPTY);
      const sb = prepareSlider(book);
      // First book: a quantity set before it loaded, else the rounds target, else the listing
      // quantity.
      const requested = first
        ? (pending ?? book.listing.targetQuantity ?? book.listing.quantity)
        : state.requested;
      pending = null;
      const next = settle(sb, requested);
      if (state.dragging && next.quantity !== null && state.quantity !== null) {
        // Mid-drag: keep the thumb where it is (clamped) and stay on the prefix path; the
        // committed result is still exact for the new book.
        const q = clampQuantity(sb, state.quantity)!;
        return publish({ ...next, quantity: q, dragging: true, numbers: previewAt(sb, q) });
      }
      publish(next);
    },
    drag(quantity) {
      const sb = state.book;
      if (!sb) return;
      const q = clampQuantity(sb, quantity);
      if (q === null || (state.dragging && q === state.quantity)) return;
      publish({
        ...state,
        requested: q,
        quantity: q,
        clamped: false,
        dragging: true,
        numbers: previewAt(sb, q),
      });
    },
    release() {
      if (!state.book || !state.dragging) return;
      publish(settle(state.book, state.quantity ?? state.requested));
    },
    setSliderQuantity(quantity) {
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw new RangeError(`quantity must be a positive integer, got ${String(quantity)}`);
      }
      if (!state.book) {
        pending = quantity;
        return;
      }
      publish(settle(state.book, quantity));
    },
  };
}

/** Whether a bid wins at the slider's current position (HF-025's "Would win?" column). */
export function bidWouldWin(state: SliderState, bidId: string): boolean {
  return state.book !== null && wouldWin(state.book, bidId, state.quantity);
}

export const SliderContext = createContext<SliderStore | null>(null);

/** The open listing's slider store. Throws outside the listing console. */
export function useSliderStore(): SliderStore {
  const store = useContext(SliderContext);
  if (!store)
    throw new Error('useSliderStore() needs a <SliderContext.Provider> (listing console)');
  return store;
}

/** Re-renders on every slider change (each drag step). Prefer a narrow component. */
export function useSlider(): SliderState {
  const store = useSliderStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** `setSliderQuantity()` for "Apply to slider" (HF-051a) and the rounds target input (HF-037a). */
export function useSetSliderQuantity(): (quantity: number) => void {
  return useSliderStore().setSliderQuantity;
}
