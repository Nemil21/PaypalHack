import {
  AFFILIATE_DISCLOSURE,
  BANK_PENDING_NOTE,
  promotedMessage,
  releasedHoldMessage,
  winnersChargedLine,
  wonMessage,
} from './copy.js';
import { formatUsd } from './money.js';

/**
 * Notification templates (HF-054a; features/13-notifications.md §Templates). `notify()` in
 * `@holdfast/core` stores `{template, payload}`; every surface (the in-app bell, HF-054b's email,
 * push and the M11 set) renders the words here, so the D14 money-copy rules hold everywhere:
 * "held" before a capture, "charged" only after it, every release adds the bank-pending note,
 * and pay-your-bid wording only (each winner pays their own bid, never a common price).
 *
 * Payloads carry amounts, names and our own ids only: never card or PayPal ids.
 */

export const SHOPPER_TEMPLATES = [
  'bid_held',
  'price_drop_released',
  'below_clearing',
  'round_nudge',
  'bid_rolled',
  'won',
  'promoted',
  'reserve',
  'lost',
  'payment_failed',
  'shipped',
] as const;

export const BRAND_TEMPLATES = [
  'brand_demand_milestone',
  'brand_window_closing',
  'brand_cleared',
  'brand_payout_failed',
] as const;

export const NOTIFICATION_TEMPLATES = [...SHOPPER_TEMPLATES, ...BRAND_TEMPLATES] as const;
export type ShopperTemplate = (typeof SHOPPER_TEMPLATES)[number];
export type BrandTemplate = (typeof BRAND_TEMPLATES)[number];
export type NotificationTemplate = ShopperTemplate | BrandTemplate;

export type NotificationRecipientType = 'SHOPPER' | 'BRAND';

/** Held-demand milestones for `brand_demand_milestone` (features/13: $10k / $25k / $50k). */
export const DEMAND_MILESTONES_CENTS = [1_000_000, 2_500_000, 5_000_000] as const;
/** `brand_window_closing` fires this long before the window closes. */
export const WINDOW_CLOSING_LEAD_MS = 6 * 60 * 60 * 1000;
/** `below_clearing` fires once per window, this long before it closes. */
export const BELOW_CLEARING_LEAD_MS = 12 * 60 * 60 * 1000;

interface BidRef {
  bidId: string;
  listingId: string;
}

export interface NotificationPayloads {
  bid_held: BidRef & { amountCents: number; windowClosesAt: string | null };
  price_drop_released: BidRef & {
    amountCents: number;
    publicPriceCents: number | null;
    merchant: string | null;
    /** The retailer's page (Channel3 affiliate link); rendered with `AFFILIATE_DISCLOSURE`. */
    url: string | null;
  };
  below_clearing: BidRef & { amountCents: number; likelyCents: number };
  round_nudge: BidRef & {
    nudgeId: string;
    yourBidCents: number;
    cutoffCents: number;
    targetQuantity: number;
    suggestedCents: number;
  };
  bid_rolled: BidRef & { amountCents: number; brandName: string | null };
  won: BidRef & { amountCents: number };
  promoted: BidRef & { amountCents: number };
  reserve: BidRef & { amountCents: number };
  lost: BidRef & { amountCents: number };
  payment_failed: BidRef & { amountCents: number };
  shipped: BidRef & { carrier: string | null; trackingNumber: string | null };
  brand_demand_milestone: {
    listingId: string;
    thresholdCents: number;
    heldCents: number;
    floorCents: number;
  };
  brand_window_closing: {
    listingId: string;
    hoursLeft: number;
    quantity: number;
    /** Lowest bid among the top `quantity` held bids; null when fewer bids than units. */
    lowestWinningCents: number | null;
    heldBids: number;
    /** Every held bid's dollars (M10 push: "Window closes in 6 h · $61k held"). Absent on rows
     * queued before HF-061; the title then reads "Window closing soon". */
    heldCents?: number;
  };
  brand_cleared: {
    listingId: string;
    units: number;
    lowestCents: number;
    grossCents: number;
    payoutNetCents: number;
  };
  brand_payout_failed: { listingId: string };
}

export type NotificationPayload<T extends NotificationTemplate = NotificationTemplate> =
  NotificationPayloads[T];

export interface RenderedNotification {
  title: string;
  body: string;
  /** In-app path (no personal data in the query string) or a retailer URL. */
  link: { href: string; label: string } | null;
  /** Affiliate disclosure, shown next to a Channel3 buy link. */
  disclosure: string | null;
}

export interface RenderOptions {
  /** IANA time zone for times in the copy (the browser's own; UTC on the server). */
  timeZone?: string;
}

export function isNotificationTemplate(t: string): t is NotificationTemplate {
  return (NOTIFICATION_TEMPLATES as readonly string[]).includes(t);
}

export function recipientTypeOf(t: NotificationTemplate): NotificationRecipientType {
  return (BRAND_TEMPLATES as readonly string[]).includes(t) ? 'BRAND' : 'SHOPPER';
}

/** `<template>:<entity_id>`, the `notifications.dedupe_key` (one row per template per event). */
export function dedupeKey(template: NotificationTemplate, entityId: string): string {
  return `${template}:${entityId}`;
}

/** "$61k", "$49.4k", "$1.2M"; under $1,000 the exact `formatUsd`. */
export function formatCompactUsd(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) < 1000) return formatUsd(Math.round(cents));
  const [n, unit] = Math.abs(dollars) >= 1_000_000 ? [dollars / 1e6, 'M'] : [dollars / 1e3, 'k'];
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `$${rounded}${unit}`;
}

/** "Thu 6 pm", "Thu 6:30 pm" in `timeZone` (default UTC). */
export function formatWindowTime(iso: string, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const minute = get('minute');
  const time = minute === '00' ? get('hour') : `${get('hour')}:${minute}`;
  return `${get('weekday')} ${time} ${get('dayPeriod').toLowerCase()}`;
}

const bidLink = (bidId: string, label = 'View bid') => ({
  href: `/bids/${encodeURIComponent(bidId)}`,
  label,
});
/** W18 won page: receipt and tracking (v4: wins, promotions and shipping deep-link here). */
const wonLink = (bidId: string, label = 'View receipt & tracking') => ({
  href: `/bids/${encodeURIComponent(bidId)}/won`,
  label,
});
const listingLink = (listingId: string, label = 'Open listing') => ({
  href: `/brand/listings/${encodeURIComponent(listingId)}`,
  label,
});
const settlementLink = (listingId: string) => ({
  href: `/brand/listings/${encodeURIComponent(listingId)}/settlement`,
  label: 'View settlement',
});

type Renderers = {
  [T in NotificationTemplate]: (
    p: NotificationPayloads[T],
    o: RenderOptions,
  ) => RenderedNotification;
};

const plain = (
  title: string,
  body: string,
  link: RenderedNotification['link'] = null,
): RenderedNotification => ({ title, body, link, disclosure: null });

const RENDERERS: Renderers = {
  bid_held: (p, o) =>
    plain(
      'Bid held',
      `${formatUsd(p.amountCents)} held, not charged.` +
        (p.windowClosesAt
          ? ` Window closes ${formatWindowTime(p.windowClosesAt, o.timeZone)}.`
          : ''),
      bidLink(p.bidId),
    ),
  price_drop_released: (p) => {
    const store = p.merchant ? p.merchant : 'A store';
    const lead =
      p.publicPriceCents != null
        ? `${store} sells it for ${formatUsd(p.publicPriceCents)} now. `
        : '';
    return {
      title: 'Cheaper in a store',
      body: `${lead}${releasedHoldMessage(p.amountCents)}`,
      link: p.url ? { href: p.url, label: 'Buy there →' } : bidLink(p.bidId),
      disclosure: p.url ? AFFILIATE_DISCLOSURE : null,
    };
  },
  below_clearing: (p) =>
    plain(
      'Your bid may not clear',
      `Bids around ${formatUsd(p.likelyCents)} are likely to clear. Your bid is ${formatUsd(p.amountCents)}. Raise?`,
      bidLink(p.bidId, 'Raise'),
    ),
  round_nudge: (p) =>
    plain(
      "You're out this round",
      `You're out at ${formatUsd(p.yourBidCents)}. The cutoff for ${p.targetQuantity} ${p.targetQuantity === 1 ? 'unit' : 'units'} is ${formatUsd(p.cutoffCents)}. Raise to ${formatUsd(p.suggestedCents)}?`,
      bidLink(p.bidId, 'Raise'),
    ),
  bid_rolled: (p) =>
    plain(
      'Your agent re-bid',
      `Your agent re-bid ${formatUsd(p.amountCents)} in ${p.brandName ? `${p.brandName}'s` : 'a'} new window. ${formatUsd(p.amountCents)} held, not charged.`,
      bidLink(p.bidId),
    ),
  won: (p) => plain('You won', wonMessage(p.amountCents, { captured: true }), wonLink(p.bidId)),
  promoted: (p) =>
    plain('You won', promotedMessage(p.amountCents, { captured: true }), wonLink(p.bidId)),
  reserve: (p) =>
    plain(
      "You're on the reserve list",
      `You're on the reserve list. Your ${formatUsd(p.amountCents)} hold stays until clearing finishes.`,
      bidLink(p.bidId),
    ),
  lost: (p) =>
    plain(
      "Didn't clear this time",
      `Didn't clear this time. ${formatUsd(p.amountCents)} released. ${BANK_PENDING_NOTE} Keep bidding?`,
      bidLink(p.bidId),
    ),
  payment_failed: (p) =>
    plain(
      "Payment didn't go through",
      "PayPal couldn't charge your card; you didn't get this one. Nothing was charged.",
      bidLink(p.bidId),
    ),
  shipped: (p) => {
    const what = [p.carrier, p.trackingNumber].filter(Boolean).join(' ');
    return plain(
      'On its way',
      what ? `On its way: ${what}` : 'On its way.',
      wonLink(p.bidId, 'Track'),
    );
  },
  brand_demand_milestone: (p) =>
    plain(
      `${formatCompactUsd(p.thresholdCents)} held`,
      `${formatCompactUsd(p.heldCents)} now held at ≥ ${formatUsd(p.floorCents)}.`,
      listingLink(p.listingId),
    ),
  brand_window_closing: (p) => {
    const lead = `Window closes in ${p.hoursLeft} h.`;
    const rec =
      p.lowestWinningCents != null
        ? ` Recommended: clear ${p.quantity} ${p.quantity === 1 ? 'unit' : 'units'}; each winner pays their own bid (lowest ${formatUsd(p.lowestWinningCents)}).`
        : ` ${p.heldBids} ${p.heldBids === 1 ? 'bid' : 'bids'} held for ${p.quantity} ${p.quantity === 1 ? 'unit' : 'units'} so far.`;
    const title =
      p.heldCents != null
        ? `Window closes in ${p.hoursLeft} h · ${formatCompactUsd(p.heldCents)} held`
        : 'Window closing soon';
    return plain(title, lead + rec, listingLink(p.listingId, 'Review and clear'));
  },
  brand_cleared: (p) =>
    plain(
      'Cleared',
      `Cleared ${p.units} ${p.units === 1 ? 'unit' : 'units'}. ${winnersChargedLine({
        winners: p.units,
        lowestCents: p.lowestCents,
        grossCents: p.grossCents,
      })} Payout ${formatCompactUsd(p.payoutNetCents)} on its way.`,
      settlementLink(p.listingId),
    ),
  brand_payout_failed: (p) =>
    plain('Payout failed', "Payout failed; we're retrying.", settlementLink(p.listingId)),
};

export function renderNotification<T extends NotificationTemplate>(
  template: T,
  payload: NotificationPayloads[T],
  opts: RenderOptions = {},
): RenderedNotification {
  return (RENDERERS[template] as Renderers[T])(payload, opts);
}

/**
 * Phrases that describe a uniform clearing price. Pay-your-bid (D14) means no notification may
 * use them; the template tests assert it.
 */
export const UNIFORM_PRICE_PATTERNS: readonly RegExp[] = [
  /clearing price/i,
  /everyone pays/i,
  /all winners pay/i,
  /same price/i,
  /uniform/i,
  /single price/i,
  /\bclear(?:ed)? \d+ (?:units? )?at \$/i,
  /\bprice for everyone\b/i,
];

// --- API (`GET /api/notifications`, `POST /api/notifications/:id/read`) -------------------------

export interface NotificationItem {
  id: string;
  template: NotificationTemplate;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

export interface NotificationReadResponse {
  id: string;
  readAt: string;
  unreadCount: number;
}
