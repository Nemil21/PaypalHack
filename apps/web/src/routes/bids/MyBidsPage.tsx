import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatUsd } from '@holdfast/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  MoneySkeleton,
  Skeleton,
  useToast,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import {
  belowHint,
  bidsInTab,
  cancelQuestion,
  canCancel,
  moneyCopy,
  releaseReason,
  ROUNDS_POLL_MS,
  shouldPoll,
  sourceChip,
  statusPill,
  TABS,
  timeLeftText,
  type BidTab,
  type MyBid,
} from '../../lib/bids';
import { cn } from '../../lib/cn';
import { useApiAction } from '../../lib/use-api-action';
import { ErrorState } from './ErrorState';
import { SWIPE_OPEN_PX, useNow, usePolling, usePullToRefresh, useSwipeLeft } from './hooks';

type Load =
  | { state: 'loading' }
  | { state: 'signed_out' }
  | { state: 'error'; message: string }
  | { state: 'ready'; bids: MyBid[] };

/**
 * W14 / M03 my bids (HF-020). Tabs Live / Won / Released (lib/bids.ts `TAB_FOR`: every status in
 * exactly one tab), bid cards (product, your bid, status pill, time left, "below likely clearing"
 * in ROUNDS only, reserve list, source chip), Cancel with confirm. Polls `GET /api/bids/mine`
 * every 5 s while a live bid's listing is in ROUNDS (D18). Phones: swipe a card left to cancel
 * (with confirm) and pull down to refresh. `?error=CODE` (PayPal return) shows the W21 variant.
 */
export function MyBidsPage() {
  const [params, setParams] = useSearchParams();
  const errorParam = params.get('error');
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'live') as BidTab;
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const fetchBids = useCallback(async () => {
    try {
      const res = await api.request<{ bids: MyBid[] }>({ method: 'GET', path: '/api/bids/mine' });
      setLoad({ state: 'ready', bids: res.bids });
    } catch (err) {
      const e =
        err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
      setLoad((prev) =>
        e.status === 401
          ? { state: 'signed_out' }
          : prev.state === 'ready' && e.retryable
            ? prev // keep the last good list through a failed background poll
            : { state: 'error', message: e.message },
      );
    }
  }, []);

  useEffect(() => {
    void fetchBids();
  }, [fetchBids]);

  const bids = load.state === 'ready' ? load.bids : [];
  usePolling(shouldPoll(bids), ROUNDS_POLL_MS, () => void fetchBids());
  const pull = usePullToRefresh(fetchBids);

  const setTab = (id: BidTab) => {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    setParams(next, { replace: true });
  };

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 pt-6" {...pull.handlers}>
      <div
        aria-hidden={!pull.pull && !pull.refreshing}
        className="flex justify-center overflow-hidden transition-[height] lg:hidden"
        style={{ height: pull.refreshing ? 32 : pull.pull }}
      >
        <span className="label self-end text-[11px] text-muted">
          {pull.refreshing ? 'Refreshing…' : 'Release to refresh'}
        </span>
      </div>

      <h1 className="text-[28px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[40px]">
        My bids
      </h1>

      {errorParam && <ErrorState code={errorParam} />}

      <div
        role="tablist"
        aria-label="Bid status"
        className="grid grid-cols-3 rounded-sm bg-surface p-1"
      >
        {TABS.map((t) => {
          const count = load.state === 'ready' ? bidsInTab(bids, t.id).length : null;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="bids-panel"
              onClick={() => setTab(t.id)}
              className={cn(
                'label h-10 rounded-sm text-[13px]',
                tab === t.id ? 'bg-white text-ink shadow-card' : 'text-muted',
              )}
            >
              {t.label}
              {count ? ` · ${count}` : ''}
            </button>
          );
        })}
      </div>

      <div
        id="bids-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="flex flex-col gap-3"
      >
        {load.state === 'loading' && <ListSkeleton />}
        {load.state === 'error' && (
          <ErrorBanner message={load.message} onRetry={() => void fetchBids()} />
        )}
        {load.state === 'signed_out' && (
          <EmptyState message="No bids yet. Bids you place on this device show up here." />
        )}
        {load.state === 'ready' && (
          <TabList bids={bids} tab={tab} onChanged={() => void fetchBids()} />
        )}
      </div>
    </div>
  );
}

function TabList({ bids, tab, onChanged }: { bids: MyBid[]; tab: BidTab; onChanged(): void }) {
  const now = useNow();
  const list = bidsInTab(bids, tab);
  if (bids.length === 0) return <EmptyState message="No bids yet." />;
  if (list.length === 0) {
    const empty: Record<BidTab, string> = {
      live: 'No live bids right now.',
      won: 'Nothing won yet.',
      released: 'No released bids.',
    };
    return <EmptyState message={empty[tab]} />;
  }
  return (
    <ul className="flex flex-col gap-3">
      {list.map((b) => (
        <li key={b.bidId}>
          <BidCard bid={b} now={now} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}

function BidCard({ bid, now, onChanged }: { bid: MyBid; now: number; onChanged(): void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const cancel = useApiAction<{ status: string; message: string }>();
  const cancellable = canCancel(bid.status);
  const swipe = useSwipeLeft(cancellable && !confirming, () => setConfirming(true));
  const pill = statusPill(bid.status);
  const left = timeLeftText(bid, now);
  const hint = belowHint(bid);
  const chip = sourceChip(bid.source);
  const reason = releaseReason(bid);

  const doCancel = async () => {
    const res = await cancel.run({ method: 'POST', path: `/api/bids/${bid.bidId}/cancel` });
    if (!res) return;
    cancel.reset();
    setConfirming(false);
    toast.show({ tone: 'info', title: 'Bid cancelled', body: res.message });
    onChanged();
  };

  return (
    <article className="relative overflow-hidden rounded-md border border-line bg-danger-tint">
      {/* Revealed behind the card while swiping left (M03). */}
      <span
        aria-hidden
        className="label absolute inset-y-0 right-0 flex w-[120px] items-center justify-center text-[12px] text-danger"
      >
        {swipe.dx <= -SWIPE_OPEN_PX ? 'Release to cancel' : 'Cancel'}
      </span>
      <div
        {...swipe.handlers}
        style={{ transform: swipe.dx ? `translateX(${swipe.dx}px)` : undefined }}
        className={cn(
          'relative flex flex-col gap-3 bg-white p-4 sm:p-5',
          !swipe.dx && 'transition-transform',
        )}
      >
        <Link to={`/bids/${bid.bidId}`} className="flex items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface">
            {bid.listing.imageUrl ? (
              <img src={bid.listing.imageUrl} alt="" className="h-full w-full object-contain" />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-start justify-between gap-3">
              <h2 className="truncate text-[15px] font-medium text-ink">
                {bid.listing.title ?? 'Your bid'}
              </h2>
              <span className="text-[20px] leading-none font-medium text-ink tabular-nums">
                {formatUsd(bid.amountCents)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={pill.tone}>{pill.label}</Badge>
              {chip && <Badge tone="neutral">{chip}</Badge>}
            </div>
          </div>
        </Link>
        <p className="text-[14px] text-body">
          {bid.status === 'VOIDED' || bid.status === 'VOIDING' || !reason
            ? moneyCopy(bid.status, bid.amountCents)
            : reason}
        </p>
        {(bid.status === 'VOIDED' || bid.status === 'VOIDING') && reason && (
          <p className="text-[13px] text-muted">{reason}</p>
        )}
        {(left || hint) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {left && <span className="font-mono text-[13px] text-ink tabular-nums">{left}</span>}
            {hint && <span className="text-[13px] text-orange">{hint}</span>}
          </div>
        )}
        {cancellable &&
          (confirming ? (
            <div
              role="alertdialog"
              aria-labelledby={`cq-${bid.bidId}`}
              className="flex flex-col gap-2 border-t border-line pt-3"
            >
              <p id={`cq-${bid.bidId}`} className="text-[14px] text-ink">
                {cancelQuestion(bid)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void doCancel()}
                  disabled={cancel.status === 'pending'}
                >
                  {cancel.status === 'pending' ? '…' : 'Yes, cancel it'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  Keep my bid
                </Button>
              </div>
              {cancel.status === 'error' && (
                <p role="alert" className="text-[13px] text-danger">
                  {cancel.error.message}
                </p>
              )}
            </div>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setConfirming(true)}>
                Cancel bid
              </Button>
            </div>
          ))}
      </div>
    </article>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-3 rounded-md border border-line p-4">
          <Skeleton className="h-12 w-12" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
          <MoneySkeleton size="sm" />
        </div>
      ))}
    </div>
  );
}
