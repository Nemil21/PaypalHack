import type { BrandListingView, ListingStatus } from '@holdfast/shared';
import { offerPathOf } from '@holdfast/shared';
import { parseSourceParam } from './offer';

/**
 * W10 embed widget & share links (HF-055; features/14, screens.md §W10) with no React in it, so
 * it is unit-tested. The page (routes/brand/EmbedPage.tsx) renders what these return.
 */

/** `GET /api/listings/:id/share` (apps/api/src/routes/share.ts; packages/core offers/share.ts). */
export interface SourceStats {
  source: string;
  clicks: number;
  bids: number;
  heldCents: number;
}

export interface ShareStats {
  listingId: string;
  slug: string | null;
  status: ListingStatus;
  biddable: boolean;
  sources: SourceStats[];
  totals: Omit<SourceStats, 'source'>;
}

export type WidgetTheme = 'light' | 'dark';

/** UTM builder presets; "custom" takes any letters, digits, - or _. */
export const SOURCE_PRESETS = ['email', 'newsletter', 'instagram', 'ads', 'site'] as const;

/** The widget's own default source (widget.js `data-source`). */
export const WIDGET_SOURCE = 'widget';

/** Typed source → the stored key, or null with the reason to show under the field. */
export function sourceFrom(raw: string): { source: string | null; error: string | null } {
  if (!raw.trim()) return { source: null, error: 'Enter a source, like "spring-email".' };
  const s = parseSourceParam(raw.trim());
  return s
    ? { source: s, error: null }
    : { source: null, error: 'Use up to 32 letters, digits, - or _.' };
}

/** `https://<app>/o/<slug>?utm_source=email` (features/14 §Logic 1). */
export function shareLink(origin: string, slug: string, source: string): string {
  return `${origin}${offerPathOf(slug)}?utm_source=${encodeURIComponent(source)}`;
}

/** The one-line script tag a brand pastes (features/14 §Logic 1). */
export function widgetSnippet(
  origin: string,
  slug: string,
  theme: WidgetTheme,
  source: string = WIDGET_SOURCE,
): string {
  const src = source === WIDGET_SOURCE ? '' : ` data-source="${source}"`;
  return `<script src="${origin}/widget.js" data-listing="${slug}" data-theme="${theme}"${src} async></script>`;
}

/** The labelled mock store page (public/demo/aurel-store.html) with the widget on it. */
export function previewPath(slug: string, theme: WidgetTheme): string {
  const q = new URLSearchParams({ listing: slug, theme, source: 'preview' });
  return `/demo/aurel-store.html?${q.toString()}`;
}

/** Listings that have an offer page, live ones first (then newest, as the API orders them). */
export function shareableListings(listings: BrandListingView[]): BrandListingView[] {
  const live = (s: ListingStatus) => s === 'OPEN' || s === 'ROUNDS';
  return listings
    .filter((l) => l.slug && l.status !== 'DRAFT')
    .map((l, i) => ({ l, i }))
    .sort((a, b) => Number(live(b.l.status)) - Number(live(a.l.status)) || a.i - b.i)
    .map(({ l }) => l);
}

/** One SVG path for a QR matrix (`true` = dark), one 1×1 square per dark module. */
export function qrPath(matrix: boolean[][]): string {
  let d = '';
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return d;
}

/** "3 bids from 40 clicks" → conversion, or null with no clicks. */
export function conversion(s: Pick<SourceStats, 'clicks' | 'bids'>): string | null {
  if (s.clicks === 0) return null;
  return `${Math.round((s.bids / s.clicks) * 100)}%`;
}

/** Total conversion over tracked sources only: direct bids have no clicks to convert from. */
export function trackedConversion(sources: SourceStats[]): string | null {
  const tracked = sources.filter((s) => s.clicks > 0);
  return conversion({
    clicks: tracked.reduce((n, s) => n + s.clicks, 0),
    bids: tracked.reduce((n, s) => n + s.bids, 0),
  });
}

/**
 * W06 "Share offer link" toast line from `GET /api/listings/:id/share` (UI-GAPS W06): how the
 * link is doing so far, or a warning when the window is not taking bids.
 */
export function shareSummary(stats: Pick<ShareStats, 'biddable' | 'totals'>): string {
  if (!stats.biddable) return 'This window is not taking new bids right now.';
  const { clicks, bids } = stats.totals;
  const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  return `${plural(clicks, 'click')} · ${plural(bids, 'bid')} from shared links so far.`;
}
