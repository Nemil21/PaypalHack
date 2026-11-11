import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import type { BrandListingView } from '@holdfast/shared';
import { createKpiStore, KpiTile, type KpiKind } from '../../components/console/KpiTiles';
import { Badge, Button, EmptyState, ErrorBanner, useToast } from '../../components/ui';
import { cn } from '../../lib/cn';
import { consoleKpis } from '../../lib/console/kpis';
import { navPhaseLabel, phaseView } from '../../lib/console/phase';
import { useConsoleBook } from '../../lib/console/use-console-book';
import { paths } from '../../lib/routes';
import { useBrand } from './BrandGate';
import { ConsoleHeader, ShareButton } from './ConsoleHeader';

const ConsoleKpiStudio = lazy(() => import('../../components/ag/ConsoleKpiStudio'));

const KPI_KINDS: KpiKind[] = ['held', 'bids', 'projected', 'recovery', 'released'];

/** Re-render every `ms` so countdowns tick and the phase flips when a deadline passes. */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * W06 listing console shell (HF-023): header, AG Studio KPI row and the live wiring later panels
 * plug into (curve + slider HF-024, grid HF-025, brand agent HF-051, rounds HF-037). Live: SSE
 * notices → one debounced book refetch; reconnect → refetch now.
 */
export function ListingConsole() {
  const { listingId = '' } = useParams();
  const { me, listings, reloadListings } = useBrand();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow();

  const live = useConsoleBook(listingId, {
    onPriceDrop: (t) => toast.show({ ...t, duration: 8000 }),
  });
  const { book } = live;

  const phase = useMemo(() => (book ? phaseView(book.listing, now) : null), [book, now]);
  const kpis = useMemo(() => (book ? consoleKpis(book) : null), [book]);
  const store = useMemo(createKpiStore, []);
  useEffect(() => store.set(kpis), [store, kpis]);

  const viewer = me.role === 'VIEWER';
  const locked = phase?.locked ?? false;

  // A live switch into CLEARING (Clear from another tab, or HF-028's modal) hands over to W08.
  const lastPhase = useRef<string | null>(null);
  useEffect(() => {
    if (!phase) return;
    if (lastPhase.current && lastPhase.current !== 'CLEARING' && phase.phase === 'CLEARING') {
      navigate(paths.listingSettlement(listingId));
    }
    lastPhase.current = phase.phase;
  }, [phase, listingId, navigate]);

  if (live.error) {
    return (
      <ConsoleFrame listings={listings} current={listingId}>
        <div className="pt-8">
          <ErrorBanner
            message={
              live.error.status === 404 ? 'We could not find this listing.' : live.error.message
            }
            onRetry={live.error.status === 404 ? undefined : live.refresh}
          />
        </div>
      </ConsoleFrame>
    );
  }

  const empty = book !== null && book.stats.liveBids === 0 && book.pending.length === 0;

  return (
    <ConsoleFrame listings={listings} current={listingId} currentPhase={phase?.phase}>
      <ConsoleHeader
        book={book}
        phase={phase}
        readOnly={viewer}
        onCancelled={() => {
          live.refresh();
          reloadListings();
        }}
      />

      <div className="flex flex-col gap-4 py-6">
        <StatusBanners
          live={live}
          phase={phase?.phase ?? null}
          viewer={viewer}
          listingId={listingId}
        />

        <section aria-label="Key numbers">
          <Suspense fallback={<KpiRowFallback kpis={kpis} />}>
            <ConsoleKpiStudio store={store} />
          </Suspense>
        </section>

        {empty && !locked && (
          <EmptyState
            message="No bids yet. Share your offer link."
            action={<ShareButton slug={book.listing.slug} variant="primary" />}
          />
        )}

        {/* Panels that plug into this shell: curve + slider (HF-024), bids grid (HF-025). */}
        <div
          className={cn('grid gap-4', locked && 'pointer-events-none opacity-60')}
          aria-disabled={locked || undefined}
          data-testid="console-panels"
        />
      </div>
    </ConsoleFrame>
  );
}

function StatusBanners({
  live,
  phase,
  viewer,
  listingId,
}: {
  live: ReturnType<typeof useConsoleBook>;
  phase: string | null;
  viewer: boolean;
  listingId: string;
}) {
  const items: React.ReactNode[] = [];
  if (viewer) {
    items.push(
      <Note key="viewer" tone="neutral">
        View only. Your role can watch this window but not clear or cancel it.
      </Note>,
    );
  }
  if (phase === 'CLEARING') {
    items.push(
      <Note key="clearing" tone="held">
        Clearing. Inputs are locked while winners are charged.{' '}
        <Link className="underline" to={paths.listingSettlement(listingId)}>
          Watch settlement
        </Link>
      </Note>,
    );
  }
  if (phase === 'SETTLED' || phase === 'PAID_OUT' || phase === 'PAYOUT_FAILED') {
    items.push(
      <Note key="settled" tone="neutral">
        This window is cleared.{' '}
        <Link className="underline" to={paths.listingSettlement(listingId)}>
          Open settlement
        </Link>
      </Note>,
    );
  }
  if (phase === 'EXPIRED' || phase === 'CANCELLED') {
    items.push(
      <Note key="closed" tone="neutral">
        {phase === 'EXPIRED' ? 'This window expired.' : 'This window was cancelled.'} Every hold is
        released; the numbers below are read-only.
      </Note>,
    );
  }
  if (live.changedWhileAway) {
    items.push(
      <Note key="changed" tone="held" onDismiss={live.dismissChanged}>
        The book changed while live updates were paused. These numbers are current.
      </Note>,
    );
  }
  if (live.stream === 'reconnecting') {
    items.push(
      <Note key="reconnecting" tone="neutral">
        Live updates paused. Reconnecting…
      </Note>,
    );
  }
  if (live.stale) {
    items.push(
      <ErrorBanner
        key="stale"
        message="We could not refresh the book. The numbers may be out of date."
        onRetry={live.refresh}
      />,
    );
  }
  return items.length ? <div className="flex flex-col gap-2">{items}</div> : null;
}

function Note({
  tone,
  children,
  onDismiss,
}: {
  tone: 'neutral' | 'held';
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-[14px]',
        tone === 'held'
          ? 'border-orange/30 bg-orange-tint text-ink'
          : 'border-line bg-surface text-body',
      )}
    >
      <p>{children}</p>
      {onDismiss && (
        <Button variant="ghost" onClick={onDismiss} aria-label="Dismiss">
          OK
        </Button>
      )}
    </div>
  );
}

/** Same tiles, plain grid: while the AG bundle loads. */
function KpiRowFallback({ kpis }: { kpis: ReturnType<typeof consoleKpis> | null }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line md:grid-cols-5">
      {KPI_KINDS.map((k) => (
        <KpiTile key={k} kind={k} kpis={kpis} />
      ))}
    </div>
  );
}

/** Listings nav (left on desktop, a scrolling strip on small screens) + the console column. */
function ConsoleFrame({
  listings,
  current,
  currentPhase,
  children,
}: {
  listings: BrandListingView[];
  current: string;
  /** The open listing's live phase (the list is fetched once). */
  currentPhase?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col lg:flex-row lg:gap-8">
      <nav
        aria-label="Listings"
        className="-mx-4 overflow-x-auto border-b border-line px-4 pt-4 sm:-mx-8 sm:px-8 lg:mx-0 lg:w-56 lg:shrink-0 lg:overflow-visible lg:border-r lg:border-b-0 lg:px-0 lg:pt-8 lg:pr-4"
      >
        <p className="label mb-2 hidden text-[11px] text-muted lg:block">Listings</p>
        <ul className="flex gap-1 pb-3 lg:flex-col lg:pb-0">
          {listings.map((l) => (
            <li key={l.listingId} className="shrink-0">
              <NavLink
                to={paths.listingConsole(l.listingId)}
                aria-current={l.listingId === current ? 'page' : undefined}
                className={cn(
                  'flex max-w-60 flex-col gap-1 rounded-sm px-3 py-2 hover:bg-surface',
                  l.listingId === current && 'bg-surface',
                )}
              >
                <span className="truncate text-[14px] text-ink">
                  {l.product.title ?? 'Untitled'}
                </span>
                <Badge tone="neutral" className="self-start text-[10px]">
                  {((l.listingId === current && currentPhase) || navPhaseLabel(l)).replaceAll(
                    '_',
                    ' ',
                  )}
                </Badge>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
