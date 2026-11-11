import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ListingEvent, ListingEventNotice, RoundsActivity } from '@holdfast/shared';
import { api } from '../api';
import { createCoalescedRefetch } from './refetch';
import {
  EMPTY_FEED,
  applyFeedEvent,
  feedFromActivity,
  mergeFeeds,
  type RoundsFeed,
} from './rounds-feed';

/**
 * The console's raises feed (HF-037b): `GET /api/listings/:id/rounds/activity` once rounds have
 * started, then re-read through one coalesced refetch (250 ms debounce, ≤ 1 s under a stream of
 * raises) on every `bid.raised` / `round.*` notice. The response is the whole feed, so a missed
 * notice heals on the next one. Full replay events (dev only) are folded in locally.
 */

export interface RoundsActivityState {
  feed: RoundsFeed;
  /** Pass every console notice here (before or after the book's own handling). */
  onNotice(notice: ListingEventNotice, event?: ListingEvent): void;
  /** Re-read now (after a rounds call, or a reconnect). */
  refresh(): void;
}

const FEED_NOTICES = new Set([
  'bid.raised',
  'round.started',
  'round.nudged',
  'round.extended',
  'round.ended',
]);

export function useRoundsActivity(listingId: string, started: boolean): RoundsActivityState {
  const [server, setServer] = useState<{ listingId: string; feed: RoundsFeed } | null>(null);
  const [local, setLocal] = useState<{ listingId: string; feed: RoundsFeed }>({
    listingId,
    feed: EMPTY_FEED,
  });
  const startedRef = useRef(started);
  startedRef.current = started;

  const refetch = useMemo(() => {
    let controller: AbortController | null = null;
    const r = createCoalescedRefetch(async () => {
      controller = new AbortController();
      try {
        const a = await api.request<RoundsActivity>({
          method: 'GET',
          path: `/api/listings/${encodeURIComponent(listingId)}/rounds/activity`,
          signal: controller.signal,
        });
        setServer({ listingId, feed: feedFromActivity(a) });
      } catch {
        // Keep the last feed; the next notice re-reads it.
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
    if (started) refetch.now();
  }, [refetch, started]);
  useEffect(() => () => refetch.cancel(), [refetch]);

  const onNotice = useCallback(
    (notice: ListingEventNotice, event?: ListingEvent) => {
      if (event) {
        setLocal((l) => ({
          listingId,
          feed: applyFeedEvent(l.listingId === listingId ? l.feed : EMPTY_FEED, event),
        }));
      }
      if (FEED_NOTICES.has(notice.type)) refetch.trigger();
    },
    [listingId, refetch],
  );

  const serverFeed = server?.listingId === listingId ? server.feed : null;
  const localFeed = local.listingId === listingId ? local.feed : EMPTY_FEED;
  const feed = useMemo(() => mergeFeeds(serverFeed, localFeed), [serverFeed, localFeed]);
  const refresh = useCallback(() => {
    if (startedRef.current) refetch.now();
  }, [refetch]);
  return { feed, onNotice, refresh };
}
