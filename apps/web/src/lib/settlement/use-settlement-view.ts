import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ListingEventNotice, SettlementView } from '@holdfast/shared';
import { ApiError, api } from '../api';
import { createCoalescedRefetch } from '../console/refetch';
import { useListingEvents, type ListingEventsStatus } from '../listing-events';

/**
 * W08's live settlement view (HF-035): `GET /api/listings/:id/settlement` once, then re-read on
 * every `settlement.updated`, `payout.updated` and `listing.status` notice (the SSE frames carry
 * ids only, HF-008) through the console's coalesced refetch, and at once after a reconnect or a
 * server `resync`. So the payout status changes without a reload.
 */

const RELEVANT: ReadonlySet<ListingEventNotice['type']> = new Set([
  'settlement.updated',
  'payout.updated',
  'listing.status',
]);

export interface SettlementViewState {
  view: SettlementView | null;
  error: ApiError | null;
  /** A refresh failed; `view` is the last good one. */
  stale: boolean;
  stream: ListingEventsStatus;
  refresh(): void;
}

export function settlementPath(listingId: string): string {
  return `/api/listings/${encodeURIComponent(listingId)}/settlement`;
}

export function useSettlementView(listingId: string): SettlementViewState {
  const [view, setView] = useState<SettlementView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [stale, setStale] = useState(false);
  const viewRef = useRef<SettlementView | null>(null);

  const refetch = useMemo(() => {
    let controller: AbortController | null = null;
    const r = createCoalescedRefetch(async () => {
      controller = new AbortController();
      try {
        const next = await api.request<SettlementView>({
          method: 'GET',
          path: settlementPath(listingId),
          signal: controller.signal,
        });
        viewRef.current = next;
        setView(next);
        setError(null);
        setStale(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const e =
          err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
        if (viewRef.current) setStale(true);
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
    viewRef.current = null;
    setView(null);
    setError(null);
    setStale(false);
    refetch.now();
    return () => refetch.cancel();
  }, [refetch]);

  const onEvent = useCallback(
    (notice: ListingEventNotice) => {
      if (RELEVANT.has(notice.type)) refetch.trigger();
    },
    [refetch],
  );
  const stream = useListingEvents(listingId, onEvent, { onReconnect: refetch.now });

  return { view, error, stale, stream, refresh: refetch.now };
}
