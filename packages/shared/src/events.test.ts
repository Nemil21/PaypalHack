import { describe, expect, it } from 'vitest';
import { LISTING_EVENT_TYPES, parseListingEvent, type ListingEvent } from './events.js';

const at = '2026-11-11T12:00:00.000Z';

describe('ListingEvent union', () => {
  it('has exactly the event types in api.md', () => {
    expect([...LISTING_EVENT_TYPES].sort()).toEqual(
      [
        'bid.held',
        'bid.voided',
        'bid.raised',
        'settlement.updated',
        'listing.status',
        'listing.updated',
        'round.started',
        'round.nudged',
        'round.extended',
        'round.ended',
        'payout.updated',
        'pricewatch.released',
      ].sort(),
    );
  });

  it('parses a bid.raised event (HF-018 contract)', () => {
    const e = parseListingEvent({
      type: 'bid.raised',
      listingId: 'l1',
      at,
      bidId: 'b2',
      replacesBidId: 'b1',
      oldCents: 21900,
      newCents: 24100,
      shopperLabel: 'Shopper #241',
      source: 'SIM',
      isSimulated: true,
    });
    expect(e.type).toBe('bid.raised');
    if (e.type === 'bid.raised') expect(e.newCents - e.oldCents).toBe(2200);
  });

  it('rejects unknown types and missing fields', () => {
    expect(() => parseListingEvent({ type: 'bid.exploded', listingId: 'l1', at })).toThrow();
    expect(() =>
      parseListingEvent({ type: 'pricewatch.released', listingId: 'l1', at, count: 3 }),
    ).toThrow();
  });

  it('narrows by type', () => {
    const e: ListingEvent = {
      type: 'pricewatch.released',
      listingId: 'l1',
      at,
      count: 3,
      priceCents: 21900,
      merchant: 'Example',
    };
    const label = e.type === 'pricewatch.released' ? `${e.count} bids released` : '';
    expect(label).toBe('3 bids released');
  });
});
