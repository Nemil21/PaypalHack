import { describe, expect, it } from 'vitest';
import {
  bandPosition,
  otherMethod,
  anchorText,
  attributionOf,
  claimClick,
  countdownText,
  holdFailure,
  holdLabel,
  initialAmount,
  minRaiseCents,
  offerMode,
  overPublicWarning,
  parseAmountParam,
  parseDollarInput,
  parseSourceParam,
  priceHint,
  sliderRange,
  stepAmount,
  type OfferView,
} from './offer.js';

const offer = (over: Partial<OfferView> = {}): OfferView => ({
  listingId: 'l1',
  slug: 'aurel-a7',
  brand: { name: 'Aurel Audio', verified: true },
  product: { title: 'Aurel A7', imageUrl: null, bestPublicPriceCents: 27_900 },
  publicOffer: { merchant: 'retailer.example', priceCents: 27_900, url: null, updatedAt: null },
  status: 'OPEN',
  phase: 'BIDDING',
  biddable: true,
  windowClosesAt: new Date(Date.now() + 3_600_000).toISOString(),
  roundsEndAt: null,
  suggestedBidCents: 22_900,
  likelyBand: null,
  myBid: null,
  ...over,
});

describe('amount input', () => {
  it('parses typed dollars and rejects junk or out-of-range values', () => {
    expect(parseDollarInput('229')).toBe(22_900);
    expect(parseDollarInput('$1,029.50')).toBe(102_950);
    expect(parseDollarInput('229.505')).toBeNull();
    expect(parseDollarInput('abc')).toBeNull();
    expect(parseDollarInput('0.50')).toBeNull();
    expect(parseDollarInput('')).toBeNull();
  });

  it('steps by $5 and stays within the bid limits', () => {
    expect(stepAmount(22_900, 1)).toBe(23_400);
    expect(stepAmount(22_900, -1)).toBe(22_400);
    expect(stepAmount(300, -1)).toBe(100);
  });

  it('reads the ?amount= deep link in cents and ?src= as attribution', () => {
    expect(parseAmountParam('22900')).toBe(22_900);
    expect(parseAmountParam('229.00')).toBeNull();
    expect(parseAmountParam('50')).toBeNull();
    expect(parseAmountParam(null)).toBeNull();
    expect(parseSourceParam('agent')).toBe('agent');
    expect(parseSourceParam('<script>')).toBeNull();
  });

  it('starts at the deep link, else the suggestion, else the band', () => {
    expect(initialAmount(offer(), 21_500)).toBe(21_500);
    expect(initialAmount(offer(), null)).toBe(22_900);
    expect(
      initialAmount(
        offer({ suggestedBidCents: null, likelyBand: { fromCents: 21_000, toCents: 22_000 } }),
        null,
      ),
    ).toBe(21_000);
  });

  it('slider spans half the public price to 10% over it, and always includes the amount', () => {
    expect(sliderRange(offer(), 22_900)).toEqual({ min: 13_000, max: 31_000 });
    expect(sliderRange(offer(), 50_000).max).toBe(50_000);
  });
});

describe('copy', () => {
  it('warns above the public price, with the ticket copy', () => {
    expect(
      overPublicWarning(
        23_900,
        offer({ publicOffer: { merchant: null, priceCents: 21_900, url: null, updatedAt: null } })
          .publicOffer,
      ),
    ).toBe('Another store sells it for $219 today. Still bid $239?');
    expect(overPublicWarning(21_900, offer().publicOffer)).toBeNull();
    expect(overPublicWarning(99_900, null)).toBeNull();
  });

  it('labels the hold button by method', () => {
    expect(holdLabel('PAYPAL', 22_900)).toBe('Hold $229 with PayPal');
    expect(holdLabel('CARD', 22_950)).toBe('Hold $229.50 with card');
    expect(holdLabel('TEST_CARD', 22_900)).toBe('Hold $229 with sandbox test card');
  });

  it('anchors on the public price and hints with the band or the suggestion', () => {
    expect(anchorText(offer())).toBe('Cheapest public price $279 at retailer.example');
    expect(anchorText(offer({ publicOffer: null }))).toBeNull();
    expect(priceHint(offer({ likelyBand: { fromCents: 21_000, toCents: 22_000 } }))).toBe(
      'Bids between $210 and $220 are most likely to clear.',
    );
    expect(priceHint(offer())).toMatch(/We suggest \$229/);
  });

  it('formats the countdown', () => {
    expect(countdownText(0)).toBeNull();
    expect(countdownText(65_000)).toBe('1m 05s');
    expect(countdownText(3_600_000 * 4 + 61_000)).toBe('4h 01m 01s');
    expect(countdownText(86_400_000 + 3_600_000)).toBe('1d 01h 00m');
  });

  it('raises by at least $1 or 1%', () => {
    expect(minRaiseCents(22_900)).toBe(23_129);
    expect(minRaiseCents(5_000)).toBe(5_100);
  });
});

describe('states', () => {
  it('picks the page mode', () => {
    expect(offerMode(offer())).toBe('bid');
    expect(
      offerMode(
        offer({
          myBid: {
            bidId: 'b',
            status: 'HELD',
            amountCents: 1,
            paymentMethod: 'TEST_CARD',
            releaseIfCheaper: true,
            placedAt: '',
          },
        }),
      ),
    ).toBe('already_bid');
    expect(offerMode(offer({ biddable: false, status: 'ROUNDS' }))).toBe('rounds');
    expect(offerMode(offer({ biddable: false }))).toBe('closed');
  });

  it('maps hold failures', () => {
    const e = (status: number, code: string, message = '') => ({ status, code, message });
    expect(holdFailure(e(409, 'ALREADY_BID'), 1).kind).toBe('already_bid');
    expect(holdFailure(e(409, 'WINDOW_CLOSED'), 1).kind).toBe('closed');
    expect(holdFailure(e(422, 'HOLD_FAILED'), 22_900)).toEqual({
      kind: 'declined',
      text: "PayPal couldn't hold $229. Try another payment method.",
    });
    expect(holdFailure(e(502, 'PAYPAL_ERROR', 'later'), 1).kind).toBe('retry');
    expect(holdFailure(e(0, 'NETWORK_ERROR'), 1).kind).toBe('retry');
    expect(holdFailure(e(400, 'VALIDATION_ERROR', 'nope'), 1)).toEqual({
      kind: 'message',
      text: 'nope',
    });
  });
});

describe('share-link attribution (HF-055)', () => {
  it('utm_source wins over src; both are normalized; utm_medium is kept', () => {
    expect(attributionOf(new URLSearchParams('utm_source=Email&utm_medium=widget'))).toEqual({
      source: 'email',
      medium: 'widget',
    });
    expect(attributionOf(new URLSearchParams('utm_source=email&src=agent')).source).toBe('email');
    expect(attributionOf(new URLSearchParams('src=agent')).source).toBe('agent');
    expect(attributionOf(new URLSearchParams('utm_source=%3Cx%3E'))).toEqual({
      source: null,
      medium: null,
    });
  });

  it('one click per tab per slug and source; storage failures still log once', () => {
    const m = new Map<string, string>();
    const storage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    expect(claimClick(storage, 'aurel-a7', 'email')).toBe(true);
    expect(claimClick(storage, 'aurel-a7', 'email')).toBe(false);
    expect(claimClick(storage, 'aurel-a7', 'widget')).toBe(true);
    expect(claimClick(storage, 'other', 'email')).toBe(true);
    expect(claimClick(null, 'aurel-a7', 'email')).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
    };
    expect(claimClick(broken, 'aurel-a7', 'email')).toBe(true);
  });
});

describe('v4 W12 slider band and other method', () => {
  it('places the likely-clearing band on the slider track', () => {
    expect(
      bandPosition({ min: 10_000, max: 30_000 }, { fromCents: 20_000, toCents: 25_000 }),
    ).toEqual({
      left: 50,
      width: 25,
    });
    // Clipped to the track; nothing when outside or missing.
    expect(
      bandPosition({ min: 10_000, max: 20_000 }, { fromCents: 18_000, toCents: 25_000 }),
    ).toEqual({
      left: 80,
      width: 20,
    });
    expect(
      bandPosition({ min: 10_000, max: 20_000 }, { fromCents: 25_000, toCents: 30_000 }),
    ).toBeNull();
    expect(bandPosition({ min: 10_000, max: 20_000 }, null)).toBeNull();
  });

  it('offers the other payment method after a declined hold', () => {
    expect(otherMethod('PAYPAL', true)).toBe('CARD');
    expect(otherMethod('PAYPAL', false)).toBeNull();
    expect(otherMethod('CARD', true)).toBe('PAYPAL');
  });
});
