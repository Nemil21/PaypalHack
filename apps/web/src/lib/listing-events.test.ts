import { describe, expect, it } from 'vitest';
import type { ListingEvent } from '@holdfast/shared';
import {
  listingEventsUrl,
  subscribeListingEvents,
  type EventSourceLike,
  type ListingEventsStatus,
} from './listing-events.js';

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  readonly listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  drop(state = 0) {
    this.readyState = state;
    this.onerror?.(new Event('error'));
  }
  emit(type: string, data: unknown) {
    const ev = new MessageEvent(type, {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    });
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

const held = {
  type: 'bid.held',
  listingId: 'lst_1',
  at: '2026-11-11T10:00:00Z',
  bidId: 'bid_1',
  shopperLabel: 'Shopper #241',
  amountCents: 22_900,
  source: 'SIM',
  isSimulated: true,
  placedAt: '2026-11-11T10:00:00Z',
};

function setup() {
  let source!: FakeSource;
  const events: ListingEvent[] = [];
  const statuses: ListingEventsStatus[] = [];
  let reconnects = 0;
  const stop = subscribeListingEvents(
    'lst_1',
    {
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      onReconnect: () => reconnects++,
    },
    (url) => (source = new FakeSource(url)),
  );
  return { source, events, statuses, stop, reconnects: () => reconnects };
}

describe('subscribeListingEvents', () => {
  it('connects to the same-origin listing stream', () => {
    expect(setup().source.url).toBe('/api/listings/lst_1/events');
    expect(listingEventsUrl('a/b')).toBe('/api/listings/a%2Fb/events');
  });

  it('delivers typed events from default and named frames', () => {
    const { source, events } = setup();
    source.open();
    source.emit('message', held);
    source.emit('bid.held', { ...held, bidId: 'bid_2' });
    expect(events.map((e) => e.type === 'bid.held' && e.bidId)).toEqual(['bid_1', 'bid_2']);
  });

  it('drops malformed frames and other listings', () => {
    const { source, events } = setup();
    source.emit('message', 'not json');
    source.emit('message', { ...held, amountCents: 'lots' });
    source.emit('message', { ...held, listingId: 'lst_other' });
    expect(events).toEqual([]);
  });

  it('reports reconnects so the caller can re-fetch', () => {
    const { source, statuses, reconnects } = setup();
    source.open();
    source.drop();
    source.open();
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    expect(reconnects()).toBe(1);
  });

  it('reports closed when the server refuses the stream', () => {
    const { source, statuses } = setup();
    source.drop(2);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('closes the source and ignores late frames after unsubscribe', () => {
    const { source, events, stop } = setup();
    stop();
    source.emit('message', held);
    expect(source.closed).toBe(true);
    expect(events).toEqual([]);
  });
});
