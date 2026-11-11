import {
  formatUsd,
  type BrandOverview,
  type OverviewActivity,
  type OverviewListingCard,
} from '@holdfast/shared';
import { formatUsdCompact } from './console/kpis';
import { phaseView, type PhaseTone } from './console/phase';
import { paths } from './routes';

/**
 * W04 brand overview view model (HF-026; screens.md §W04). Pure, so the screen's states, copy and
 * gating are unit-tested without a DOM.
 */

/** Left nav. Payouts / Embed / Settings land with HF-059b / HF-055 / HF-056 (placeholders now). */
export const BRAND_NAV: ReadonlyArray<{ label: string; to: string; soon?: string }> = [
  { label: 'Overview', to: paths.brand },
  { label: 'Listings', to: `${paths.brand}#listings` },
  { label: 'Payouts', to: paths.brandPayouts, soon: 'HF-059b' },
  { label: 'Embed', to: paths.brandEmbed, soon: 'HF-055' },
  { label: 'Settings', to: paths.brandSettings, soon: 'HF-056' },
];

/** Re-read the overview at least this often, even with no SSE notice (payout polls, expiry). */
export const OVERVIEW_POLL_MS = 30_000;
/** Browsers allow ~6 HTTP/1.1 connections per host: never spend them all on overview streams. */
export const OVERVIEW_MAX_STREAMS = 4;

export type OverviewState = 'empty' | 'live';

export function overviewState(o: Pick<BrandOverview, 'listings'>): OverviewState {
  return o.listings.length ? 'live' : 'empty';
}

/**
 * The unverified banner: drafts stay open to an unverified brand (publish is the gated step,
 * HF-011a), so the copy says so instead of blocking the CTA. Null once verified.
 */
export function verificationBanner(
  status: string,
): { tone: 'pending' | 'rejected'; title: string; body: string } | null {
  if (status === 'VERIFIED') return null;
  if (status === 'REJECTED') {
    return {
      tone: 'rejected',
      title: 'Brand verification failed.',
      body: 'You can still prepare drafts. Publishing stays off until verification passes; contact your Holdfast admin.',
    };
  }
  return {
    tone: 'pending',
    title: 'Your brand is not verified yet.',
    body: 'Create drafts now. You can publish them once verification is done.',
  };
}

/** "New listing" (W05): any role that can create a listing, verified or not. */
export function canCreateListing(role: string): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

export interface CardView {
  listingId: string;
  href: string;
  title: string;
  imageUrl: string | null;
  pill: string;
  tone: PhaseTone;
  /** "Closes in 5:12:09", "Clear by Nov 12, 3:04 PM", "Winners charged · paying out". */
  timeLeft: string | null;
  held: string;
  heldLabel: string;
  bids: string;
  sparkline: number[];
}

/** One listing card, recomputed every second so countdowns tick and the pill flips live. */
export function cardView(c: OverviewListingCard, now: number, timeZone?: string): CardView {
  const p = phaseView(c, now, { timeZone });
  const after = ['CLEARING', 'SETTLED', 'PAID_OUT', 'PAYOUT_FAILED'].includes(c.status);
  return {
    listingId: c.listingId,
    href: paths.listingConsole(c.listingId),
    title: c.title ?? 'Untitled listing',
    imageUrl: c.imageUrl,
    pill: p.pill,
    tone: p.tone,
    timeLeft: p.deadline,
    held: formatUsdCompact(after ? c.capturedCents : c.heldCents),
    heldLabel: after ? 'captured' : 'held',
    bids: after || c.status === 'DRAFT' ? '' : `${c.liveBids} ${c.liveBids === 1 ? 'bid' : 'bids'}`,
    sparkline: c.sparkline.points,
  };
}

/** Listings worth a live stream: they can still change (bids, rounds, settlement, payout). */
export function streamedListingIds(o: Pick<BrandOverview, 'listings'>): string[] {
  const order = ['ROUNDS', 'OPEN', 'CLEARING', 'SETTLED'];
  return o.listings
    .filter((l) => order.includes(l.status))
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
    .slice(0, OVERVIEW_MAX_STREAMS)
    .map((l) => l.listingId);
}

const ACTIVITY_COPY: Record<string, string> = {
  BID_HELD: 'New held bid',
  BID_RAISED: 'Bid raised',
  BID_VOIDED: 'Hold released',
  LISTING_CREATED: 'Draft created',
  LISTING_PUBLISHED: 'Window opened',
  LISTING_QUANTITY_RAISED: 'Quantity raised',
  LISTING_CANCELLED: 'Window cancelled',
  LISTING_EXPIRED: 'Window expired',
  ROUND_EXTENDED: 'Round extended',
  LISTING_CLEARED: 'Cleared',
  CAPTURE_SUCCEEDED: 'Winner charged',
  PROMOTED: 'Next bidder promoted',
  LISTING_SETTLED: 'Settlement finished',
  PAYOUT_CREATED: 'Payout created',
  PAYOUT_SUCCEEDED: 'Payout sent',
  PAYOUT_FAILED: 'Payout failed',
};

/** "Agent placed a held bid · $229.00". */
export function activityText(a: OverviewActivity): { text: string; amount: string | null } {
  const base =
    a.kind === 'AGENT' && a.action === 'BID_HELD'
      ? 'Agent placed a held bid'
      : a.kind === 'AGENT' && a.action === 'BID_RAISED'
        ? 'Agent raised a bid'
        : (ACTIVITY_COPY[a.action] ?? a.action.replaceAll('_', ' ').toLowerCase());
  return { text: base, amount: a.amountCents === null ? null : formatUsd(a.amountCents) };
}

/** SVG polyline points for a sparkline in a `w`×`h` box (flat line when every value is equal). */
export function sparklinePoints(values: readonly number[], w: number, h: number): string {
  if (!values.length) return '';
  if (values.length === 1) return `0,${h} ${w},${h}`;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const y = (v: number) => (h - ((v - min) / span) * h).toFixed(1);
  return values.map((v, i) => `${(i * step).toFixed(1)},${y(v)}`).join(' ');
}
