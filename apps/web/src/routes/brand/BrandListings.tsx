import { useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../../components/layout/AppShell';
import { Badge, ButtonLink, EmptyState, ErrorBanner, Skeleton } from '../../components/ui';
import { canCreateListing } from '../../lib/brand-overview';
import {
  filterCounts,
  LISTING_FILTERS,
  listingRow,
  matchesFilter,
  type ListingFilter,
  type ListingRowView,
} from '../../lib/brand-listings';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';
import { useBrand } from './BrandGate';
import { DraftActions } from './DraftActions';
import { useNow, useOverview } from './use-overview';

/**
 * v4 My listings (frame 111:194; replaces the `/brand#listings` anchor): filter tabs and one row
 * per listing from `GET /api/brands/me/overview`. A row opens its console; drafts get
 * Publish · Edit in place.
 */
export function BrandListings() {
  const { me, listings, reloadListings } = useBrand();
  const { overview, error, retry } = useOverview();
  const now = useNow();
  const [filter, setFilter] = useState<ListingFilter>('all');

  const cards = overview?.listings ?? [];
  const counts = filterCounts(cards);
  const rows = cards
    .filter((c) => matchesFilter(c.status, filter))
    .map((c) =>
      listingRow(
        c,
        listings.find((l) => l.listingId === c.listingId),
        now,
      ),
    );
  const canEdit = canCreateListing(me.role);
  const verified =
    (overview?.brand.verificationStatus ?? me.brand.verificationStatus) === 'VERIFIED';
  const onChanged = () => {
    retry();
    reloadListings();
  };
  const cta = canEdit ? <ButtonLink to={paths.newListing}>+ New listing</ButtonLink> : null;

  return (
    <div className="min-w-0">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <PageHeader
          eyebrow={`${me.brand.name} · ${counts.all} ${counts.all === 1 ? 'listing' : 'listings'}`}
          title="My listings"
        />
        {cta && <div className="pb-8 lg:pb-12">{cta}</div>}
      </div>

      {error && !overview ? (
        <ErrorBanner message={error.message} onRetry={retry} />
      ) : !overview ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-10 w-full max-w-[600px]" />
          <Skeleton className="h-[320px] w-full" />
        </div>
      ) : cards.length === 0 ? (
        <EmptyState
          message="No listings yet. Create one to start collecting held bids."
          action={cta}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {error && <ErrorBanner message="Live updates paused." onRetry={retry} />}
          <div
            role="tablist"
            aria-label="Filter listings"
            className="flex max-w-full gap-1 self-start overflow-x-auto rounded-md bg-surface p-1"
          >
            {LISTING_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'h-8 shrink-0 rounded-sm px-3 font-mono text-[12px] whitespace-nowrap',
                  filter === f.key ? 'bg-white text-ink shadow-sm' : 'text-body hover:text-ink',
                )}
              >
                {f.label} · {counts[f.key]}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="rounded-md border border-line p-6 text-[14px] text-body">
              Nothing here yet.
            </p>
          ) : (
            <>
              <ListingsTable
                rows={rows}
                canEdit={canEdit}
                verified={verified}
                onChanged={onChanged}
              />
              <ListingsList
                rows={rows}
                canEdit={canEdit}
                verified={verified}
                onChanged={onChanged}
              />
            </>
          )}
          <p className="text-[13px] text-muted">
            Click a row to open its console. Drafts can be published or edited here.
          </p>
        </div>
      )}
    </div>
  );
}

interface RowsProps {
  rows: ListingRowView[];
  canEdit: boolean;
  verified: boolean;
  onChanged(): void;
}

function Thumb({ row }: { row: ListingRowView }) {
  return row.imageUrl ? (
    <img
      src={row.imageUrl}
      alt=""
      className="size-10 shrink-0 rounded-sm border border-line bg-white object-contain"
    />
  ) : (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-charcoal font-mono text-[11px] text-white"
    >
      {row.initials}
    </span>
  );
}

function Draft({ row, ...p }: { row: ListingRowView } & Omit<RowsProps, 'rows'>) {
  if (!p.canEdit) return null;
  return (
    <DraftActions
      compact
      listingId={row.listingId}
      quantity={row.units}
      verified={p.verified}
      onChanged={p.onChanged}
    />
  );
}

/** Desktop table (md and up). */
function ListingsTable({ rows, ...p }: RowsProps) {
  const th = 'label px-4 py-3 text-left text-[11px] font-normal text-muted';
  return (
    <div className="hidden overflow-hidden rounded-md border border-line md:block">
      <table className="w-full border-collapse text-[14px]">
        <thead className="bg-surface">
          <tr>
            <th className={th}>Product</th>
            <th className={th}>Status</th>
            <th className={th}>Held</th>
            <th className={th}>Bids</th>
            <th className={th}>Units</th>
            <th className={th}>Floor</th>
            <th className={th}>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.listingId} className="border-t border-line hover:bg-surface/60">
              <td className="px-4 py-3">
                <Link to={r.href} className="flex items-center gap-3 text-ink hover:underline">
                  <Thumb row={r} />
                  <span className="min-w-0 truncate">{r.title}</span>
                </Link>
              </td>
              <td className="px-4 py-3">
                <Badge tone={r.tone}>{r.pill}</Badge>
              </td>
              <td className="px-4 py-3 text-[16px] text-ink tabular-nums">{r.money}</td>
              <td className="px-4 py-3 text-ink tabular-nums">{r.bids}</td>
              <td className="px-4 py-3 text-ink tabular-nums">{r.units}</td>
              <td className="px-4 py-3 text-ink tabular-nums">{r.floor}</td>
              <td className="px-4 py-3 font-mono text-[12px] text-body tabular-nums">
                {r.draft ? <Draft row={r} {...p} /> : r.time}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Phone list (below md): one card per listing, no horizontal scroll at 375 px. */
function ListingsList({ rows, ...p }: RowsProps) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line md:hidden">
      {rows.map((r) => (
        <li key={r.listingId} className="flex flex-col gap-2 p-3">
          <Link to={r.href} className="flex items-center gap-3">
            <Thumb row={r} />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[15px] text-ink">{r.title}</span>
              <Badge tone={r.tone} className="self-start">
                {r.pill}
              </Badge>
            </span>
          </Link>
          <p className="text-[13px] text-body tabular-nums">
            {r.money} · {r.bids} bids · {r.units} units · floor {r.floor}
          </p>
          {r.draft ? (
            <Draft row={r} {...p} />
          ) : (
            r.time && <p className="font-mono text-[12px] text-muted">{r.time}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
