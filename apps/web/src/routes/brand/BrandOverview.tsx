import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router';
import type { BrandOverview as Overview } from '@holdfast/shared';
import { PageHeader } from '../../components/layout/AppShell';
import {
  Badge,
  ButtonLink,
  EmptyState,
  ErrorBanner,
  Skeleton,
  StatTile,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import {
  activityText,
  BRAND_NAV,
  canCreateListing,
  cardView,
  OVERVIEW_POLL_MS,
  overviewState,
  sparklinePoints,
  streamedListingIds,
  verificationBanner,
  type CardView,
} from '../../lib/brand-overview';
import { cn } from '../../lib/cn';
import { formatUsdCompact } from '../../lib/console/kpis';
import { createCoalescedRefetch } from '../../lib/console/refetch';
import { subscribeListingEvents } from '../../lib/listing-events';
import { paths } from '../../lib/routes';
import { NotificationBell } from '../../components/NotificationBell';
import { formatWhen } from '../bids/format';
import { useBrand } from './BrandGate';

/**
 * W04 brand overview (HF-026; screens.md §W04, features/08 §Overview W04): KPI row, one card per
 * listing (→ W06), "New listing" (→ W05) and the activity feed. Live: SSE notices from the
 * listings that can still change → one coalesced refetch, plus a slow poll for everything else.
 */
export function BrandOverview() {
  const { me } = useBrand();
  const { overview, error, retry } = useOverview();
  const now = useNow();

  const banner = overview ? verificationBanner(overview.brand.verificationStatus) : null;
  const cta = canCreateListing(me.role) ? (
    <ButtonLink to={paths.newListing}>New listing</ButtonLink>
  ) : null;

  return (
    <div className="flex flex-col lg:flex-row lg:gap-8">
      <BrandNav />
      <div className="min-w-0 flex-1">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <PageHeader eyebrow={me.brand.name} title="Overview" />
          <div className="flex items-center gap-3 pb-8 lg:pb-12">
            <NotificationBell audience="brand" />
            {cta}
          </div>
        </div>

        {banner && (
          <div
            role="status"
            className={cn(
              'mb-6 flex flex-col gap-1 rounded-md border p-4',
              banner.tone === 'rejected'
                ? 'border-danger/30 bg-danger-tint'
                : 'border-orange/30 bg-orange-tint',
            )}
          >
            <p className="text-[15px] font-medium text-ink">{banner.title}</p>
            <p className="text-[14px] text-body">{banner.body}</p>
          </div>
        )}

        {error && !overview ? (
          <ErrorBanner message={error.message} onRetry={retry} />
        ) : !overview ? (
          <OverviewSkeleton />
        ) : overviewState(overview) === 'empty' ? (
          <EmptyState
            message="No windows yet. Create a listing to start collecting held bids."
            action={cta}
          />
        ) : (
          <>
            {error && (
              <ErrorBanner className="mb-4" message="Live updates paused." onRetry={retry} />
            )}
            <KpiRow overview={overview} />
            <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
              <section id="listings" aria-labelledby="listings-h" className="scroll-mt-24">
                <h2 id="listings-h" className="label mb-3 text-[11px] text-muted">
                  Listings
                </h2>
                <ul className="grid gap-4 sm:grid-cols-2">
                  {overview.listings.map((c) => (
                    <li key={c.listingId}>
                      <ListingCard view={cardView(c, now)} />
                    </li>
                  ))}
                </ul>
              </section>
              <ActivityFeed overview={overview} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function useOverview() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const refetch = useMemo(
    () =>
      createCoalescedRefetch(
        () =>
          api
            .request<Overview>({ method: 'GET', path: '/api/brands/me/overview' })
            .then((o) => {
              setOverview(o);
              setError(null);
            })
            .catch((err: unknown) => {
              setError(
                err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Failed to load.'),
              );
            }),
        { debounceMs: 400, maxWaitMs: 2000 },
      ),
    [],
  );

  useEffect(() => {
    refetch.now();
    const id = setInterval(() => refetch.trigger(), OVERVIEW_POLL_MS);
    return () => {
      clearInterval(id);
      refetch.cancel();
    };
  }, [refetch]);

  // One stream per listing that can still change; the set is re-derived when statuses change.
  const streamKey = overview ? streamedListingIds(overview).join(',') : '';
  useEffect(() => {
    if (!streamKey) return;
    const offs = streamKey.split(',').map((id) =>
      subscribeListingEvents(id, {
        onEvent: () => refetch.trigger(),
        onReconnect: () => refetch.now(),
      }),
    );
    return () => offs.forEach((off) => off());
  }, [streamKey, refetch]);

  return { overview, error, retry: () => refetch.now() };
}

/** W04 left nav, shared by the brand screens that have landed (W10 Embed, HF-055). */
export function BrandNav() {
  return (
    <nav
      aria-label="Brand"
      className="-mx-4 overflow-x-auto border-b border-line px-4 pt-4 sm:-mx-8 sm:px-8 lg:mx-0 lg:w-56 lg:shrink-0 lg:overflow-visible lg:border-r lg:border-b-0 lg:px-0 lg:pt-8 lg:pr-4"
    >
      <ul className="flex gap-1 pb-3 lg:flex-col lg:pb-0">
        {BRAND_NAV.map((n) => (
          <li key={n.label} className="shrink-0">
            <NavLink
              to={n.to}
              end
              title={n.soon ? `Arrives with ${n.soon}` : undefined}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-sm px-3 py-2 text-[14px] hover:bg-surface',
                  // "Listings" is a hash link to /brand: only Overview owns that path.
                  isActive && n.label !== 'Listings' ? 'bg-surface text-ink' : 'text-body',
                )
              }
            >
              {n.label}
              {n.soon && (
                <Badge tone="sim" className="text-[10px]">
                  Soon
                </Badge>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function KpiRow({ overview }: { overview: Overview }) {
  const k = overview.kpis;
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <StatTile
        label="Recovered this month"
        value={formatUsdCompact(k.recoveredThisMonthCents)}
        caption="Captured from winners"
        emphasis
      />
      <StatTile
        label="Held demand now"
        value={formatUsdCompact(k.heldNowCents)}
        caption={`${k.liveListings} live ${k.liveListings === 1 ? 'listing' : 'listings'}`}
      />
      <StatTile label="Fees" value={formatUsdCompact(k.feesThisMonthCents)} caption="This month" />
      <StatTile
        label="Payout pending"
        value={formatUsdCompact(k.payoutPendingCents)}
        caption="Net, to your PayPal"
      />
    </div>
  );
}

function ListingCard({ view: v }: { view: CardView }) {
  return (
    <Link
      to={v.href}
      className="flex h-full flex-col gap-3 rounded-md border border-line bg-white p-4 hover:border-ink focus-visible:border-ink"
    >
      <div className="flex items-start gap-3">
        {v.imageUrl ? (
          <img
            src={v.imageUrl}
            alt=""
            className="size-14 shrink-0 rounded-sm border border-line object-contain"
          />
        ) : (
          <span aria-hidden className="size-14 shrink-0 rounded-sm border border-line bg-surface" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[15px] font-medium text-ink">{v.title}</span>
          <Badge tone={v.tone} className="self-start">
            {v.pill}
          </Badge>
        </div>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[24px] leading-[30px] font-medium tracking-headline text-ink tabular-nums">
            {v.held}
          </span>
          <span className="text-[13px] text-body">
            {v.heldLabel}
            {v.bids && ` · ${v.bids}`}
          </span>
        </div>
        <Sparkline values={v.sparkline} />
      </div>
      {v.timeLeft && <span className="text-[13px] text-muted tabular-nums">{v.timeLeft}</span>}
    </Link>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 120;
  const h = 32;
  if (values.length < 2) return <span className="h-8 w-[120px]" aria-hidden />;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`-1 -1 ${w + 2} ${h + 2}`}
      role="img"
      aria-label="Held dollars by hour"
      className="shrink-0 text-orange"
    >
      <polyline
        points={sparklinePoints(values, w, h)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActivityFeed({ overview }: { overview: Overview }) {
  return (
    <section aria-labelledby="activity-h">
      <h2 id="activity-h" className="label mb-3 text-[11px] text-muted">
        Activity
      </h2>
      {overview.activity.length === 0 ? (
        <p className="text-[14px] text-body">Bids, settlement and payouts show up here.</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line rounded-md border border-line bg-white">
          {overview.activity.map((a) => {
            const t = activityText(a);
            return (
              <li key={a.id} className="flex flex-col gap-0.5 px-4 py-3">
                <span className="flex items-baseline justify-between gap-2 text-[14px] text-ink">
                  <span>
                    {a.kind === 'AGENT' && (
                      <Badge tone="dark" className="mr-2 text-[10px]">
                        Agent
                      </Badge>
                    )}
                    {t.text}
                  </span>
                  {t.amount && <span className="tabular-nums">{t.amount}</span>}
                </span>
                <span className="text-[12px] text-muted">
                  {a.listingTitle ? `${a.listingTitle} · ` : ''}
                  {formatWhen(a.at)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {['Recovered this month', 'Held demand now', 'Fees', 'Payout pending'].map((l) => (
          <StatTile key={l} label={l} value={undefined} />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-[150px] w-full" />
        <Skeleton className="h-[150px] w-full" />
      </div>
    </div>
  );
}
