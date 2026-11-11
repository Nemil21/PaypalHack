import { describe, expect, it } from 'vitest';
import type { ListingEvent, ListingEventNotice } from '@holdfast/shared';
import {
  bidEventsUrl,
  listingEventsUrl,
  subscribeBidEvents,
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

const held = { listingId: 'lst_1', type: 'bid.held', ids: { bidId: 'bid_1' } };

function setup() {
  let source!: FakeSource;
  const events: ListingEventNotice[] = [];
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

  it('delivers notices from default and named frames', () => {
    const { source, events } = setup();
    source.open();
    source.emit('message', held);
    source.emit('bid.held', { ...held, ids: { bidId: 'bid_2' } });
    expect(events.map((e) => e.type === 'bid.held' && e.ids.bidId)).toEqual(['bid_1', 'bid_2']);
  });

  it('drops malformed frames, unknown types, extra fields and other listings', () => {
    const { source, events } = setup();
    source.emit('message', 'not json');
    source.emit('message', { ...held, type: 'bid.unknown' });
    source.emit('message', { ...held, ids: { bidId: 7 } });
    source.emit('message', { ...held, email: 'sam@example.com' });
    source.emit('message', { ...held, listingId: 'lst_other' });
    expect(events).toEqual([]);
  });

  it('turns full events from the fixture replay into notices and hands over the details', () => {
    let source!: FakeSource;
    const got: [ListingEventNotice, ListingEvent | undefined][] = [];
    subscribeListingEvents(
      'lst_1',
      { onEvent: (n, e) => got.push([n, e]) },
      (url) => (source = new FakeSource(url)),
    );
    const started: ListingEvent = {
      type: 'round.started',
      listingId: 'lst_1',
      at: '2026-11-11T20:00:00.000Z',
      round: 1,
      targetQuantity: 6,
      cutoffCents: 22_000,
      roundEndsAt: null,
      roundsEndAt: '2026-11-12T02:00:00.000Z',
    };
    source.emit('round.started', started);
    const raised: ListingEvent = {
      type: 'bid.raised',
      listingId: 'lst_1',
      at: started.at,
      bidId: 'b2',
      replacesBidId: 'b1',
      oldCents: 21_900,
      newCents: 24_100,
      shopperLabel: 'Shopper #4',
      source: 'SIM',
      isSimulated: true,
    };
    source.emit('bid.raised', raised);
    source.emit('round.started', { ...started, listingId: 'lst_other' });
    source.emit('message', held);
    expect(got).toEqual([
      [{ listingId: 'lst_1', type: 'round.started', ids: {} }, started],
      [
        { listingId: 'lst_1', type: 'bid.raised', ids: { bidId: 'b2', replacesBidId: 'b1' } },
        raised,
      ],
      [held, undefined],
    ]);
  });

  it('treats a server resync frame like a reconnect', () => {
    const { source, reconnects } = setup();
    source.open();
    source.emit('resync', { listingId: 'lst_1' });
    expect(reconnects()).toBe(1);
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

describe('subscribeBidEvents', () => {
  it("connects to the bid's own stream and delivers its notices", () => {
    let source!: FakeSource;
    const events: ListingEventNotice[] = [];
    subscribeBidEvents(
      'bid_1',
      { onEvent: (e) => events.push(e) },
      (url) => (source = new FakeSource(url)),
    );
    expect(source.url).toBe('/api/bids/bid_1/events');
    expect(bidEventsUrl('a/b')).toBe('/api/bids/a%2Fb/events');
    source.emit('round.started', { listingId: 'lst_9', type: 'round.started', ids: {} });
    expect(events.map((e) => e.type)).toEqual(['round.started']);
  });
});
