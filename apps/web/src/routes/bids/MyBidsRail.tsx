import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { formatUsd, type MandateListBody, type MandateView } from '@holdfast/shared';
import { Badge, buttonClass, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { heldCaption, wonCaption, type MyBid } from '../../lib/bids';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';

/**
 * v4 My bids right rail (frame 114:145): the money PayPal is holding, the agent's mandate with
 * "Chat with your agent" (→ /agent) and "All mandates" (→ /mandates), and the latest win with
 * "View receipt & tracking" (→ /bids/:id/won). Stacks under the list on phones.
 */
export function MyBidsRail({
  held,
  won,
}: {
  held: { cents: number; count: number } | null;
  won: MyBid | null;
}) {
  return (
    <aside aria-label="Summary" className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-sm bg-ink p-5 text-white">
        <h2 className="label text-[11px] text-white/70">Held on your PayPal</h2>
        {held ? (
          <>
            <p className="text-[40px] leading-none font-medium tracking-headline tabular-nums">
              {formatUsd(held.cents)}
            </p>
            <p className="text-[14px] text-white/80">{heldCaption(held.count)}</p>
          </>
        ) : (
          <Skeleton className="h-10 w-32 bg-white/10" />
        )}
      </section>
      <AgentCard />
      {won && <RecentlyWon bid={won} />}
    </aside>
  );
}

function AgentCard() {
  const [mandate, setMandate] = useState<MandateView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api
      .request<MandateListBody>({ method: 'GET', path: '/api/mandates' })
      .then((r) => {
        if (!live) return;
        const pick =
          r.mandates.find((m) => m.state === 'active') ??
          r.mandates.find((m) => m.state === 'paused') ??
          null;
        setMandate(pick);
      })
      .catch(() => live && setMandate(null));
    return () => {
      live = false;
    };
  }, []);

  const rows: Array<[string, string]> = mandate
    ? [
        ['Max price', `${formatUsd(mandate.maxPriceCents)} per item`],
        ['Hold cap', `${formatUsd(mandate.totalHoldCapCents)} total`],
        [
          'Products',
          mandate.products.length
            ? mandate.products.map((p) => p.title ?? 'Product').join(', ')
            : 'Any product',
        ],
        [
          'Expires',
          mandate.expiresAt
            ? new Date(mandate.expiresAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : 'No end date',
        ],
      ]
    : [];

  return (
    <section className="flex flex-col gap-3 rounded-sm border border-line bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="label text-[11px] text-muted">Your agent</h2>
        {mandate && (
          <Badge tone={mandate.state === 'active' ? 'success' : 'neutral'}>
            {mandate.state === 'active' ? 'Active' : 'Paused'}
          </Badge>
        )}
      </div>
      {mandate === undefined ? (
        <Skeleton className="h-24 w-full" />
      ) : mandate ? (
        <>
          <p className="text-[16px] font-medium text-ink">Bids for you within these limits</p>
          <dl className="flex flex-col gap-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3 text-[14px]">
                <dt className="shrink-0 text-body">{k}</dt>
                <dd className="min-w-0 truncate text-right text-ink tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="text-[14px] text-body">
          No mandate yet. Set a max price and your agent keeps bidding within it.
        </p>
      )}
      <Link to={paths.mandates} className="label text-[12px] text-ink hover:text-orange">
        All mandates <span aria-hidden>→</span>
      </Link>
      <Link to={paths.agent} className={cn(buttonClass({ variant: 'secondary' }), 'w-full')}>
        Chat with your agent <span aria-hidden>→</span>
      </Link>
    </section>
  );
}

function RecentlyWon({ bid }: { bid: MyBid }) {
  return (
    <section className="flex flex-col gap-3 rounded-sm border border-line bg-white p-5">
      <h2 className="label text-[11px] text-muted">Recently won</h2>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface">
          {bid.listing.imageUrl && (
            <img src={bid.listing.imageUrl} alt="" className="h-full w-full object-contain" />
          )}
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] text-ink">{bid.listing.title ?? 'Your win'}</span>
          <span className="text-[13px] text-body">{wonCaption(bid)}</span>
        </div>
      </div>
      <Link to={paths.bidWon(bid.bidId)} className="label text-[12px] text-ink hover:text-orange">
        View receipt &amp; tracking <span aria-hidden>→</span>
      </Link>
    </section>
  );
}
