import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { books, toClearBid } from '../fixtures/books.js';
import { fixtureNudges, roundsReplayEvents, sseFrame } from '../fixtures/rounds.js';
import { clear } from './auction.js';
import type { ClearBid } from './clear.js';
import {
  minRaiseCents,
  nudgePayloadSchema,
  nudgeSchema,
  nudgeText,
  selectNudges,
  suggestedRaiseCents,
} from './rounds.js';

const ctx = { targetQuantity: 3, roundEndsAt: null };

function nudgedOn(name: string) {
  const book = books.find((b) => b.name.startsWith(name))!;
  const result = clear(book.bids.map(toClearBid), book.q, book.floorCents);
  return { book, result, drafts: selectNudges(result, { ...ctx, targetQuantity: book.q }) };
}

describe('minRaiseCents / suggestedRaiseCents', () => {
  it('is $1 or 1% (rounded up), whichever is larger', () => {
    expect(minRaiseCents(5_000)).toBe(100);
    expect(minRaiseCents(10_000)).toBe(100);
    expect(minRaiseCents(24_000)).toBe(240);
    expect(minRaiseCents(24_001)).toBe(241);
  });

  it('suggests max(cutoff + minRaise(cutoff), current + minRaise(current))', () => {
    expect(suggestedRaiseCents(24_000, 21_900)).toBe(24_240);
    // A bid tied at the cutoff (lost on time) still has to beat it.
    expect(suggestedRaiseCents(25_000, 25_000)).toBe(25_250);
    expect(suggestedRaiseCents(9_000, 8_000)).toBe(9_100);
  });

  it('always beats both the cutoff and the current bid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 100, max: 1_000_000 }),
        (c, y) => {
          const s = suggestedRaiseCents(c, y);
          return Number.isSafeInteger(s) && s > c && s > y;
        },
      ),
    );
  });
});

describe('nudgeText (template)', () => {
  it('matches the spec copy', () => {
    expect(nudgeText({ yourBidCents: 21_900, cutoffCents: 24_000, suggestedCents: 24_100 })).toBe(
      "You're out at $219. The cutoff is $240. Raise to $241?",
    );
  });
});

describe('selectNudges on the HF-005 fixture books', () => {
  it.each(books.map((b) => [b.name, b] as const))(
    '%s: exactly the eligible non-winners, one per non-winning shopper, numbers from clear()',
    (_name, book) => {
      const bids = book.bids.map(toClearBid);
      const result = clear(bids, book.q, book.floorCents);
      const drafts = selectNudges(result, { targetQuantity: book.q, roundEndsAt: null });

      const winners = new Set(result.winners.map((b) => b.id));
      const winningShoppers = new Set(result.winners.map((b) => b.shopperId));
      const ineligible = new Set(result.ineligible.map((b) => b.id));
      const expected =
        result.cutoffCents === null
          ? []
          : [...result.reserve, ...result.belowFloor]
              .filter((b) => !winners.has(b.id) && !ineligible.has(b.id))
              .filter((b) => !winningShoppers.has(b.shopperId))
              .map((b) => b.id);
      expect(drafts.map((d) => d.bidId).sort()).toEqual([...expected].sort());
      expect(new Set(drafts.map((d) => d.shopperId)).size).toBe(drafts.length);
      for (const d of drafts) {
        expect(winners.has(d.bidId)).toBe(false);
        expect(d.cutoffCents).toBe(result.cutoffCents);
        expect(d.yourBidCents).toBe(bids.find((b) => b.id === d.bidId)!.amountCents);
        expect(d.suggestedCents).toBe(suggestedRaiseCents(d.cutoffCents, d.yourBidCents));
        expect(d.targetQuantity).toBe(book.q);
        nudgePayloadSchema.parse({
          cutoffCents: d.cutoffCents,
          yourBidCents: d.yourBidCents,
          targetQuantity: d.targetQuantity,
          roundEndsAt: d.roundEndsAt,
          suggestedCents: d.suggestedCents,
        });
      }
    },
  );

  it('nudges the reserve bid and the below-floor bid, never a winner', () => {
    const { drafts } = nudgedOn('basic book');
    expect(drafts.map((d) => d.bidId)).toEqual(['c', 'e']);
    expect(drafts[0]).toMatchObject({
      cutoffCents: 20_000,
      yourBidCents: 18_000,
      suggestedCents: 20_200,
    });
  });

  it('nudges a bid tied at the cutoff that lost on time priority', () => {
    const { drafts, result } = nudgedOn('tie at the cutoff');
    expect(result.cutoffCents).toBe(25_000);
    expect(drafts).toEqual([
      expect.objectContaining({
        bidId: 'b',
        yourBidCents: 25_000,
        cutoffCents: 25_000,
        suggestedCents: 25_250,
      }),
    ]);
  });

  it('nobody below the cutoff: no nudges (all eligible already win)', () => {
    expect(nudgedOn('a bid exactly at the floor').drafts).toEqual([]);
    expect(nudgedOn('only HELD bids count').drafts).toEqual([]);
  });

  it('no winners (everything below the floor, or an empty book): nothing truthful to quote', () => {
    expect(nudgedOn('everything below the floor').drafts).toEqual([]);
    expect(nudgedOn('empty book').drafts).toEqual([]);
  });

  it('a shopper who wins is never nudged for a superseded lower bid', () => {
    const { drafts } = nudgedOn('one shopper with two HELD bids');
    expect(drafts).toEqual([]);
  });

  it('no-hold bids are never nudged (D8)', () => {
    const { drafts } = nudgedOn('no-hold bid');
    expect(drafts.map((d) => d.bidId)).toEqual(['c']);
  });

  it('never depends on the floor except through clear() winners (floor-blind payload)', () => {
    const bids: ClearBid[] = [30_000, 25_000, 20_000, 15_000].map((a, i) =>
      toClearBid({ id: `b${i}`, shopperId: `s${i}`, amountCents: a, seq: i + 1 }),
    );
    const at = (floor: number) =>
      selectNudges(clear(bids, 2, floor), { targetQuantity: 2, roundEndsAt: null });
    expect(at(10_000)).toEqual(at(12_345));
    expect(JSON.stringify(at(12_345))).not.toContain('12345');
  });
});

describe('nudgeSchema', () => {
  it('is strict: a floor field is rejected', () => {
    const nudge = {
      id: 'n1',
      listingId: 'l1',
      bidId: 'b1',
      shopperId: 's1',
      round: 1,
      cutoffCents: 24_000,
      yourBidCents: 21_900,
      targetQuantity: 240,
      roundEndsAt: null,
      suggestedCents: 24_240,
      text: 'x',
      sentAt: '2026-11-11T10:00:00.000Z',
    };
    expect(nudgeSchema.parse(nudge)).toEqual(nudge);
    expect(() => nudgeSchema.parse({ ...nudge, floorCents: 1 })).toThrow();
  });
});

describe('rounds replay fixture (npm run dev:rounds-replay)', () => {
  it('round.started → round.nudged × N → bid.raised × M, deterministic and floor-free', () => {
    const events = roundsReplayEvents({ raises: 2 });
    expect(events).toEqual(roundsReplayEvents({ raises: 2 }));
    const types = events.map((e) => e.type);
    const nudges = fixtureNudges();
    expect(types).toEqual([
      'listing.status',
      'round.started',
      ...nudges.map(() => 'round.nudged'),
      'bid.raised',
      'bid.raised',
    ]);
    expect(nudges.length).toBeGreaterThan(0);
    for (const n of nudges) expect(n.text).toBe(nudgeText(n));
    // The fixture's hidden floor is $185 (18500 cents).
    const raw = JSON.stringify(events) + JSON.stringify(nudges);
    expect(raw).not.toContain('18500');
    expect(raw).not.toContain('$185');
    expect(sseFrame(events[0]!, 1)).toMatch(/^event: listing\.status\nid: 1\ndata: \{.*\}\n\n$/);
  });
});
