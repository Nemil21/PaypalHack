import {
  formatUsd,
  type BrandListingView,
  type ListingStatus,
  type OverviewListingCard,
} from '@holdfast/shared';
import { formatUsdCompact } from './console/kpis';
import { formatDeadline, phaseView, type PhaseTone } from './console/phase';
import { paths } from './routes';

/**
 * v4 "My listings" (frame 111:194): filter tabs and table rows over the W04 overview cards
 * (`GET /api/brands/me/overview`), plus the floor from `GET /api/listings`. Pure, so tested
 * without a DOM.
 */

export type ListingFilter = 'all' | 'live' | 'rounds' | 'cleared' | 'draft' | 'closed';

const FILTER_STATUSES: Record<Exclude<ListingFilter, 'all'>, readonly ListingStatus[]> = {
  live: ['OPEN'],
  rounds: ['ROUNDS'],
  cleared: ['CLEARING', 'SETTLED', 'PAID_OUT', 'PAYOUT_FAILED'],
  draft: ['DRAFT'],
  closed: ['CANCELLED', 'EXPIRED'],
};

export const LISTING_FILTERS: ReadonlyArray<{ key: ListingFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'rounds', label: 'Rounds' },
  { key: 'cleared', label: 'Cleared' },
  { key: 'draft', label: 'Draft' },
  { key: 'closed', label: 'Closed' },
];

export function matchesFilter(status: ListingStatus, filter: ListingFilter): boolean {
  return filter === 'all' || FILTER_STATUSES[filter].includes(status);
}

export function filterCounts(
  cards: ReadonlyArray<Pick<OverviewListingCard, 'status'>>,
): Record<ListingFilter, number> {
  const out = { all: 0, live: 0, rounds: 0, cleared: 0, draft: 0, closed: 0 };
  for (const c of cards) {
    for (const f of LISTING_FILTERS) if (matchesFilter(c.status, f.key)) out[f.key] += 1;
  }
  return out;
}

export interface ListingRowView {
  listingId: string;
  href: string;
  title: string;
  imageUrl: string | null;
  /** Two or three letters for the image fallback tile. */
  initials: string;
  pill: string;
  tone: PhaseTone;
  draft: boolean;
  /** Held now (live), captured (after Clear), "—" for a draft. */
  money: string;
  bids: string;
  units: number;
  floor: string;
  time: string;
}

const AFTER_CLEAR: readonly ListingStatus[] = FILTER_STATUSES.cleared;

function initials(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const pick = words.find((w) => /\d/.test(w)) ?? words[1] ?? words[0] ?? '';
  return pick.slice(0, 3).toUpperCase() || '—';
}

export function listingRow(
  c: OverviewListingCard,
  listing: Pick<BrandListingView, 'floorCents'> | undefined,
  now: number,
  timeZone?: string,
): ListingRowView {
  const p = phaseView(c, now, { timeZone });
  const after = AFTER_CLEAR.includes(c.status);
  const draft = c.status === 'DRAFT';
  const title = c.title ?? 'Untitled listing';
  const closed = c.status === 'CANCELLED' || c.status === 'EXPIRED';
  const closedAt = c.windowClosesAt ? formatDeadline(Date.parse(c.windowClosesAt), timeZone) : '';
  return {
    listingId: c.listingId,
    href: paths.listingConsole(c.listingId),
    title,
    imageUrl: c.imageUrl,
    initials: initials(title),
    pill: p.pill,
    tone: p.tone,
    draft,
    money: draft ? '—' : formatUsdCompact(after ? c.capturedCents : c.heldCents),
    bids: draft || after || closed ? '—' : String(c.liveBids),
    units: c.quantity,
    floor: listing ? formatUsd(listing.floorCents) : '—',
    time: draft
      ? ''
      : closed
        ? `${c.status === 'CANCELLED' ? 'Cancelled' : 'Expired'}${closedAt ? ` ${closedAt}` : ''}`
        : (p.deadline ?? ''),
  };
}
