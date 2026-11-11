import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookResponse, ListingEventNotice } from '@holdfast/shared';
import { ApiError, api } from '../api';
import { useListingEvents, type ListingEventsStatus } from '../listing-events';
import { priceDropToast } from './kpis';
import { createCoalescedRefetch } from './refetch';

/**
 * The console's live book (HF-023): `GET /api/listings/:id/book` once, then re-read on SSE
 * notices through one coalesced refetch (250 ms debounce, never overlapping), and immediately on
 * every reconnect or server `resync`. Later panels plug in through `onNotice` (the grid, HF-025,
 * applies row deltas; everything else reads `book`).
 */

export interface ConsoleBookState {
  book: BookResponse | null;
  /** Failed load with nothing to show; a failed *refresh* keeps the last book and sets `stale`. */
  error: ApiError | null;
  stale: boolean;
  stream: ListingEventsStatus;
  /** Set when a reconnect found a different book than before the drop. */
  changedWhileAway: boolean;
  dismissChanged(): void;
  refresh(): void;
  /** Book refetches started, for the dev overlay and tests. */
  fetches: number;
}

export interface ConsoleBookOptions {
  onPriceDrop?: (toast: { title: string; body?: string }) => void;
  /** Every notice, before the refetch (e.g. the grid's row deltas). */
  onNotice?: (notice: ListingEventNotice) => void;
}

export function useConsoleBook(listingId: string, opts: ConsoleBookOptions = {}): ConsoleBookState {
  const [book, setBook] = useState<BookResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [stale, setStale] = useState(false);
  const [changedWhileAway, setChanged] = useState(false);
  const [fetches, setFetches] = useState(0);

  const bookRef = useRef<BookResponse | null>(null);
  const pendingPriceDrop = useRef(false);
  const versionBeforeDrop = useRef<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const refetch = useMemo(() => {
    let controller: AbortController | null = null;
    const r = createCoalescedRefetch(async () => {
      controller = new AbortController();
      setFetches((n) => n + 1);
      try {
        const next = await api.request<BookResponse>({
          method: 'GET',
          path: `/api/listings/${encodeURIComponent(listingId)}/book`,
          signal: controller.signal,
        });
        const before = bookRef.current;
        if (pendingPriceDrop.current) {
          pendingPriceDrop.current = false;
          const toast = priceDropToast(before, next);
          if (toast) optsRef.current.onPriceDrop?.(toast);
        }
        if (versionBeforeDrop.current !== null) {
          if (versionBeforeDrop.current !== next.bookVersion) setChanged(true);
          versionBeforeDrop.current = null;
        }
        bookRef.current = next;
        setBook(next);
        setError(null);
        setStale(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const e =
          err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
        if (bookRef.current) setStale(true);
        else setError(e);
      }
    });
    return {
      ...r,
      cancel() {
        r.cancel();
        controller?.abort();
      },
    };
  }, [listingId]);

  useEffect(() => {
    bookRef.current = null;
    setBook(null);
    setError(null);
    setStale(false);
    setChanged(false);
    refetch.now();
    return () => refetch.cancel();
  }, [refetch]);

  const onEvent = useCallback(
    (notice: ListingEventNotice) => {
      if (notice.type === 'pricewatch.released') pendingPriceDrop.current = true;
      optsRef.current.onNotice?.(notice);
      refetch.trigger();
    },
    [refetch],
  );

  const stream = useListingEvents(listingId, onEvent, {
    onReconnect: () => {
      // Notices may have been missed while the stream was down: re-read now, and tell the brand
      // if the book moved meanwhile.
      versionBeforeDrop.current = bookRef.current?.bookVersion ?? null;
      refetch.now();
    },
  });

  return {
    book,
    error,
    stale,
    stream,
    changedWhileAway,
    dismissChanged: useCallback(() => setChanged(false), []),
    refresh: refetch.now,
    fetches,
  };
}
