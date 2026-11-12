import { useEffect, useState } from 'react';
import { formatUsd } from '@holdfast/shared';
import { Button, useToast } from '../../components/ui';
import {
  canRaiseOpen,
  markSheetAutoOpened,
  raiseSheetMinCents,
  raisedCopy,
  raiseErrorCopy,
  raiseToastBody,
  roundsAction,
  shouldAutoOpenSheet,
  type MyBid,
  type RaiseResponse,
} from '../../lib/bids';
import { cn } from '../../lib/cn';
import { useApiAction } from '../../lib/use-api-action';
import { RaiseSheet } from './RaiseSheet';

/**
 * Live rounds on the bid page (HF-038a; W14 card, W15 summary). A nudged bid shows the round's
 * nudge ("You're out at $219. The cutoff is $240. Raise to $241?") and raises in one tap to the
 * nudge's suggested amount through `POST /api/bids/:id/raise` (HF-018 swap). Each tap is one user
 * action with its own Idempotency-Key; a network retry of that tap reuses it. Wallet-only bids
 * go to PayPal (`approveUrl`). After `rounds_end_at` the raise is hidden: "Rounds ended. Waiting
 * for the brand to clear."
 *
 * HF-038b: when the buyer agent asked instead of raising (no mandate, over its max or the public
 * price, out of raises), the M07 raise sheet opens by itself once per nudge, with the agent's
 * reason. "Choose amount" opens it any time.
 */
/**
 * One raise through `POST /api/bids/:id/raise` (HF-018 swap), shared by the rounds block and the
 * v4 "Raise" on OPEN bids. Each call is one user action with its own Idempotency-Key; wallet-only
 * bids go to PayPal (`approveUrl`).
 */
export function useBidRaise(
  bid: MyBid,
  {
    onRaised,
    onRefresh,
    onDone,
  }: { onRaised(res: RaiseResponse): void; onRefresh(): void; onDone?(): void },
) {
  const toast = useToast();
  const raise = useApiAction<RaiseResponse>();
  const pending = raise.status === 'pending';
  const doRaise = async (amountCents: number) => {
    if (pending) return;
    const res = await raise.run({
      method: 'POST',
      path: `/api/bids/${bid.bidId}/raise`,
      body: { amountCents },
    });
    if (!res) {
      // The window may have closed (or the bid changed) under us: reload so the page says so.
      onRefresh();
      return;
    }
    if (res.approveUrl) {
      window.location.assign(res.approveUrl);
      return;
    }
    raise.reset(); // the next tap is a new action with a fresh Idempotency-Key
    onDone?.();
    toast.show({ tone: 'success', title: raisedCopy(res), body: raiseToastBody(res) });
    onRaised(res);
  };
  const error =
    raise.status === 'error' ? raiseErrorCopy(raise.error.code, raise.error.message, bid) : null;
  const clearError = () => {
    if (raise.status === 'error') raise.reset();
  };
  return { pending, error, doRaise, clearError };
}

/**
 * v4 (frame 114:145): "Raise" on a HELD bid while the listing is still OPEN, not just in ROUNDS.
 * Opens the M07 sheet without a cutoff (there is none before rounds) at the minimum raise.
 */
export function OpenRaise({
  bid,
  onRaised,
  onRefresh,
}: {
  bid: MyBid;
  onRaised(res: RaiseResponse): void;
  onRefresh(): void;
}) {
  const [open, setOpen] = useState(false);
  const raise = useBidRaise(bid, { onRaised, onRefresh, onDone: () => setOpen(false) });
  if (!canRaiseOpen(bid)) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={raise.pending}>
        Raise
      </Button>
      {open && (
        <RaiseSheet
          currentCents={bid.amountCents}
          suggestedCents={raiseSheetMinCents(bid.amountCents)}
          cutoffCents={null}
          agentMessage={null}
          pending={raise.pending}
          error={raise.error}
          onRaise={(amountCents) => {
            raise.clearError();
            void raise.doRaise(amountCents);
          }}
          onClose={() => {
            raise.clearError();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

export function RoundsRaise({
  bid,
  onRaised,
  onRefresh,
  initialSheetOpen = false,
  className,
}: {
  bid: MyBid;
  /** Opened from a `round_nudge` push (HF-054b `?sheet=raise`): start with the M07 sheet open. */
  initialSheetOpen?: boolean;
  /** The raise landed (or is waiting for approval): reload, or follow the new bid. */
  onRaised(res: RaiseResponse): void;
  /** A refusal that changes what the page should show (e.g. rounds just ended). */
  onRefresh(): void;
  className?: string;
}) {
  const action = roundsAction(bid);
  const [sheetOpen, setSheetOpen] = useState(initialSheetOpen);
  const raise = useBidRaise(bid, { onRaised, onRefresh, onDone: () => setSheetOpen(false) });
  useEffect(() => {
    if (action?.kind === 'nudge' && shouldAutoOpenSheet(action)) {
      markSheetAutoOpened(action.nudgeId);
      setSheetOpen(true);
    }
  }, [action]);
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

  const { pending, doRaise } = raise;

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
        <Button onClick={() => void doRaise(action.suggestedCents)} disabled={pending}>
          {pending ? '…' : `Raise to ${formatUsd(action.suggestedCents)}`}
        </Button>
        <Button variant="ghost" onClick={() => setSheetOpen(true)} disabled={pending}>
          Choose amount
        </Button>
        <span className="text-[13px] text-body">
          New hold placed first, then your {formatUsd(bid.amountCents)} hold is released.
        </span>
      </div>
      {action.agentMessage && <p className="text-[13px] text-body">{action.agentMessage}</p>}
      {raise.error && !sheetOpen && (
        <p role="alert" className="text-[13px] text-danger">
          {raise.error}
        </p>
      )}
      {sheetOpen && (
        <RaiseSheet
          currentCents={bid.amountCents}
          suggestedCents={action.suggestedCents}
          cutoffCents={action.cutoffCents}
          agentMessage={action.agentMessage}
          pending={pending}
          error={raise.error}
          onRaise={(amountCents) => {
            // A different amount is a different action: a fresh Idempotency-Key.
            raise.clearError();
            void doRaise(amountCents);
          }}
          onClose={() => {
            raise.clearError();
            setSheetOpen(false);
          }}
        />
      )}
    </div>
  );
}
