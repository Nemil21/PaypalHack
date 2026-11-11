import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { BANK_PENDING_NOTE, formatUsd } from '@holdfast/shared';
import {
  Badge,
  Button,
  ButtonLink,
  ErrorBanner,
  MoneySkeleton,
  Skeleton,
  useToast,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import {
  belowHint,
  cancelQuestion,
  canCancel,
  canRaise,
  detailErrorCode,
  moneyBox,
  moneyCopy,
  offerHref,
  releaseReason,
  ROUNDS_POLL_MS,
  roundsAction,
  shouldPoll,
  shouldWatchRounds,
  sourceChip,
  statusPill,
  timeLeftText,
  timelineRows,
  type BidDetail,
  type RowTone,
} from '../../lib/bids';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';
import { useApiAction } from '../../lib/use-api-action';
import { hasWonPage } from '../../lib/won';
import { ErrorState } from './ErrorState';
import { formatWhen } from './format';
import { HoldConfirmation } from './HoldConfirmation';
import { useNow, usePolling } from './hooks';
import { PriceDropSheet } from './PriceDropSheet';
import { ReleaseToggle } from './ReleaseToggle';
import { RoundsRaise } from './RoundsRaise';

type Load =
  | { state: 'loading' }
  | { state: 'failed'; code: string; message: string }
  | { state: 'ready'; detail: BidDetail };

/**
 * W15 / M04 bid detail timeline (HF-020; features/15 §Logic 3). Also the landing page after a hold
 * or a PayPal return (api.md §`GET /bids/return`):
 *   `?held=1`      → W13 / M02 confirmation on top;
 *   `?error=CODE`  → the W21 variant for that code;
 *   `?cancelled=1` → "You cancelled the PayPal approval".
 * Summary card, vertical timeline over the `replaces_bid_id` chain, money box per chain, sticky
 * Raise / Cancel bar. Polls every 5 s during live rounds (D18) and while a hold is releasing or
 * still waiting for PayPal, so "releasing" turns into "released" on its own.
 */
export function BidDetailPage() {
  const { bidId = '' } = useParams();
  const [params] = useSearchParams();
  const justHeld = params.get('held') === '1';
  const errorParam = params.get('error');
  const cancelledParam = params.get('cancelled') === '1';
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [sheetOpen, setSheetOpen] = useState(false);

  const fetchDetail = useCallback(async () => {
    try {
      const detail = await api.request<BidDetail>({
        method: 'GET',
        path: `/api/bids/${encodeURIComponent(bidId)}`,
      });
      setLoad({ state: 'ready', detail });
    } catch (err) {
      const e =
        err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
      setLoad((prev) =>
        // A failed background poll keeps the last good view.
        prev.state === 'ready' && e.retryable
          ? prev
          : { state: 'failed', code: e.code, message: e.message },
      );
    }
  }, [bidId]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  const detail = load.state === 'ready' ? load.detail : null;
  const settling =
    !!detail &&
    (detail.chain.some((c) => c.status === 'VOIDING' || c.status === 'WON') ||
      (detail.bid.status === 'PENDING_APPROVAL' && justHeld));
  usePolling(
    !!detail && (shouldPoll([detail.bid]) || shouldWatchRounds([detail.bid]) || settling),
    ROUNDS_POLL_MS,
    () => {
      void fetchDetail();
    },
  );

  if (load.state === 'loading') return <DetailSkeleton />;
  if (load.state === 'failed') {
    if (load.code === 'NOT_FOUND' || load.code === 'UNAUTHENTICATED') {
      return (
        <div className="mx-auto max-w-[640px] py-8">
          <ErrorState code={load.code} />
        </div>
      );
    }
    return (
      <div className="py-12">
        <ErrorBanner message={load.message} onRetry={() => void fetchDetail()} />
      </div>
    );
  }

  const { bid, priceDrop } = load.detail;
  const stateCode = detailErrorCode(bid);
  const headDropped = priceDrop?.bidId === bid.bidId;
  const w21Code = errorParam ?? stateCode ?? (headDropped ? 'PRICE_DROP' : null);
  const w21Context = {
    amountCents: bid.amountCents,
    offerSlug: bid.listing.slug,
    holdReleased: bid.status === 'VOIDED' ? true : bid.status === 'VOIDING' ? false : null,
    priceDrop: headDropped ? priceDrop : null,
  };
  const showConfirmation =
    justHeld && !errorParam && (bid.status === 'HELD' || bid.status === 'PENDING_APPROVAL');
  const showBar = canRaise(bid) || canCancel(bid.status);

  return (
    <div
      className={cn('mx-auto flex max-w-[760px] flex-col gap-8 pt-6', showBar && 'pb-24 lg:pb-0')}
    >
      {showConfirmation && (
        <HoldConfirmation detail={load.detail} onChanged={() => void fetchDetail()} />
      )}
      {cancelledParam && bid.status === 'PENDING_APPROVAL' && (
        <p role="status" className="rounded-md bg-surface p-4 text-[14px] text-body">
          You cancelled the PayPal approval. Nothing was held.
        </p>
      )}
      {w21Code && <ErrorState code={w21Code} context={w21Context} />}

      <Summary
        detail={load.detail}
        showToggle={!showConfirmation}
        onChanged={() => void fetchDetail()}
      />
      <Timeline detail={load.detail} onOpenDrop={() => setSheetOpen(true)} />
      <MoneyBox detail={load.detail} />
      {showBar && <ActionBar detail={load.detail} onChanged={() => void fetchDetail()} />}

      {sheetOpen && priceDrop && (
        <PriceDropSheet
          drop={priceDrop}
          offerSlug={bid.listing.slug}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}

function Summary({
  detail,
  showToggle,
  onChanged,
}: {
  detail: BidDetail;
  /** The W13 confirmation above carries the toggle while it is shown. */
  showToggle: boolean;
  onChanged(): void;
}) {
  const { bid } = detail;
  const now = useNow();
  const pill = statusPill(bid.status);
  const left = timeLeftText(bid, now);
  const rounds = roundsAction(bid);
  const hint = rounds ? null : belowHint(bid);
  const chip = sourceChip(bid.source);
  const reason = releaseReason(bid);
  const navigate = useNavigate();
  const live = bid.status === 'HELD' || bid.status === 'PENDING_APPROVAL';

  return (
    <section
      aria-labelledby="bid-summary"
      className="flex flex-col gap-5 rounded-md border border-line bg-white p-5 shadow-card sm:p-6"
    >
      <div className="flex items-start gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface">
          {bid.listing.imageUrl ? (
            <img src={bid.listing.imageUrl} alt="" className="h-full w-full object-contain" />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h1 id="bid-summary" className="text-[20px] font-medium tracking-title text-ink">
            {bid.listing.title ?? 'Your bid'}
          </h1>
          {bid.listing.slug && (
            <Link to={offerHref(bid.listing.slug)!} className="text-[13px] text-body underline">
              View offer
            </Link>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[40px] leading-none font-medium tracking-headline text-ink tabular-nums">
          {formatUsd(bid.amountCents)}
        </span>
        <Badge tone={pill.tone}>{pill.label}</Badge>
        {chip && <Badge tone="neutral">{chip}</Badge>}
      </div>
      <p className="text-[15px] text-ink">{moneyCopy(bid.status, bid.amountCents)}</p>
      {hasWonPage(bid.status) && (
        <ButtonLink to={paths.bidWon(bid.bidId)} variant="secondary" className="self-start">
          View receipt &amp; tracking
        </ButtonLink>
      )}
      {reason && bid.status !== 'CAPTURE_FAILED' && (
        <p className="text-[14px] text-body">{reason}</p>
      )}
      {(left || hint) && (
        <div className="flex flex-col gap-1">
          {left && <span className="font-mono text-[14px] text-ink tabular-nums">{left}</span>}
          {hint && <span className="text-[14px] text-orange">{hint}</span>}
        </div>
      )}
      <RoundsRaise
        bid={bid}
        // Follow the chain to the new head bid; the timeline shows the raise row.
        onRaised={(res) =>
          res.bidId === bid.bidId ? onChanged() : navigate(`/bids/${res.bidId}`, { replace: true })
        }
        onRefresh={onChanged}
      />
      {live && showToggle && <ReleaseToggle bid={bid} onChanged={onChanged} />}
    </section>
  );
}

const TONE_DOT: Record<RowTone, string> = {
  held: 'bg-orange',
  success: 'bg-success',
  neutral: 'bg-planned',
  danger: 'bg-danger',
  signal: 'bg-charcoal',
};

function Timeline({ detail, onOpenDrop }: { detail: BidDetail; onOpenDrop(): void }) {
  const rows = timelineRows(detail);
  return (
    <section aria-labelledby="timeline" className="flex flex-col gap-4">
      <h2 id="timeline" className="label text-[12px] text-muted">
        Timeline
      </h2>
      <ol className="flex flex-col">
        {rows.map((r, i) => (
          <li key={r.key} className="relative flex gap-4 pb-6 last:pb-0">
            {i < rows.length - 1 && (
              <span aria-hidden className="absolute top-4 bottom-0 left-[5px] w-px bg-line" />
            )}
            <span
              aria-hidden
              className={cn(
                'relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full',
                TONE_DOT[r.tone],
              )}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-[15px] text-ink">{r.title}</span>
                {r.at && (
                  <time dateTime={r.at} className="font-mono text-[12px] text-muted tabular-nums">
                    {formatWhen(r.at)}
                  </time>
                )}
              </div>
              {r.detail && <p className="text-[13px] text-body">{r.detail}</p>}
              {r.priceDrop && detail.priceDrop && (
                <button
                  type="button"
                  onClick={onOpenDrop}
                  className="label self-start text-[12px] text-orange underline"
                >
                  See the cheaper offer
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MoneyBox({ detail }: { detail: BidDetail }) {
  const box = moneyBox(detail);
  return (
    <section aria-labelledby="money" className="flex flex-col gap-3 rounded-md bg-surface p-5">
      <h2 id="money" className="label text-[12px] text-muted">
        Your money
      </h2>
      <ul className="flex flex-col gap-2">
        {box.lines.map((l) => (
          <li
            key={l.bidId}
            className={cn('font-mono text-[15px] tabular-nums', l.final ? 'text-ink' : 'text-body')}
          >
            {l.text}
          </li>
        ))}
      </ul>
      {box.bankNote && <p className="text-[13px] text-body">{BANK_PENDING_NOTE}</p>}
    </section>
  );
}

/** M04 sticky action bar (Raise / Cancel); inline on desktop. */
function ActionBar({ detail, onChanged }: { detail: BidDetail; onChanged(): void }) {
  const { bid } = detail;
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const cancel = useApiAction<{ status: string; message: string }>();
  const raiseHref = canRaise(bid) ? offerHref(bid.listing.slug) : null;

  const doCancel = async () => {
    const res = await cancel.run({ method: 'POST', path: `/api/bids/${bid.bidId}/cancel` });
    if (!res) return;
    cancel.reset();
    setConfirming(false);
    toast.show({ tone: 'info', title: 'Bid cancelled', body: res.message });
    onChanged();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 px-4 py-3 backdrop-blur lg:static lg:border-0 lg:bg-transparent lg:p-0">
      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby="cancel-q"
          className="mx-auto flex max-w-[760px] flex-col gap-2"
        >
          <p id="cancel-q" className="text-[14px] text-ink">
            {cancelQuestion(bid)}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1 lg:flex-none"
              onClick={() => void doCancel()}
              disabled={cancel.status === 'pending'}
            >
              {cancel.status === 'pending' ? '…' : 'Yes, cancel it'}
            </Button>
            <Button
              variant="ghost"
              className="flex-1 lg:flex-none"
              onClick={() => setConfirming(false)}
            >
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
        <div className="mx-auto flex max-w-[760px] gap-2">
          {raiseHref && (
            <ButtonLink to={raiseHref} size="lg" className="flex-1 lg:flex-none">
              Raise
            </ButtonLink>
          )}
          {canCancel(bid.status) && (
            <Button
              variant="outline"
              size="lg"
              className="flex-1 lg:flex-none"
              onClick={() => setConfirming(true)}
            >
              Cancel bid
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 pt-6">
      <div className="flex flex-col gap-4 rounded-md border border-line p-6">
        <Skeleton className="h-6 w-48" />
        <MoneySkeleton />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
