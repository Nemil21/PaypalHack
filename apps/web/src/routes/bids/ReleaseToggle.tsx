import { useState } from 'react';
import { formatUsd } from '@holdfast/shared';
import { useToast } from '../../components/ui';
import type { MyBid } from '../../lib/bids';
import { cn } from '../../lib/cn';
import { useApiAction } from '../../lib/use-api-action';

/** `PATCH /api/bids/:id` answer (packages/core/src/bid-price-watch.ts). */
export interface PatchedBid {
  bidId: string;
  status: string;
  releaseIfCheaper: boolean;
  cheaper: { priceCents: number; merchant: string | null; url: string | null } | null;
  message: string | null;
}

/**
 * "Watch prices for me" (W13 opt-in card, W15 summary; v4 frame 119:709). Owner-only
 * `PATCH /api/bids/:id {releaseIfCheaper}` with an Idempotency-Key per toggle. Switching it on
 * when a store is already below the bid releases the hold at once (PRICE_DROP); `onChanged` lets
 * the page reload the bid to show that.
 */
export function ReleaseToggle({
  bid,
  onChanged,
  className,
}: {
  bid: Pick<MyBid, 'bidId' | 'status' | 'amountCents' | 'releaseIfCheaper'>;
  onChanged(res: PatchedBid): void;
  className?: string;
}) {
  const toast = useToast();
  const action = useApiAction<PatchedBid>();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const on = optimistic ?? bid.releaseIfCheaper;
  const live = bid.status === 'HELD' || bid.status === 'PENDING_APPROVAL';
  const pending = action.status === 'pending';

  const toggle = async () => {
    if (pending || !live) return;
    const next = !on;
    setOptimistic(next);
    const res = await action.run({
      method: 'PATCH',
      path: `/api/bids/${bid.bidId}`,
      body: { releaseIfCheaper: next },
    });
    setOptimistic(null);
    if (!res) return;
    action.reset(); // the next toggle is a new action with a new key
    if (res.cheaper) {
      toast.show({
        tone: 'info',
        title: `A store sells it for ${formatUsd(res.cheaper.priceCents)}`,
        body: res.message ?? undefined,
      });
    }
    onChanged(res);
  };

  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 rounded-md border border-line bg-white p-4',
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <span id={`ric-${bid.bidId}`} className="text-[15px] font-medium text-ink">
          Watch prices for me
        </span>
        <span className="text-[13px] text-body">
          {on
            ? `Release my hold if a store goes under ${formatUsd(bid.amountCents)}.`
            : "Off. We won't release this bid for a cheaper store."}
        </span>
        {action.status === 'error' && (
          <span role="alert" className="text-[13px] text-danger">
            {action.error.message}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`ric-${bid.bidId}`}
        disabled={pending || !live}
        onClick={() => void toggle()}
        className={cn(
          'relative mt-1 h-7 w-12 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          on ? 'bg-orange' : 'bg-planned',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow-card transition-transform',
            on && 'translate-x-5',
          )}
        />
      </button>
    </div>
  );
}
