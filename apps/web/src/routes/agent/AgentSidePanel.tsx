import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { formatUsd, type MandateListBody, type MandateView } from '@holdfast/shared';
import { ButtonLink, Skeleton } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { bidsInTab, statusPill, type MyBid } from '../../lib/bids';
import { capUsage } from '../../lib/mandate-form';
import { paths } from '../../lib/routes';
import { usePolling } from '../bids/hooks';

/** Live bids refresh this often while the chat is open (and right after every turn / confirm). */
export const SIDE_PANEL_POLL_MS = 10_000;

type Load =
  | { state: 'loading' }
  | { state: 'signed_out' }
  | { state: 'error' }
  | { state: 'ready'; bids: MyBid[]; mandates: MandateView[] };

/**
 * W16 desktop side panel (HF-041 scope 4): the shopper's live bids (`GET /api/bids/mine`, W14's
 * Live tab) and a mandate summary (`GET /api/mandates`). A HELD row confirmed in chat shows up
 * here on the next refresh, which the page triggers right after the confirm.
 */
export function AgentSidePanel({ refreshKey }: { refreshKey: number }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const fetchAll = useCallback(async () => {
    try {
      const [bids, mandates] = await Promise.all([
        api.request<{ bids: MyBid[] }>({ method: 'GET', path: '/api/bids/mine' }),
        api.request<MandateListBody>({ method: 'GET', path: '/api/mandates' }),
      ]);
      setLoad({ state: 'ready', bids: bids.bids, mandates: mandates.mandates });
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      setLoad((prev) =>
        e?.status === 401
          ? { state: 'signed_out' }
          : prev.state === 'ready'
            ? prev // keep the last good panel through a failed background refresh
            : { state: 'error' },
      );
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll, refreshKey]);
  usePolling(load.state === 'ready', SIDE_PANEL_POLL_MS, () => void fetchAll());

  return (
    <aside aria-label="Your bids and mandate" className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-md border border-line bg-white p-5">
        <h2 className="label text-[11px] text-muted">
          Live bids
          {load.state === 'ready' && ` · ${bidsInTab(load.bids, 'live').length}`}
        </h2>
        {load.state === 'loading' && <Skeleton className="h-24" />}
        {load.state === 'signed_out' && (
          <p className="text-[14px] text-body">Bids you place show up here.</p>
        )}
        {load.state === 'error' && (
          <p className="text-[14px] text-body">Couldn’t load your bids right now.</p>
        )}
        {load.state === 'ready' && <LiveBids bids={bidsInTab(load.bids, 'live')} />}
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-line bg-white p-5">
        <h2 className="label text-[11px] text-muted">Mandate</h2>
        {load.state === 'loading' && <Skeleton className="h-16" />}
        {load.state === 'ready' && <MandateSummary mandates={load.mandates} />}
        {(load.state === 'signed_out' || load.state === 'error') && (
          <p className="text-[14px] text-body">A mandate lets your agent bid within your limits.</p>
        )}
      </section>
    </aside>
  );
}

function LiveBids({ bids }: { bids: MyBid[] }) {
  if (!bids.length) return <p className="text-[14px] text-body">No live bids yet.</p>;
  return (
    <ul className="flex flex-col gap-1" data-testid="side-live-bids">
      {bids.map((b) => {
        const pill = statusPill(b.status);
        return (
          <li key={b.bidId}>
            <Link
              to={`${paths.bids}/${encodeURIComponent(b.bidId)}`}
              className="-mx-2 flex flex-col gap-0.5 rounded-sm px-2 py-1.5 hover:bg-surface"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[14px] text-ink">{b.listing.title ?? 'Bid'}</span>
                <span className="text-[14px] font-medium text-ink tabular-nums">
                  {formatUsd(b.amountCents)}
                </span>
              </span>
              <span className="font-mono text-[11px] text-muted">
                {pill.label}
                {b.source === 'BUYER_AGENT' && ' · by your agent'}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function MandateSummary({ mandates }: { mandates: MandateView[] }) {
  const active = mandates.filter((m) => m.state === 'active');
  if (!active.length) {
    const paused = mandates.find((m) => m.state === 'paused');
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[14px] text-body">
          {paused
            ? 'Your mandate is paused. The agent still asks you before every bid.'
            : 'No mandate. The agent asks you before every bid.'}
        </p>
        <ButtonLink
          to={paused ? paths.mandate(paused.mandateId) : paths.newMandate()}
          variant="outline"
        >
          {paused ? 'Open mandate' : 'Set up a mandate'}
        </ButtonLink>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3" data-testid="side-mandate">
        {active.map((m) => {
          const usage = capUsage(m.liveHoldCents, m.totalHoldCapCents);
          return (
            <li key={m.mandateId}>
              <Link
                to={paths.mandate(m.mandateId)}
                className="flex flex-col gap-1 hover:opacity-80"
              >
                <p className="text-[15px] font-medium text-ink tabular-nums">
                  Up to {formatUsd(m.maxPriceCents)} · cap {formatUsd(m.totalHoldCapCents)}
                </p>
                <p className="truncate text-[13px] text-body">
                  {m.products.length
                    ? m.products.map((p) => p.title ?? 'Product').join(', ')
                    : 'Any product'}
                </p>
                <span className="text-[13px] text-body tabular-nums">{usage.text}</span>
                {m.needsPaymentMethod && (
                  <span className="text-[12px] text-orange">Payment method needs update</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <Link to={paths.mandates} className="label text-[11px] text-ink hover:text-orange">
        All mandates →
      </Link>
    </div>
  );
}
