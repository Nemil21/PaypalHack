import { useEffect, useRef, useState } from 'react';
import {
  LISTING_EVENT_TYPES,
  LISTING_EVENTS_RESYNC,
  listingEventNoticeSchema,
  listingEventSchema,
  type ListingEvent,
  type ListingEventNotice,
} from '@holdfast/shared';

/**
 * Live listing events over SSE (`GET /api/listings/:id/events`, HF-008). Same origin, so the
 * session cookie is sent without `withCredentials`.
 *
 * The server sends named frames (`event: bid.held`) whose data is the small notice
 * `{listingId, type, ids}`: which entities changed, never the details. Handlers re-fetch (debounced)
 * on each notice. The HF-036a fixture replay (`dev:rounds-replay`) sends full `ListingEvent`s
 * instead: those are turned into the same notice and also handed over as `event`, so the console
 * can show the replayed round without a matching book. Frames that parse as neither are dropped. The browser's
 * EventSource reconnects by itself; on every reconnect, and on a server `resync` frame (its LISTEN
 * connection dropped), we call `onReconnect` because notices may have been missed.
 */

export type ListingEventsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ListingEventHandlers {
  /** `event` is set only for full events (the fixture replay), never for the server's notices. */
  onEvent: (notice: ListingEventNotice, event?: ListingEvent) => void;
  /** Called when the stream comes back after a drop. Re-fetch the book here. */
  onReconnect?: () => void;
  onStatus?: (status: ListingEventsStatus) => void;
}

/** The slice of EventSource we use, so tests can pass a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const CLOSED = 2;

export function listingEventsUrl(listingId: string): string {
  return `/api/listings/${encodeURIComponent(listingId)}/events`;
}

/** The shopper's own-bid stream (`GET /api/bids/:id/events`, HF-008). */
export function bidEventsUrl(bidId: string): string {
  return `/api/bids/${encodeURIComponent(bidId)}/events`;
}

const defaultFactory: EventSourceFactory = (url) => new EventSource(url);

/** Subscribe to a listing's stream (brand users); returns an unsubscribe function. */
export function subscribeListingEvents(
  listingId: string,
  handlers: ListingEventHandlers,
  createSource: EventSourceFactory = defaultFactory,
): () => void {
  return subscribe(
    listingEventsUrl(listingId),
    (n) => n.listingId === listingId,
    handlers,
    createSource,
  );
}

/**
 * Subscribe to one bid's stream (its shopper only): notices about this bid (and its raises) plus
 * listing-wide round and status changes. Returns an unsubscribe function.
 */
export function subscribeBidEvents(
  bidId: string,
  handlers: ListingEventHandlers,
  createSource: EventSourceFactory = defaultFactory,
): () => void {
  return subscribe(bidEventsUrl(bidId), () => true, handlers, createSource);
}

function subscribe(
  url: string,
  accept: (notice: ListingEventNotice) => boolean,
  handlers: ListingEventHandlers,
  createSource: EventSourceFactory,
): () => void {
  const source = createSource(url);
  let opened = false;
  let closed = false;

  handlers.onStatus?.('connecting');

  source.onopen = () => {
    if (closed) return;
    if (opened) handlers.onReconnect?.();
    opened = true;
    handlers.onStatus?.('open');
  };

  source.onerror = () => {
    if (closed) return;
    // CLOSED means the server refused (e.g. 404 for another brand's listing): no auto-retry.
    handlers.onStatus?.(source.readyState === CLOSED ? 'closed' : 'reconnecting');
  };

  const onFrame = (ev: MessageEvent) => {
    if (closed || typeof ev.data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(ev.data);
    } catch {
      return;
    }
    const parsed = listingEventNoticeSchema.safeParse(json);
    if (parsed.success) {
      if (accept(parsed.data)) handlers.onEvent(parsed.data);
      return;
    }
    const full = listingEventSchema.safeParse(json);
    if (!full.success) return;
    const notice = noticeOf(full.data);
    if (accept(notice)) handlers.onEvent(notice, full.data);
  };

  source.addEventListener('message', onFrame);
  for (const type of LISTING_EVENT_TYPES) source.addEventListener(type, onFrame);
  source.addEventListener(LISTING_EVENTS_RESYNC, () => {
    if (!closed) handlers.onReconnect?.();
  });

  return () => {
    closed = true;
    source.close();
    handlers.onStatus?.('closed');
  };
}

/** The id-only notice a full event would have travelled as. */
function noticeOf(event: ListingEvent): ListingEventNotice {
  const ids: Record<string, string> = {};
  if ('bidId' in event) ids.bidId = event.bidId;
  if (event.type === 'bid.raised') ids.replacesBidId = event.replacesBidId;
  return { listingId: event.listingId, type: event.type, ids };
}

/**
 * React hook: subscribe while mounted (and while `listingId` is set). Handlers may change on every
 * render without resubscribing.
 */
export function useListingEvents(
  listingId: string | null | undefined,
  onEvent: (notice: ListingEventNotice, event?: ListingEvent) => void,
  opts: { onReconnect?: () => void } = {},
): ListingEventsStatus {
  const [status, setStatus] = useState<ListingEventsStatus>('connecting');
  const latest = useRef({ onEvent, onReconnect: opts.onReconnect });
  latest.current = { onEvent, onReconnect: opts.onReconnect };

  useEffect(() => {
    if (!listingId) {
      setStatus('closed');
      return;
    }
    return subscribeListingEvents(listingId, {
      onEvent: (n, e) => latest.current.onEvent(n, e),
      onReconnect: () => latest.current.onReconnect?.(),
      onStatus: setStatus,
    });
  }, [listingId]);

  return status;
}
