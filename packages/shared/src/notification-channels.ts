import {
  renderNotification,
  type NotificationPayloads,
  type NotificationTemplate,
  type RenderOptions,
} from './notifications.js';

/**
 * Email and web-push forms of the HF-054a templates (HF-054b; features/13 §Channels). Both start
 * from `renderNotification`, so the D14 money copy is word-for-word the in-app bell's: the M11
 * board, the inbox and the phone all say the same thing.
 */

export type NotificationChannel = 'EMAIL' | 'PUSH';

// --- Web push -----------------------------------------------------------------------------------

/** What the service worker (`apps/web/public/sw.js`) shows. Kept small: push payloads cap ~4 KB. */
export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path opened on tap (M06 / M07 / M10 entry points). Never personal data. */
  url: string;
  /** Collapses repeats of one event on the device (`<template>:<entity>`). */
  tag: string;
  /** `test`: the M11 "Send a test" alert. */
  template: NotificationTemplate | 'test';
}

/**
 * Where a tap lands. Price drops open the M06 sheet, raise prompts the M07 sheet, the brand's
 * "window closing" alert the listing (M10, HF-061); everything else follows the in-app link.
 * A retailer link (price drop) is never the tap target: the sheet carries it with the disclosure.
 */
export function pushUrl<T extends NotificationTemplate>(
  template: T,
  payload: NotificationPayloads[T],
): string {
  const p = payload as Partial<{ bidId: string; listingId: string }>;
  const bid = (q = '') => `/bids/${encodeURIComponent(p.bidId ?? '')}${q}`;
  switch (template) {
    case 'price_drop_released':
      return bid('?sheet=drop');
    case 'below_clearing':
      // The likely-clearing band is public book information (floor-blind), not personal data.
      return bid(
        `?sheet=raise&around=${(payload as NotificationPayloads['below_clearing']).likelyCents}`,
      );
    case 'round_nudge':
      return bid('?sheet=raise');
    case 'brand_window_closing':
      return `/brand/listings/${encodeURIComponent(p.listingId ?? '')}`;
  }
  const link = renderNotification(template, payload).link;
  if (link && link.href.startsWith('/')) return link.href;
  return p.bidId ? bid() : '/notifications';
}

export function notificationPush<T extends NotificationTemplate>(
  template: T,
  payload: NotificationPayloads[T],
  tag: string,
  opts: RenderOptions = {},
): PushMessage {
  const r = renderNotification(template, payload, opts);
  return { title: r.title, body: r.body, url: pushUrl(template, payload), tag, template };
}

// --- Email --------------------------------------------------------------------------------------

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export interface EmailOptions extends RenderOptions {
  /** Public origin for links (`APP_BASE_URL`); relative links stay relative without it. */
  baseUrl?: string | null;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function absolute(href: string, baseUrl: string | null | undefined): string {
  if (!href.startsWith('/') || !baseUrl) return href;
  return `${baseUrl.replace(/\/+$/, '')}${href}`;
}

const FOOTER =
  'You get this because you hold a bid or run a listing on Holdfast. PayPal sends its own receipts for charges.';

/**
 * Plain-text and HTML email for one notification. Subject = the bell's title; body = the same
 * words; the link and the affiliate disclosure follow. No card or PayPal ids reach the payload,
 * so none can reach the email.
 */
export function notificationEmail<T extends NotificationTemplate>(
  template: T,
  payload: NotificationPayloads[T],
  opts: EmailOptions = {},
): EmailMessage {
  const r = renderNotification(template, payload, opts);
  const href = r.link ? absolute(r.link.href, opts.baseUrl) : null;
  const text = [
    r.body,
    r.link && href ? `${r.link.label}: ${href}` : null,
    r.disclosure,
    '',
    '— Holdfast',
    FOOTER,
  ]
    .filter((l) => l !== null)
    .join('\n');
  const button =
    r.link && href
      ? `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(r.link.label)}</a></p>`
      : '';
  const disclosure = r.disclosure
    ? `<p style="color:#666;font-size:12px">${escapeHtml(r.disclosure)}</p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;background:#fff"><div style="max-width:520px;margin:0 auto"><p style="font-weight:700;font-size:13px;letter-spacing:.02em;margin:0 0 16px">Holdfast</p><h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(r.title)}</h1><p style="font-size:16px;line-height:1.5;margin:0">${escapeHtml(r.body)}</p>${button}${disclosure}<hr style="border:0;border-top:1px solid #eee;margin:24px 0"><p style="color:#666;font-size:12px;line-height:1.5">${escapeHtml(FOOTER)}</p></div></body></html>`;
  return { subject: r.title, text, html };
}

// --- M11 sample set -----------------------------------------------------------------------------

const sampleBid = {
  bidId: '00000000-0000-4000-8000-000000000001',
  listingId: '00000000-0000-4000-8000-000000000002',
};

/**
 * One example per template with the features/13 numbers: the M11 board's "All templates" set
 * and the channel tests. Ids are placeholders, never real rows.
 */
export const NOTIFICATION_SAMPLES: { [T in NotificationTemplate]: NotificationPayloads[T] } = {
  bid_held: { ...sampleBid, amountCents: 22_900, windowClosesAt: '2026-11-19T18:00:00Z' },
  price_drop_released: {
    ...sampleBid,
    amountCents: 24_900,
    publicPriceCents: 24_500,
    merchant: null,
    url: 'https://example.com/buy',
  },
  below_clearing: { ...sampleBid, amountCents: 20_500, likelyCents: 21_900 },
  round_nudge: {
    ...sampleBid,
    nudgeId: '00000000-0000-4000-8000-000000000003',
    yourBidCents: 21_900,
    cutoffCents: 24_000,
    targetQuantity: 240,
    suggestedCents: 24_100,
  },
  bid_rolled: { ...sampleBid, amountCents: 21_000, brandName: 'Aurel Audio' },
  won: { ...sampleBid, amountCents: 22_900 },
  promoted: { ...sampleBid, amountCents: 21_900 },
  reserve: { ...sampleBid, amountCents: 21_500 },
  lost: { ...sampleBid, amountCents: 22_900 },
  payment_failed: { ...sampleBid, amountCents: 22_900 },
  shipped: { ...sampleBid, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' },
  brand_demand_milestone: {
    listingId: sampleBid.listingId,
    thresholdCents: 5_000_000,
    heldCents: 6_100_000,
    floorCents: 21_900,
  },
  brand_window_closing: {
    listingId: sampleBid.listingId,
    hoursLeft: 6,
    quantity: 240,
    lowestWinningCents: 21_900,
    heldBids: 312,
    heldCents: 6_100_000,
  },
  brand_cleared: {
    listingId: sampleBid.listingId,
    units: 240,
    lowestCents: 21_900,
    grossCents: 5_424_000,
    payoutNetCents: 4_940_000,
  },
  brand_payout_failed: { listingId: sampleBid.listingId },
};
