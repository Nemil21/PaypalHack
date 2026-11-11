import { BANK_PENDING_NOTE, formatUsd } from '@holdfast/shared';
import { Button, useToast } from '../../components/ui';
import {
  raisedCopy,
  raiseErrorCopy,
  roundsAction,
  type MyBid,
  type RaiseResponse,
} from '../../lib/bids';
import { cn } from '../../lib/cn';
import { useApiAction } from '../../lib/use-api-action';

/**
 * Live rounds on the bid page (HF-038a; W14 card, W15 summary). A nudged bid shows the round's
 * nudge ("You're out at $219. The cutoff is $240. Raise to $241?") and raises in one tap to the
 * nudge's suggested amount through `POST /api/bids/:id/raise` (HF-018 swap). Each tap is one user
 * action with its own Idempotency-Key; a network retry of that tap reuses it. Wallet-only bids
 * go to PayPal (`approveUrl`). After `rounds_end_at` the raise is hidden: "Rounds ended. Waiting
 * for the brand to clear."
 */
export function RoundsRaise({
  bid,
  onRaised,
  onRefresh,
  className,
}: {
  bid: MyBid;
  /** The raise landed (or is waiting for approval): reload, or follow the new bid. */
  onRaised(res: RaiseResponse): void;
  /** A refusal that changes what the page should show (e.g. rounds just ended). */
  onRefresh(): void;
  className?: string;
}) {
  const toast = useToast();
  const raise = useApiAction<RaiseResponse>();
  const action = roundsAction(bid);
  if (!action) return null;

  if (action.kind === 'frozen') {
    return (
      <p
        role="status"
        className={cn('rounded-md bg-surface px-4 py-3 text-[14px] text-ink', className)}
      >
        {action.text}
      </p>
    );
  }

  const pending = raise.status === 'pending';
  const doRaise = async () => {
    if (pending) return;
    const res = await raise.run({
      method: 'POST',
      path: `/api/bids/${bid.bidId}/raise`,
      body: { amountCents: action.suggestedCents },
    });
    if (!res) {
      // Rounds may have ended (or the bid changed) under us: reload so the page says so.
      onRefresh();
      return;
    }
    if (res.approveUrl) {
      window.location.assign(res.approveUrl);
      return;
    }
    raise.reset(); // the next tap is a new action with a fresh Idempotency-Key
    const released = res.previousStatus === 'VOIDED';
    toast.show({
      tone: 'success',
      title: raisedCopy(res),
      body: [released ? BANK_PENDING_NOTE : null, res.warnSeveralHolds].filter(Boolean).join(' '),
    });
    onRaised(res);
  };

  return (
    <div
      role="region"
      aria-label={`Live round ${action.round}`}
      className={cn(
        'flex flex-col gap-3 rounded-md border border-orange/40 bg-white p-4',
        className,
      )}
    >
      <p className="text-[15px] text-ink">{action.text}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void doRaise()} disabled={pending}>
          {pending ? '…' : `Raise to ${formatUsd(action.suggestedCents)}`}
        </Button>
        <span className="text-[13px] text-body">
          New hold placed first, then your {formatUsd(bid.amountCents)} hold is released.
        </span>
      </div>
      {raise.status === 'error' && (
        <p role="alert" className="text-[13px] text-danger">
          {raiseErrorCopy(raise.error.code, raise.error.message, bid)}
        </p>
      )}
    </div>
  );
}
