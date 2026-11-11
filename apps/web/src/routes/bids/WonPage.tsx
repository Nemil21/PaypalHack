import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { formatUsd } from '@holdfast/shared';
import { ButtonLink, ErrorBanner, MoneySkeleton, Skeleton } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { ROUNDS_POLL_MS, offerHref } from '../../lib/bids';
import { cn } from '../../lib/cn';
import {
  CHARGING_COPY,
  receiptLines,
  shippingSummary,
  trackerSteps,
  type WonView,
} from '../../lib/won';
import { ErrorState } from './ErrorState';
import { formatWhen } from './format';
import { usePolling } from './hooks';

type Load =
  | { state: 'loading' }
  | { state: 'failed'; code: string; reason: string | null; message: string }
  | { state: 'ready'; view: WonView };

/**
 * W18 / M08 won page (HF-059a; screens.md §W18, §M08). Success hero with the D14 pay-your-bid
 * headline ("You won at your bid of $229. Charged $229."), "You moved up from the reserve list" for
 * promoted winners, receipt card (charged = the bid, PayPal capture id, date), released holds from
 * the raise chain, and the shipping tracker from HF-059b's `shipments` row. Polls while the capture
 * is still running (WON) or the parcel is not delivered yet, so tracking appears on its own.
 * A bid that has not won goes back to its timeline (W15).
 */
export function WonPage() {
  const { bidId = '' } = useParams();
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const fetchView = useCallback(async () => {
    try {
      const view = await api.request<WonView>({
        method: 'GET',
        path: `/api/bids/${encodeURIComponent(bidId)}/won`,
      });
      setLoad({ state: 'ready', view });
    } catch (err) {
      const e =
        err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
      setLoad((prev) =>
        prev.state === 'ready' && e.retryable
          ? prev
          : {
              state: 'failed',
              code: e.code,
              reason: typeof e.details?.reason === 'string' ? e.details.reason : null,
              message: e.message,
            },
      );
    }
  }, [bidId]);

  useEffect(() => {
    void fetchView();
  }, [fetchView]);

  const view = load.state === 'ready' ? load.view : null;
  usePolling(
    !!view && (view.status === 'WON' || view.shipment?.stage !== 'DELIVERED'),
    view?.status === 'WON' ? ROUNDS_POLL_MS : 30_000,
    () => void fetchView(),
  );

  if (load.state === 'loading') return <WonSkeleton />;
  if (load.state === 'failed') {
    if (load.reason === 'NOT_WON') {
      return <Navigate to={`/bids/${encodeURIComponent(bidId)}`} replace />;
    }
    if (load.code === 'NOT_FOUND' || load.code === 'UNAUTHENTICATED') {
      return (
        <div className="mx-auto max-w-[640px] py-8">
          <ErrorState code={load.code} />
        </div>
      );
    }
    return (
      <div className="py-12">
        <ErrorBanner message={load.message} onRetry={() => void fetchView()} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-8 pt-6 pb-10">
      <Hero view={load.view} />
      {load.view.receipt ? (
        <Receipt view={load.view} />
      ) : (
        <p role="status" className="rounded-md bg-surface p-5 text-[15px] text-body">
          {CHARGING_COPY}
        </p>
      )}
      <Tracker view={load.view} />
      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink to="/" size="lg" className="flex-1 sm:flex-none">
          Bid on something else
        </ButtonLink>
        <ButtonLink
          to={`/bids/${encodeURIComponent(load.view.bidId)}`}
          variant="secondary"
          size="lg"
          className="flex-1 sm:flex-none"
        >
          View bid timeline
        </ButtonLink>
      </div>
    </div>
  );
}

function Hero({ view }: { view: WonView }) {
  const href = offerHref(view.listing.slug);
  return (
    <section
      aria-labelledby="won-title"
      className="flex flex-col items-start gap-4 sm:rounded-md sm:border sm:border-line sm:bg-white sm:p-8 sm:shadow-card"
    >
      <span
        aria-hidden
        className="flex h-14 w-14 animate-pop items-center justify-center rounded-full bg-success text-white"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-7 w-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {view.promotedNote && <p className="label text-[12px] text-orange">{view.promotedNote}</p>}
      <h1
        id="won-title"
        data-testid="won-headline"
        className="text-[32px] leading-[1.05] font-medium tracking-headline text-ink sm:text-[40px]"
      >
        {view.headline}
      </h1>
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface">
          {view.listing.imageUrl ? (
            <img src={view.listing.imageUrl} alt="" className="h-full w-full object-contain" />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[17px] text-ink">{view.listing.title ?? 'Your item'}</span>
          {href && (
            <Link to={href} className="text-[13px] text-body underline">
              View offer
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function Receipt({ view }: { view: WonView }) {
  const lines = receiptLines(view, formatWhen);
  return (
    <section aria-labelledby="receipt" className="flex flex-col gap-3 rounded-md bg-surface p-5">
      <h2 id="receipt" className="label text-[12px] text-muted">
        Receipt
      </h2>
      <dl className="flex flex-col gap-2">
        {lines.map((l) => (
          <div key={l.label} className="flex flex-wrap items-baseline justify-between gap-x-4">
            <dt className="text-[14px] text-body">{l.label}</dt>
            <dd
              className={cn('text-[15px] text-ink', l.mono && 'font-mono tabular-nums break-all')}
            >
              {l.value}
            </dd>
          </div>
        ))}
      </dl>
      {view.released.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line pt-3">
          {view.released.map((r) => (
            <li key={r.bidId} className="font-mono text-[13px] text-body tabular-nums">
              {r.text}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-body">
        Pay-your-bid: you paid your own bid of {formatUsd(view.amountCents)}, nothing more.
      </p>
    </section>
  );
}

function Tracker({ view }: { view: WonView }) {
  const steps = trackerSteps(view.shipment);
  const s = view.shipment;
  return (
    <section aria-labelledby="shipping" className="flex flex-col gap-4">
      <h2 id="shipping" className="label text-[12px] text-muted">
        Shipping
      </h2>
      <ol className="grid grid-cols-4 gap-2" aria-label="Shipping progress">
        {steps.map((step) => (
          <li
            key={step.stage}
            aria-current={step.current ? 'step' : undefined}
            className="flex flex-col gap-2"
          >
            <span
              aria-hidden
              className={cn('h-1.5 rounded-full', step.done ? 'bg-success' : 'bg-line')}
            />
            <span
              className={cn('text-[12px] sm:text-[13px]', step.done ? 'text-ink' : 'text-muted')}
            >
              {step.label}
              <span className="sr-only">{step.done ? ' (done)' : ''}</span>
            </span>
          </li>
        ))}
      </ol>
      <p data-testid="shipping-summary" className="text-[15px] text-ink">
        {shippingSummary(s)}
      </p>
      {s?.trackingNumber && (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-white p-4">
          <span className="text-[14px] text-body">
            {s.carrier ?? 'Carrier'}
            {s.shippedAt ? ` · shipped ${formatWhen(s.shippedAt)}` : ''}
          </span>
          {s.trackingUrl ? (
            <a
              href={s.trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[15px] break-all text-ink underline"
            >
              {s.trackingNumber}
            </a>
          ) : (
            <span className="font-mono text-[15px] break-all text-ink">{s.trackingNumber}</span>
          )}
        </div>
      )}
    </section>
  );
}

function WonSkeleton() {
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 pt-6">
      <div className="flex flex-col gap-4 rounded-md border border-line p-6">
        <Skeleton className="h-14 w-14 rounded-full" />
        <MoneySkeleton />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
