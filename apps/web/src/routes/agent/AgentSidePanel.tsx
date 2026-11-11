import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { formatUsd, type MandateListBody, type MandateView } from '@holdfast/shared';
import { Badge, ButtonLink, Skeleton } from '../../components/ui';
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
    <aside aria-label="Your bids and mandate" className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="label text-[12px] text-muted">Live bids</h2>
        {load.state === 'loading' && <Skeleton className="h-24" />}
        {load.state === 'signed_out' && (
          <p className="text-[14px] text-body">Bids you place show up here.</p>
        )}
        {load.state === 'error' && (
          <p className="text-[14px] text-body">Couldn’t load your bids right now.</p>
        )}
        {load.state === 'ready' && <LiveBids bids={bidsInTab(load.bids, 'live')} />}
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-6">
        <h2 className="label text-[12px] text-muted">Mandate</h2>
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
    <ul className="flex flex-col border border-line" data-testid="side-live-bids">
      {bids.map((b, i) => {
        const pill = statusPill(b.status);
        return (
          <li key={b.bidId} className={i > 0 ? 'border-t border-line' : undefined}>
            <Link
              to={`${paths.bids}/${encodeURIComponent(b.bidId)}`}
              className="flex flex-col gap-1.5 p-3 hover:bg-surface"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[14px] text-ink">{b.listing.title ?? 'Bid'}</span>
                <span className="font-mono text-[14px] text-ink tabular-nums">
                  {formatUsd(b.amountCents)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={pill.tone}>{pill.label}</Badge>
                {b.source === 'BUYER_AGENT' && <Badge tone="sim">Agent</Badge>}
              </div>
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
    <ul className="flex flex-col gap-3" data-testid="side-mandate">
      {active.map((m) => {
        const usage = capUsage(m.liveHoldCents, m.totalHoldCapCents);
        return (
          <li key={m.mandateId}>
            <Link to={paths.mandate(m.mandateId)} className="flex flex-col gap-2 hover:opacity-80">
              <p className="text-[15px] font-medium text-ink tabular-nums">
                Up to {formatUsd(m.maxPriceCents)} per item
              </p>
              <p className="truncate text-[13px] text-body">
                {m.products.length
                  ? m.products.map((p) => p.title ?? 'Product').join(', ')
                  : 'Any product'}
              </p>
              <div
                role="meter"
                aria-label="Live holds against your cap"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usage.percent}
                className="h-1.5 w-full overflow-hidden rounded-sm bg-surface-line"
              >
                <div className="h-full bg-orange" style={{ width: `${usage.percent}%` }} />
              </div>
              <span className="font-mono text-[12px] text-body tabular-nums">{usage.text}</span>
              {m.needsPaymentMethod && <Badge tone="danger">Payment method needs update</Badge>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
