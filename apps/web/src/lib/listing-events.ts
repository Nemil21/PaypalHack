import { useEffect, useRef, useState } from 'react';
import { LISTING_EVENT_TYPES, listingEventSchema, type ListingEvent } from '@holdfast/shared';

/**
 * Live listing events over SSE (`GET /api/listings/:id/events`, HF-008). Same origin, so the
 * session cookie is sent without `withCredentials`.
 *
 * Frames are validated against the shared `ListingEvent` union and dropped if they don't parse.
 * Both default `message` frames and named frames (`event: bid.held`) are accepted, so the server
 * can choose either. The browser's EventSource reconnects by itself; on every reconnect we call
 * `onReconnect` because payloads are small and the client must re-fetch details (HF-008).
 */

export type ListingEventsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ListingEventHandlers {
  onEvent: (event: ListingEvent) => void;
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

/** Subscribe; returns an unsubscribe function. */
export function subscribeListingEvents(
  listingId: string,
  handlers: ListingEventHandlers,
  createSource: EventSourceFactory = (url) => new EventSource(url),
): () => void {
  const source = createSource(listingEventsUrl(listingId));
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
    const parsed = listingEventSchema.safeParse(json);
    if (parsed.success && parsed.data.listingId === listingId) handlers.onEvent(parsed.data);
  };

  source.addEventListener('message', onFrame);
  for (const type of LISTING_EVENT_TYPES) source.addEventListener(type, onFrame);

  return () => {
    closed = true;
    source.close();
    handlers.onStatus?.('closed');
  };
}

/**
 * React hook: subscribe while mounted (and while `listingId` is set). Handlers may change on every
 * render without resubscribing.
 */
export function useListingEvents(
  listingId: string | null | undefined,
  onEvent: (event: ListingEvent) => void,
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
      onEvent: (e) => latest.current.onEvent(e),
      onReconnect: () => latest.current.onReconnect?.(),
      onStatus: setStatus,
    });
  }, [listingId]);

  return status;
}
