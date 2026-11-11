import { useState } from 'react';
import { Link } from 'react-router';
import { formatUsd, releasedHoldMessage } from '@holdfast/shared';
import { Badge, Button, useToast } from '../../components/ui';
import { minRaiseCents, sliderRange, type OfferView } from '../../lib/offer';
import { useApiAction } from '../../lib/use-api-action';
import { PriceInput } from './PriceInput';

interface RaiseResponse {
  bidId: string;
  status: string;
  approveUrl?: string;
}

/**
 * "Already bid" (W12 state; `409 ALREADY_BID` or an existing bid): your bid + Raise (HF-018) /
 * Cancel (HF-016). Lowering is cancel + a new bid, which loses time priority (D3).
 */
export function MyBidPanel({
  offer,
  canRaise,
  onChanged,
  onLower,
}: {
  offer: OfferView;
  canRaise: boolean;
  onChanged(): void;
  /** After a cancel for lowering: back to the bid form at this price. */
  onLower(): void;
}) {
  const bid = offer.myBid!;
  const toast = useToast();
  const [raiseTo, setRaiseTo] = useState(() => minRaiseCents(bid.amountCents));
  const [confirmCancel, setConfirmCancel] = useState<null | 'cancel' | 'lower'>(null);
  const raise = useApiAction<RaiseResponse>();
  const cancel = useApiAction<{ bidId: string; status: string }>();
  const held = bid.status === 'HELD';
  const minRaise = minRaiseCents(bid.amountCents);

  const doRaise = async () => {
    if (raise.status === 'pending' || raiseTo < minRaise) return;
    const res = await raise.run({
      method: 'POST',
      path: `/api/bids/${bid.bidId}/raise`,
      body: { amountCents: raiseTo },
    });
    if (!res) return;
    if (res.approveUrl) {
      window.location.assign(res.approveUrl);
      return;
    }
    raise.reset();
    toast.show({
      tone: 'success',
      title: `Raised to ${formatUsd(raiseTo)}`,
      body: 'Held, not charged.',
    });
    onChanged();
  };

  const doCancel = async (then: 'cancel' | 'lower') => {
    if (cancel.status === 'pending') return;
    const res = await cancel.run({ method: 'POST', path: `/api/bids/${bid.bidId}/cancel` });
    if (!res) return;
    cancel.reset();
    setConfirmCancel(null);
    toast.show({
      tone: 'info',
      title: held ? `Your ${formatUsd(bid.amountCents)} bid is cancelled` : 'Your bid is cancelled',
      body: held ? releasedHoldMessage(bid.amountCents) : undefined,
    });
    if (then === 'lower') onLower();
    else onChanged();
  };

  return (
    <section aria-labelledby="my-bid" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 id="my-bid" className="label text-[12px] text-muted">
          Your bid
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[40px] leading-none font-medium tracking-headline text-ink tabular-nums">
            {formatUsd(bid.amountCents)}
          </span>
          {held ? (
            <Badge tone="held">Held · not charged</Badge>
          ) : (
            <Badge tone="neutral">Waiting for approval</Badge>
          )}
        </div>
        {!bid.releaseIfCheaper && (
          <p className="text-[13px] text-body">We won't release this bid for a cheaper store.</p>
        )}
        <Link to={`/bids/${bid.bidId}`} className="text-[13px] text-body underline">
          View bid details
        </Link>
      </div>

      {canRaise && held && (
        <div className="flex flex-col gap-3 border-t border-line pt-5">
          <PriceInput
            label="Raise to"
            amount={raiseTo}
            onChange={setRaiseTo}
            range={sliderRange(offer, Math.max(raiseTo, minRaise))}
            hint={`At least ${formatUsd(minRaise)} ($1 or 1% more). You keep your hold until the new one lands.`}
            disabled={raise.status === 'pending'}
          />
          <Button
            size="lg"
            block
            onClick={doRaise}
            disabled={raise.status === 'pending' || raiseTo < minRaise}
          >
            {raise.status === 'pending' ? '…' : `Raise to ${formatUsd(raiseTo)}`}
          </Button>
          {raise.status === 'error' && (
            <p role="alert" className="text-[13px] text-danger">
              {raise.error.message}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-line pt-5">
        {confirmCancel ? (
          <div role="alertdialog" aria-labelledby="cancel-q" className="flex flex-col gap-3">
            <p id="cancel-q" className="text-[14px] text-ink">
              {confirmCancel === 'lower'
                ? `Cancel your ${formatUsd(bid.amountCents)} bid and bid lower? Your place in line resets: the new bid counts from when you place it.`
                : held
                  ? `Release your ${formatUsd(bid.amountCents)} hold?`
                  : 'Cancel this bid?'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => doCancel(confirmCancel)}
                disabled={cancel.status === 'pending'}
              >
                {cancel.status === 'pending' ? '…' : 'Yes, cancel it'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmCancel(null)}>
                Keep my bid
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setConfirmCancel('cancel')}>
              Cancel bid
            </Button>
            {offer.biddable && (
              <Button variant="ghost" onClick={() => setConfirmCancel('lower')}>
                Bid lower
              </Button>
            )}
          </div>
        )}
        {offer.biddable && !confirmCancel && (
          <p className="text-[12px] text-muted">
            Lowering a bid means cancelling it and bidding again; time priority resets.
          </p>
        )}
        {cancel.status === 'error' && (
          <p role="alert" className="text-[13px] text-danger">
            {cancel.error.message}
          </p>
        )}
      </div>
    </section>
  );
}
