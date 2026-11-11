import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import type { BookListing, BrandListingView, ListingPhaseName } from '@holdfast/shared';
import {
  createKpiStore,
  KpiTile,
  type KpiKind,
  type KpiStore,
} from '../../components/console/KpiTiles';
import { CLEARABLE, ClearAction } from '../../components/console/ClearModal';
import { QuantitySlider } from '../../components/console/QuantitySlider';
import { RecommendationCard } from '../../components/console/RecommendationCard';
import { RoundsPanel } from '../../components/console/RoundsPanel';
import { Badge, Button, EmptyState, ErrorBanner, Skeleton, useToast } from '../../components/ui';
import { cn } from '../../lib/cn';
import { createBidRowTracker, type BidRowTracker } from '../../lib/console/bids-grid';
import { buildCurveModel } from '../../lib/console/curve';
import { consoleKpisAt, type ConsoleKpis } from '../../lib/console/kpis';
import { navPhaseLabel, phaseView } from '../../lib/console/phase';
import {
  applyRoundEvent,
  overlayFromState,
  roundsEndedCopy,
  withRoundsOverlay,
  type RoundsOverlay,
} from '../../lib/console/rounds';
import { createSliderStore, SliderContext, type SliderStore } from '../../lib/console/slider-store';
import { useConsoleBook } from '../../lib/console/use-console-book';
import { useRecommendationProse } from '../../lib/console/use-recommendation-prose';
import { useRoundsActivity } from '../../lib/console/use-rounds-activity';
import { paths } from '../../lib/routes';
import { useBrand } from './BrandGate';
import { ConsoleHeader, ShareButton } from './ConsoleHeader';

const ConsoleKpiStudio = lazy(() => import('../../components/ag/ConsoleKpiStudio'));
const DemandCurveChart = lazy(() => import('../../components/ag/DemandCurveChart'));
const BidsGrid = lazy(() => import('../../components/ag/BidsGrid'));
const BrandAgentStudio = lazy(() => import('../../components/ag/BrandAgentStudio'));

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
 * notices → one debounced book refetch; reconnect → refetch now. Every `round.*` and `bid.raised`
 * notice re-reads the book, so the KPI row's expected gross follows the rounds (HF-037a).
 */
export function ListingConsole() {
  const { listingId = '' } = useParams();
  const { me, listings, reloadListings } = useBrand();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow();

  // The bids grid's row model (HF-025), per listing. `bid.raised` notices tell it which new bid
  // replaces which, so a raise updates its row in place when the refetched book lands.
  const tracker = useMemo(() => createBidRowTracker(), [listingId]);
  // Rounds state newer than the last book (HF-037a): a rounds call's response, or a replayed
  // `round.*` event. Merged forward-only on top of the book; see lib/console/rounds.ts.
  const [rounds, setRounds] = useState<{ listingId: string; overlay: RoundsOverlay | null }>({
    listingId,
    overlay: null,
  });
  const overlay = rounds.listingId === listingId ? rounds.overlay : null;
  // Raises feed (HF-037b): re-read on every bid.raised / round.* notice, once rounds started.
  const [roundsSeen, setRoundsSeen] = useState<string | null>(null);
  const activity = useRoundsActivity(listingId, roundsSeen === listingId);
  const live = useConsoleBook(listingId, {
    onPriceDrop: (t) => toast.show({ ...t, duration: 8000 }),
    onNotice: (n, event) => {
      if (n.type === 'bid.raised' && n.ids.bidId && n.ids.replacesBidId) {
        tracker.noteRaise(n.ids.bidId, n.ids.replacesBidId);
      }
      activity.onNotice(n, event);
      if (event?.type.startsWith('round.')) {
        setRounds((r) => ({
          listingId,
          overlay: applyRoundEvent(r.listingId === listingId ? r.overlay : null, event),
        }));
      }
    },
  });
  const { book } = live;
  const listing: BookListing | null = useMemo(
    () => (book ? withRoundsOverlay(book.listing, overlay) : null),
    [book, overlay],
  );

  const phase = useMemo(() => (listing ? phaseView(listing, now) : null), [listing, now]);
  const roundsStarted = !!listing?.roundsStartedAt || listing?.status === 'ROUNDS';
  useEffect(() => {
    if (roundsStarted) setRoundsSeen(listingId);
  }, [roundsStarted, listingId]);
  // Notices may have been missed while the stream was down: re-read the feed with the book.
  const { refresh: refreshActivity } = activity;
  useEffect(() => {
    if (live.stream === 'open') refreshActivity();
  }, [live.stream, refreshActivity]);
  const store = useMemo(createKpiStore, []);
  // One slider store per listing (HF-024). A new book re-ranks it once; the KPI row follows its
  // numbers through the store (no console re-render per drag step).
  const slider = useMemo(() => createSliderStore(), [listingId]);
  useEffect(() => slider.setBook(book), [slider, book]);
  useEffect(() => {
    const sync = () => store.set(book ? consoleKpisAt(book, slider.get().numbers) : null);
    sync();
    return slider.subscribe(sync);
  }, [store, slider, book]);
  // During rounds the slider (and the KPI row's expected gross) sits at the rounds' target.
  const roundsTarget = listing?.status === 'ROUNDS' ? listing.targetQuantity : null;
  useEffect(() => {
    if (roundsTarget !== null) slider.setSliderQuantity(roundsTarget);
  }, [slider, roundsTarget]);

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
          roundsEnded={phase?.phase === 'ROUNDS_ENDED' && listing ? roundsEndedCopy(listing) : null}
        />

        <section aria-label="Key numbers">
          <Suspense fallback={<KpiRowFallback store={store} />}>
            <ConsoleKpiStudio store={store} />
          </Suspense>
        </section>

        {listing && phase && (
          <SliderContext.Provider value={slider}>
            <RoundsPanel
              listingId={listingId}
              listing={listing}
              phase={phase.phase}
              viewer={viewer}
              now={now}
              feed={activity.feed}
              onChanged={(state) => {
                if (state) setRounds({ listingId, overlay: overlayFromState(state) });
                live.refresh();
                activity.refresh();
              }}
            />
          </SliderContext.Provider>
        )}

        {empty && !locked && (
          <EmptyState
            message="No bids yet. Share your offer link."
            action={<ShareButton slug={book.listing.slug} variant="primary" />}
          />
        )}

        {/* Panels that plug into this shell: curve + slider (HF-024), brand agent card (HF-051a),
            bids grid (HF-025). */}
        <SliderContext.Provider value={slider}>
          <div
            className={cn('grid gap-4', locked && 'pointer-events-none opacity-60')}
            aria-disabled={locked || undefined}
            data-testid="console-panels"
          >
            {book && !empty && phase && (
              <DemandPanel
                book={book}
                slider={slider}
                locked={locked}
                phase={phase.phase}
                viewer={viewer}
              />
            )}
            {book?.recommendation && phase && CLEARABLE.has(phase.phase) && (
              <AgentPanel book={book} locked={locked} />
            )}
            {book && !empty && <BidsPanel book={book} slider={slider} tracker={tracker} />}
          </div>
        </SliderContext.Provider>
      </div>
    </ConsoleFrame>
  );
}

function StatusBanners({
  live,
  phase,
  viewer,
  listingId,
  roundsEnded,
}: {
  live: ReturnType<typeof useConsoleBook>;
  phase: string | null;
  viewer: boolean;
  listingId: string;
  /** "Rounds ended. Press Clear by …" while ROUNDS_ENDED. */
  roundsEnded: string | null;
}) {
  const items: React.ReactNode[] = [];
  if (viewer) {
    items.push(
      <Note key="viewer" tone="neutral">
        View only. Your role can watch this window but not clear or cancel it.
      </Note>,
    );
  }
  if (roundsEnded) {
    items.push(
      <Note key="rounds-ended" tone="held">
        <span data-testid="rounds-ended-banner">{roundsEnded}</span>
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

/**
 * Demand curve and quantity slider (HF-024, features/08 §Layout 3–4). The curve model changes
 * with the book only; the slider and the curve's cutoff marker read the slider store. The Clear
 * button (HF-028) sits under the slider and clears at its committed quantity.
 */
function DemandPanel({
  book,
  slider,
  locked,
  phase,
  viewer,
}: {
  book: NonNullable<ReturnType<typeof useConsoleBook>['book']>;
  slider: SliderStore;
  locked: boolean;
  phase: ListingPhaseName;
  viewer: boolean;
}) {
  const model = useMemo(() => buildCurveModel(book), [book]);
  return (
    <section
      aria-label="Demand curve"
      className="flex flex-col gap-4 rounded-md border border-line bg-white p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="label text-[11px] text-muted">Committed demand</h2>
        <span className="text-[12px] text-muted">Every point is money already held</span>
      </div>
      {model.data.length ? (
        <Suspense fallback={<Skeleton className="h-[320px] w-full" />}>
          <DemandCurveChart model={model} slider={slider} />
        </Suspense>
      ) : (
        <p className="py-8 text-center text-[14px] text-body">
          The curve appears with the first held bid.
        </p>
      )}
      <QuantitySlider disabled={locked} />
      <ClearAction
        listingId={book.listing.id}
        phase={phase}
        viewer={viewer}
        recommendation={book.recommendation}
      />
    </section>
  );
}

/**
 * Brand agent (HF-051a card + HF-051b): the code recommendation with Claude's prose under it,
 * then "Ask about this book" on AG Studio. Claude down → the card alone, without prose.
 */
function AgentPanel({
  book,
  locked,
}: {
  book: NonNullable<ReturnType<typeof useConsoleBook>['book']>;
  locked: boolean;
}) {
  const prose = useRecommendationProse(book.listing.id, book.recommendation);
  return (
    <>
      <RecommendationCard recommendation={book.recommendation!} disabled={locked} prose={prose} />
      <Suspense fallback={<Skeleton className="h-[120px] w-full" />}>
        <BrandAgentStudio key={book.listing.id} book={book} />
      </Suspense>
    </>
  );
}

/** Bids grid (HF-025, features/08 §Layout 5): every live bid, anonymized, with SIM chips. */
function BidsPanel({
  book,
  slider,
  tracker,
}: {
  book: NonNullable<ReturnType<typeof useConsoleBook>['book']>;
  slider: SliderStore;
  tracker: BidRowTracker;
}) {
  return (
    <section
      aria-label="Bids"
      className="flex flex-col gap-4 rounded-md border border-line bg-white p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="label text-[11px] text-muted">Bids</h2>
        <span className="text-[12px] text-muted">
          Shopper labels only · SIM marks simulated bidders
        </span>
      </div>
      <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
        <BidsGrid book={book} slider={slider} tracker={tracker} />
      </Suspense>
    </section>
  );
}

/** Same tiles, plain grid: while the AG bundle loads. */
function KpiRowFallback({ store }: { store: KpiStore }) {
  const kpis: ConsoleKpis | null = useSyncExternalStore(store.subscribe, store.get, store.get);
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
