import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { formatUsd } from '@holdfast/shared';
import { Badge, ButtonLink, ErrorBanner, MoneySkeleton, Skeleton } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { ROUNDS_POLL_MS, offerHref } from '../../lib/bids';
import { clientConfig } from '../../lib/client-config';
import { cn } from '../../lib/cn';
import {
  CHARGING_COPY,
  receiptLines,
  shippingSummary,
  trackerDetail,
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
    <div className="mx-auto flex max-w-[600px] flex-col gap-5 pt-6 pb-10 lg:pt-10">
      <Hero view={load.view} />
      {load.view.receipt ? (
        <Receipt view={load.view} />
      ) : (
        <p role="status" className="rounded-sm bg-surface p-5 text-[15px] text-body">
          {CHARGING_COPY}
        </p>
      )}
      <Tracker view={load.view} />
      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink to="/" variant="outline" size="lg" className="flex-1 sm:flex-none">
          Bid on something else
        </ButtonLink>
        <ButtonLink
          to={`/bids/${encodeURIComponent(load.view.bidId)}`}
          variant="ghost"
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
    <section aria-labelledby="won-title" className="flex items-center gap-4">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface sm:h-[60px] sm:w-[60px]">
        {view.listing.imageUrl ? (
          <img src={view.listing.imageUrl} alt="" className="h-full w-full object-contain" />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">Won</Badge>
          {view.promotedNote && (
            <span className="label text-[11px] text-orange">{view.promotedNote}</span>
          )}
        </div>
        <h1
          id="won-title"
          data-testid="won-headline"
          className="text-[24px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[30px]"
        >
          {view.headline}
        </h1>
        {href && (
          <Link to={href} className="text-[13px] text-body underline hover:text-ink">
            {view.listing.title ?? 'View offer'}
          </Link>
        )}
      </div>
    </section>
  );
}

function Receipt({ view }: { view: WonView }) {
  const lines = receiptLines(view, formatWhen);
  const brand = view.listing.brandName;
  return (
    <section
      aria-labelledby="receipt"
      className="flex flex-col rounded-sm border border-line bg-white px-5 pt-5 pb-3"
    >
      <h2 id="receipt" className="label border-b border-line pb-2 text-[11px] text-muted">
        Receipt
      </h2>
      <dl className="flex flex-col divide-y divide-line">
        {[...lines, ...(brand ? [{ label: 'Sold by', value: brand, mono: false }] : [])].map(
          (l) => (
            <div
              key={l.label}
              className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5"
            >
              <dt className="text-[14px] text-body">{l.label}</dt>
              <dd
                className={cn(
                  'text-[14px] text-ink',
                  l.mono && 'tabular-nums break-all',
                  l.label === 'Charged' && 'text-[17px] font-medium',
                )}
              >
                {l.value}
              </dd>
            </div>
          ),
        )}
      </dl>
      {view.released.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line py-3">
          {view.released.map((r) => (
            <li key={r.bidId} className="font-mono text-[13px] text-body tabular-nums">
              {r.text}
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line pt-3 text-[13px] text-body">
        Pay-your-bid: you paid your own bid of {formatUsd(view.amountCents)}, nothing more.
      </p>
    </section>
  );
}

function Tracker({ view }: { view: WonView }) {
  const steps = trackerSteps(view.shipment);
  const s = view.shipment;
  const { demoMode } = clientConfig();
  return (
    <section
      aria-labelledby="shipping"
      className="flex flex-col gap-4 rounded-sm border border-line bg-white p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="shipping" className="label text-[11px] text-muted">
          Shipping
        </h2>
        {s?.trackingNumber &&
          (s.trackingUrl ? (
            <a
              href={s.trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[12px] break-all text-ink hover:text-orange"
            >
              {[s.carrier, s.trackingNumber].filter(Boolean).join(' ')} <span aria-hidden>↗</span>
            </a>
          ) : (
            <span className="font-mono text-[12px] break-all text-ink">
              {[s.carrier, s.trackingNumber].filter(Boolean).join(' ')}
            </span>
          ))}
      </div>
      <p data-testid="shipping-summary" className="text-[15px] text-ink">
        {shippingSummary(s)}
      </p>
      <ol aria-label="Shipping progress" className="flex flex-col">
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            <li
              key={step.stage}
              aria-current={step.current ? 'step' : undefined}
              className="relative flex gap-4 pb-5 last:pb-0"
            >
              {!last && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-3 left-[5px] h-full w-0.5',
                    steps[i + 1]!.done ? 'bg-ink' : 'bg-line',
                  )}
                />
              )}
              <span
                aria-hidden
                className={cn(
                  'relative mt-1.5 h-3 w-3 shrink-0 rounded-full border-2',
                  step.current
                    ? 'border-orange bg-orange'
                    : step.done
                      ? 'border-ink bg-ink'
                      : 'border-line bg-white',
                )}
              />
              <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className={cn('text-[15px]', step.done ? 'text-ink' : 'text-muted')}>
                    {step.label}
                    <span className="sr-only">{step.done ? ' (done)' : ''}</span>
                  </span>
                  <span className="text-[13px] text-body">
                    {trackerDetail(step.stage, view.listing.brandName)}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[12px] text-muted">
                  {step.stage === 'SHIPPED' && step.done && s?.shippedAt
                    ? formatWhen(s.shippedAt)
                    : step.done
                      ? ''
                      : '–'}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {demoMode && (
        <p className="border-t border-line pt-3 text-[12px] text-muted">
          Demo: “Out for delivery” and “Delivered” are set from Ops › Mark delivered (demo only). No
          carrier feed yet.
        </p>
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
