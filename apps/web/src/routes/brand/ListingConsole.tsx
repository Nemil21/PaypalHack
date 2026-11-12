import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import {
  feeCents,
  formatUsd,
  netCents,
  type BookListing,
  type BrandListingView,
  type ListingPhaseName,
  type RoundsState,
} from '@holdfast/shared';
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
import { OrderTimeline } from '../../components/bryntum/OrderTimeline';
import { cn } from '../../lib/cn';
import { createBidRowTracker, type BidRowTracker } from '../../lib/console/bids-grid';
import { buildCurveModel } from '../../lib/console/curve';
import { m10State } from '../../lib/console/m10';
import { consoleKpisAt, type ConsoleKpis } from '../../lib/console/kpis';
import { navPhaseLabel, phaseView } from '../../lib/console/phase';
import {
  applyRoundEvent,
  overlayFromState,
  roundsEndedCopy,
  withRoundsOverlay,
  type RoundsOverlay,
} from '../../lib/console/rounds';
import {
  createSliderStore,
  SliderContext,
  useSlider,
  type SliderStore,
} from '../../lib/console/slider-store';
import { useConsoleBook } from '../../lib/console/use-console-book';
import { useRecommendationProse } from '../../lib/console/use-recommendation-prose';
import { useRoundsActivity } from '../../lib/console/use-rounds-activity';
import { paths } from '../../lib/routes';
import { useBrand } from './BrandGate';
import { ConsoleHeader, ShareButton } from './ConsoleHeader';
import { DraftActions } from './DraftActions';
import { MobileListing, useConsoleLayout } from './MobileListing';

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
  // M10 on a phone (HF-061): the same live book, stores and Clear flow, laid out for 375 px.
  const mobile = useConsoleLayout() === 'mobile';
  const [clearedHere, setClearedHere] = useState<string | null>(null);

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
  // M10 stays put and shows progress in place.
  const lastPhase = useRef<string | null>(null);
  useEffect(() => {
    if (!phase) return;
    if (
      !mobile &&
      lastPhase.current &&
      lastPhase.current !== 'CLEARING' &&
      phase.phase === 'CLEARING'
    ) {
      navigate(paths.listingSettlement(listingId));
    }
    lastPhase.current = phase.phase;
  }, [phase, listingId, navigate, mobile]);

  const { refresh: refreshBook } = live;
  // A saved draft is not a dead end (UI-GAPS #7): Publish · Edit units, for OWNER / MANAGER.
  const draftPanel =
    listing?.status === 'DRAFT' && !viewer ? (
      <section
        aria-label="Draft"
        className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-medium text-ink">
            This listing is a draft · {listing.quantity} units
          </p>
          <p className="text-[14px] text-body">
            Publish to open the window and get your offer link.
          </p>
        </div>
        <DraftActions
          listingId={listingId}
          quantity={listing.quantity}
          verified={me.brand.verificationStatus === 'VERIFIED'}
          onChanged={() => {
            refreshBook();
            reloadListings();
          }}
        />
      </section>
    ) : null;
  const onMobileCleared = useCallback(() => {
    setClearedHere(listingId);
    refreshBook();
    reloadListings();
  }, [listingId, refreshBook, reloadListings]);

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

  if (mobile) {
    const settling = phase && ['clearing', 'done'].includes(m10State(phase.phase));
    return (
      <SliderContext.Provider value={slider}>
        <MobileListing
          book={book}
          phase={phase}
          now={now}
          viewer={viewer}
          store={store}
          slider={slider}
          clearedHere={clearedHere === listingId}
          onCleared={onMobileCleared}
          banners={
            <>
              {draftPanel}
              <StatusBanners
                live={live}
                // M10 shows clearing progress and the cleared state itself.
                phase={settling ? null : (phase?.phase ?? null)}
                viewer={false}
                listingId={listingId}
                roundsEnded={
                  phase?.phase === 'ROUNDS_ENDED' && listing ? roundsEndedCopy(listing) : null
                }
              />
            </>
          }
        />
      </SliderContext.Provider>
    );
  }

  const empty = book !== null && book.stats.liveBids === 0 && book.pending.length === 0;
  const onRoundsChanged = (state?: RoundsState) => {
    if (state) setRounds({ listingId, overlay: overlayFromState(state) });
    live.refresh();
    activity.refresh();
  };

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
        {draftPanel}
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
              placement="card"
              onChanged={onRoundsChanged}
            />
          </SliderContext.Provider>
        )}

        {empty && !locked && (
          <EmptyState
            message="No bids yet. Share your offer link."
            action={
              <ShareButton listingId={book.listing.id} slug={book.listing.slug} variant="primary" />
            }
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
            {book && !empty && phase && listing && (
              <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <DemandPanel book={book} slider={slider} />
                <ClearPanel
                  book={book}
                  listing={listing}
                  locked={locked}
                  phase={phase.phase}
                  viewer={viewer}
                  now={now}
                  onRoundsChanged={onRoundsChanged}
                />
              </div>
            )}
            {book && phase && phase.phase !== 'DRAFT' && (
              <AgentPanel book={book} locked={locked} clearable={CLEARABLE.has(phase.phase)} />
            )}
            {book && !empty && <BidsPanel book={book} slider={slider} tracker={tracker} />}
          </div>
        </SliderContext.Provider>

        {/* HF-060: the order-status timeline, re-read whenever the listing changes state. */}
        {book && (
          <OrderTimeline
            path={`/api/listings/${encodeURIComponent(listingId)}/timeline`}
            refreshKey={book.listing.status}
            className="pb-12"
          />
        )}
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

/** Demand curve (HF-024, features/08 §Layout 3). The cutoff marker reads the slider store. */
function DemandPanel({
  book,
  slider,
}: {
  book: NonNullable<ReturnType<typeof useConsoleBook>['book']>;
  slider: SliderStore;
}) {
  const model = useMemo(() => buildCurveModel(book), [book]);
  return (
    <section
      aria-label="Demand curve"
      className="flex min-w-0 flex-col gap-4 rounded-md border border-line bg-white p-4"
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
    </section>
  );
}

/**
 * v4 Clear panel (frame 112:64): units slider (HF-024), gross · fee · net at the slider, Clear
 * (HF-028, W07 modal) and "Start live rounds" (HF-037a). Cancel window stays in the header.
 */
function ClearPanel({
  book,
  listing,
  locked,
  phase,
  viewer,
  now,
  onRoundsChanged,
}: {
  book: NonNullable<ReturnType<typeof useConsoleBook>['book']>;
  listing: BookListing;
  locked: boolean;
  phase: ListingPhaseName;
  viewer: boolean;
  now: number;
  onRoundsChanged(state?: RoundsState): void;
}) {
  const s = useSlider();
  const gross = s.numbers?.grossCents ?? 0;
  const pct = (book.listing.feeBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return (
    <section
      aria-label="Clear this window"
      className="flex flex-col gap-4 rounded-md border border-line bg-white p-4"
    >
      <h2 className="label text-[11px] text-muted">Clear this window</h2>
      <QuantitySlider disabled={locked} />
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[14px] tabular-nums">
        <dt className="text-body">Gross</dt>
        <dd className="text-right text-ink">{formatUsd(gross)}</dd>
        <dt className="text-body">Holdfast fee ({pct}%)</dt>
        <dd className="text-right text-ink">−{formatUsd(feeCents(gross, book.listing.feeBps))}</dd>
        <dt className="font-medium text-ink">Net to you</dt>
        <dd className="text-right text-[18px] font-medium text-ink">
          {formatUsd(netCents(gross, book.listing.feeBps))}
        </dd>
      </dl>
      <div className="flex flex-col gap-2">
        <ClearAction
          listingId={book.listing.id}
          phase={phase}
          viewer={viewer}
          recommendation={book.recommendation}
          layout="panel"
        />
        <RoundsPanel
          listingId={book.listing.id}
          listing={listing}
          phase={phase}
          viewer={viewer}
          now={now}
          placement="clear-panel"
          onChanged={onRoundsChanged}
        />
      </div>
      <p className="text-[13px] text-body">
        Each winner pays their own bid. Everyone below the cutoff is released.
      </p>
    </section>
  );
}

/**
 * Brand agent (HF-051a card + HF-051b), always shown once the window is published (v4 §2.2): the
 * code recommendation with Claude's prose, then "Ask about this book" on AG Studio. No
 * recommendation yet, or AG Studio failed → a paused note; Clear never depends on it.
 */
function AgentPanel({
  book,
  locked,
  clearable,
}: {
  book: NonNullable<ReturnType<typeof useConsoleBook>['book']>;
  locked: boolean;
  clearable: boolean;
}) {
  const prose = useRecommendationProse(book.listing.id, book.recommendation);
  const paused = (
    <section
      aria-label="Brand agent"
      className="flex flex-col gap-1 rounded-md border border-line bg-white p-4"
      data-testid="brand-agent-paused"
    >
      <h2 className="label text-[11px] text-muted">Brand agent</h2>
      <p className="text-[14px] text-body">
        {clearable
          ? 'Recommendations paused. You can still clear.'
          : 'Recommendations stop once the window closes.'}
      </p>
    </section>
  );
  return (
    <>
      {book.recommendation && clearable ? (
        <RecommendationCard recommendation={book.recommendation} disabled={locked} prose={prose} />
      ) : (
        paused
      )}
      {clearable && (
        <StudioBoundary fallback={book.recommendation ? paused : null}>
          <Suspense fallback={<Skeleton className="h-[120px] w-full" />}>
            <BrandAgentStudio key={book.listing.id} book={book} />
          </Suspense>
        </StudioBoundary>
      )}
    </>
  );
}

/** AG Studio failing to load or render must never take the console (and Clear) down with it. */
class StudioBoundary extends Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(err: unknown) {
    console.error('brand agent: AG Studio failed', err);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
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
