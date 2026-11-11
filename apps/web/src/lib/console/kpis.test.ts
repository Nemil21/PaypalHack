import { describe, expect, it } from 'vitest';
import { clear, type BookBid, type BookResponse } from '@holdfast/shared';
import { consoleKpis, formatUsdCompact, priceDropToast, simulatedNote } from './kpis';

function bid(i: number, amountCents: number, isSimulated = false, rank: number | null = i + 1) {
  return {
    id: `b${i}`,
    amountCents,
    rank,
    placedAtUs: String(1_000_000 + i),
    source: isSimulated ? 'SIM' : 'OFFER_PAGE',
    isSimulated,
    shopperLabel: `Shopper #${1001 + i}`,
    status: 'HELD',
    belowFloor: rank === null,
  } satisfies BookBid;
}

function book(patch: { bids?: BookBid[]; released?: number; price?: number | null } = {}) {
  const bids = patch.bids ?? [bid(0, 25_900, true), bid(1, 23_900), bid(2, 21_900, true)];
  const held = bids.reduce((s, b) => s + b.amountCents, 0);
  const sim = bids.filter((b) => b.isSimulated).reduce((s, b) => s + b.amountCents, 0);
  return {
    listing: {
      quantity: 2,
      floorCents: 19_900,
      liquidationQuoteCents: 3_800,
      priceWatch: {
        on: true,
        bestPublicPriceCents: patch.price === undefined ? 21_900 : patch.price,
        merchant: 'retailer.example',
        offerUrl: null,
        priceUpdatedAt: null,
      },
    },
    stats: {
      liveBids: bids.length,
      heldCents: held,
      simulatedHeldCents: sim,
      bestPublicPriceCents: null,
      releasedByPriceWatch: patch.released ?? 0,
    },
    bids,
  } as unknown as BookResponse;
}

describe('consoleKpis', () => {
  it('projects cutoff and gross with the shared clear() at the listing quantity', () => {
    const k = consoleKpis(book());
    expect(k).toMatchObject({
      heldCents: 71_700,
      simulatedHeldCents: 47_800,
      liveBids: 3,
      quantity: 2,
      cutoffCents: 23_900,
      grossCents: 49_800,
      winners: 2,
      // 49,800 / (2 × 3,800) = 6.55
      recoveryMultiple: 6.55,
    });
  });

  it('matches clear() for a slider quantity, clamped to 1…quantity', () => {
    const b = book();
    expect(consoleKpis(b, 1)).toMatchObject({ cutoffCents: 25_900, grossCents: 25_900 });
    expect(consoleKpis(b, 99).quantity).toBe(2);
    expect(consoleKpis(b, 0).quantity).toBe(1);
  });

  it('ignores below-floor bids and reports no recovery without a liquidation quote', () => {
    const b = book({ bids: [bid(0, 25_900), bid(1, 15_000, false, null)] });
    (b.listing as { liquidationQuoteCents: number | null }).liquidationQuoteCents = null;
    const k = consoleKpis(b);
    const expected = clear(
      [
        {
          id: 'b0',
          shopperId: 's',
          amountCents: 25_900,
          seq: 0,
          placedAt: '',
          status: 'HELD',
          paypalAuthorizationId: 'x',
          authorizedAt: null,
          isSimulated: false,
        },
      ],
      2,
      19_900,
    );
    expect(k.grossCents).toBe(expected.grossCents);
    expect(k.winners).toBe(1);
    expect(k.recoveryMultiple).toBeNull();
  });

  it('empty book: no cutoff, zero gross', () => {
    expect(consoleKpis(book({ bids: [] }))).toMatchObject({
      liveBids: 0,
      heldCents: 0,
      cutoffCents: null,
      grossCents: 0,
    });
  });
});

describe('simulatedNote', () => {
  it('shows the SIM share of held dollars on hover, or nothing', () => {
    expect(simulatedNote({ simulatedHeldCents: 47_800 })).toBe('incl. $478 simulated');
    expect(simulatedNote({ simulatedHeldCents: 0 })).toBeNull();
  });
});

describe('formatUsdCompact', () => {
  it.each([
    [21_900, '$219'],
    [999_999, '$9,999.99'],
    [6_120_000, '$61.2k'],
    [6_100_000, '$61k'],
    [523_400_000, '$5.2M'],
  ])('%i → %s', (c, s) => expect(formatUsdCompact(c)).toBe(s));
});

describe('priceDropToast', () => {
  it('"3 bids released: public price dropped to $219" from the book diff', () => {
    const t = priceDropToast(book({ released: 2 }), book({ released: 5 }));
    expect(t?.title).toBe('3 bids released: public price dropped to $219');
    expect(t?.body).toContain('retailer.example');
  });

  it('singular, and nothing when no more bids were released', () => {
    expect(priceDropToast(book({ released: 0 }), book({ released: 1 }))?.title).toBe(
      '1 bid released: public price dropped to $219',
    );
    expect(priceDropToast(book({ released: 3 }), book({ released: 3 }))).toBeNull();
    expect(priceDropToast(null, book({ released: 1, price: null }))?.title).toBe('1 bid released');
  });
});
