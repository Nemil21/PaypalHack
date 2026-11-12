import { useEffect, useMemo, useState } from 'react';
import type { BrandOverview as Overview } from '@holdfast/shared';
import { ApiError, api } from '../../lib/api';
import { OVERVIEW_POLL_MS, streamedListingIds } from '../../lib/brand-overview';
import { createCoalescedRefetch } from '../../lib/console/refetch';
import { subscribeListingEvents } from '../../lib/listing-events';

/** Re-render every `ms` so countdowns tick. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * `GET /api/brands/me/overview`, live (HF-026): SSE notices from the listings that can still change
 * → one coalesced refetch, plus a slow poll. Shared by W04 Overview and v4 My listings.
 */
export function useOverview() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const refetch = useMemo(
    () =>
      createCoalescedRefetch(
        () =>
          api
            .request<Overview>({ method: 'GET', path: '/api/brands/me/overview' })
            .then((o) => {
              setOverview(o);
              setError(null);
            })
            .catch((err: unknown) => {
              setError(
                err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Failed to load.'),
              );
            }),
        { debounceMs: 400, maxWaitMs: 2000 },
      ),
    [],
  );

  useEffect(() => {
    refetch.now();
    const id = setInterval(() => refetch.trigger(), OVERVIEW_POLL_MS);
    return () => {
      clearInterval(id);
      refetch.cancel();
    };
  }, [refetch]);

  // One stream per listing that can still change; the set is re-derived when statuses change.
  const streamKey = overview ? streamedListingIds(overview).join(',') : '';
  useEffect(() => {
    if (!streamKey) return;
    const offs = streamKey.split(',').map((id) =>
      subscribeListingEvents(id, {
        onEvent: () => refetch.trigger(),
        onReconnect: () => refetch.now(),
      }),
    );
    return () => offs.forEach((off) => off());
  }, [streamKey, refetch]);

  return { overview, error, retry: () => refetch.now() };
}
