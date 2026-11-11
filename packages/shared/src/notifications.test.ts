import { describe, expect, it } from 'vitest';
import { AFFILIATE_DISCLOSURE, BANK_PENDING_NOTE } from './copy.js';
import {
  dedupeKey,
  formatCompactUsd,
  formatWindowTime,
  NOTIFICATION_TEMPLATES,
  recipientTypeOf,
  renderNotification,
  UNIFORM_PRICE_PATTERNS,
  type NotificationPayloads,
  type NotificationTemplate,
} from './notifications.js';

const bid = { bidId: 'b1', listingId: 'l1' };

/** One example payload per template (the features/13 table's numbers). */
const EXAMPLES: { [T in NotificationTemplate]: NotificationPayloads[T] } = {
  bid_held: { ...bid, amountCents: 22900, windowClosesAt: '2026-11-19T18:00:00Z' },
  price_drop_released: {
    ...bid,
    amountCents: 24900,
    publicPriceCents: 24500,
    merchant: null,
    url: 'https://example.com/buy',
  },
  below_clearing: { ...bid, amountCents: 20000, likelyCents: 21900 },
  round_nudge: {
    ...bid,
    nudgeId: 'n1',
    yourBidCents: 21900,
    cutoffCents: 24000,
    targetQuantity: 240,
    suggestedCents: 24100,
  },
  bid_rolled: { ...bid, amountCents: 21000, brandName: 'Aurel Audio' },
  won: { ...bid, amountCents: 22900 },
  promoted: { ...bid, amountCents: 21900 },
  reserve: { ...bid, amountCents: 21500 },
  lost: { ...bid, amountCents: 22900 },
  payment_failed: { ...bid, amountCents: 22900 },
  shipped: { ...bid, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' },
  brand_demand_milestone: {
    listingId: 'l1',
    thresholdCents: 5_000_000,
    heldCents: 6_100_000,
    floorCents: 21900,
  },
  brand_window_closing: {
    listingId: 'l1',
    hoursLeft: 6,
    quantity: 240,
    lowestWinningCents: 21900,
    heldBids: 311,
  },
  brand_cleared: {
    listingId: 'l1',
    units: 240,
    lowestCents: 21900,
    grossCents: 240 * 22600,
    payoutNetCents: 4_940_000,
  },
  brand_payout_failed: { listingId: 'l1' },
};

const render = <T extends NotificationTemplate>(t: T) =>
  renderNotification(t, EXAMPLES[t], { timeZone: 'America/Los_Angeles' });

describe('notification templates (HF-054a, D14 copy)', () => {
  it('renders every template (copy snapshot)', () => {
    const bodies = Object.fromEntries(NOTIFICATION_TEMPLATES.map((t) => [t, render(t).body]));
    expect(bodies).toMatchInlineSnapshot(`
      {
        "below_clearing": "Bids around $219 are likely to clear. Your bid is $200. Raise?",
        "bid_held": "$229 held, not charged. Window closes Thu 10 am.",
        "bid_rolled": "Your agent re-bid $210 in Aurel Audio's new window. $210 held, not charged.",
        "brand_cleared": "Cleared 240 units. Each winner is charged their own bid (lowest $219, average $226). Payout $49.4k on its way.",
        "brand_demand_milestone": "$61k now held at ≥ $219.",
        "brand_payout_failed": "Payout failed; we're retrying.",
        "brand_window_closing": "Window closes in 6 h. Recommended: clear 240 units; each winner pays their own bid (lowest $219).",
        "lost": "Didn't clear this time. $229 released. Your bank may show it as pending for a few days. Keep bidding?",
        "payment_failed": "PayPal couldn't charge your card; you didn't get this one. Nothing was charged.",
        "price_drop_released": "A store sells it for $245 now. We released your $249 hold. Your bank may show it as pending for a few days.",
        "promoted": "A unit opened up. You won at your bid of $219. Charged $219.",
        "reserve": "You're on the reserve list. Your $215 hold stays until clearing finishes.",
        "round_nudge": "You're out at $219. The cutoff for 240 units is $240. Raise to $241?",
        "shipped": "On its way: UPS 1Z999AA10123456784",
        "won": "You won at your bid of $229. Charged $229.",
      }
    `);
  });

  it('won is pay-your-bid: "You won at your bid of $229. Charged $229."', () => {
    expect(render('won').body).toBe('You won at your bid of $229. Charged $229.');
  });

  it('every release message adds the bank-pending note', () => {
    for (const t of ['price_drop_released', 'lost'] as const) {
      expect(render(t).body).toContain(BANK_PENDING_NOTE);
    }
  });

  it('reserve-list losers are told they are on the reserve list (hold not released yet)', () => {
    const body = render('reserve').body;
    expect(body).toContain('on the reserve list');
    expect(body).not.toMatch(/released|charged/i);
  });

  it('"charged" appears only for captured outcomes', () => {
    for (const t of NOTIFICATION_TEMPLATES) {
      const { body } = render(t);
      if (/\bCharged\b/.test(body)) expect(['won', 'promoted']).toContain(t);
    }
  });

  it('no template uses uniform-price wording', () => {
    for (const t of NOTIFICATION_TEMPLATES) {
      const { title, body } = render(t);
      for (const re of UNIFORM_PRICE_PATTERNS) expect(`${title} ${body}`).not.toMatch(re);
    }
    // Including the edge shapes: one unit, and a window with too few bids to recommend.
    const one = renderNotification('brand_cleared', {
      ...EXAMPLES.brand_cleared,
      units: 1,
      lowestCents: 22900,
      grossCents: 22900,
    });
    const few = renderNotification('brand_window_closing', {
      ...EXAMPLES.brand_window_closing,
      lowestWinningCents: null,
      heldBids: 3,
    });
    for (const re of UNIFORM_PRICE_PATTERNS) {
      expect(one.body).not.toMatch(re);
      expect(few.body).not.toMatch(re);
    }
    expect(one.body).toContain('their own bid of $229');
    expect(few.body).toBe('Window closes in 6 h. 3 bids held for 240 units so far.');
  });

  it('the price-drop buy link carries the affiliate disclosure; names the store when known', () => {
    const r = render('price_drop_released');
    expect(r.link).toEqual({ href: 'https://example.com/buy', label: 'Buy there →' });
    expect(r.disclosure).toBe(AFFILIATE_DISCLOSURE);
    const named = renderNotification('price_drop_released', {
      ...EXAMPLES.price_drop_released,
      merchant: 'Best Buy',
      url: null,
    });
    expect(named.body.startsWith('Best Buy sells it for $245 now.')).toBe(true);
    expect(named.disclosure).toBeNull();
    expect(named.link).toEqual({ href: '/bids/b1', label: 'View bid' });
  });

  it('in-app links are plain paths with no query string', () => {
    for (const t of NOTIFICATION_TEMPLATES) {
      const href = render(t).link?.href;
      if (href && href.startsWith('/')) expect(href).not.toContain('?');
    }
  });

  it('recipients, dedupe keys and number formats', () => {
    expect(recipientTypeOf('won')).toBe('SHOPPER');
    expect(recipientTypeOf('brand_cleared')).toBe('BRAND');
    expect(dedupeKey('won', 'abc')).toBe('won:abc');
    expect(formatCompactUsd(6_100_000)).toBe('$61k');
    expect(formatCompactUsd(4_940_000)).toBe('$49.4k');
    expect(formatCompactUsd(1_000_000)).toBe('$10k');
    expect(formatCompactUsd(22900)).toBe('$229');
    expect(formatWindowTime('2026-11-19T18:30:00Z', 'UTC')).toBe('Thu 6:30 pm');
  });
});
