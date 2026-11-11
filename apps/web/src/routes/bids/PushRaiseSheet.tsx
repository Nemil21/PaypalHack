import { useState } from 'react';
import { useToast } from '../../components/ui';
import {
  raisedCopy,
  raiseErrorCopy,
  raiseSheetMinCents,
  raiseToastBody,
  type MyBid,
  type RaiseResponse,
} from '../../lib/bids';
import { useApiAction } from '../../lib/use-api-action';
import { RaiseSheet } from './RaiseSheet';

/**
 * M07 from the `below_clearing` push (HF-054b; screens.md §M07): "Bids around $219 are likely
 * to clear." on an OPEN listing, where the live-rounds card (RoundsRaise) isn't shown. Same sheet
 * and the same `POST /api/bids/:id/raise` swap as in rounds; one tap = one Idempotency-Key.
 */
export function PushRaiseSheet({
  bid,
  aroundCents,
  onRaised,
  onClose,
}: {
  bid: MyBid;
  /** The likely-clearing amount from the push (public, floor-blind). */
  aroundCents: number;
  onRaised(res: RaiseResponse): void;
  onClose(): void;
}) {
  const toast = useToast();
  const raise = useApiAction<RaiseResponse>();
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  const pending = raise.status === 'pending';
  const close = () => {
    setClosed(true);
    onClose();
  };

  return (
    <RaiseSheet
      currentCents={bid.amountCents}
      suggestedCents={Math.max(raiseSheetMinCents(bid.amountCents), aroundCents)}
      cutoffCents={aroundCents}
      agentMessage={null}
      pending={pending}
      error={
        raise.status === 'error' ? raiseErrorCopy(raise.error.code, raise.error.message, bid) : null
      }
      onRaise={(amountCents) => {
        if (pending) return;
        if (raise.status === 'error') raise.reset();
        void (async () => {
          const res = await raise.run({
            method: 'POST',
            path: `/api/bids/${bid.bidId}/raise`,
            body: { amountCents },
          });
          if (!res) return;
          if (res.approveUrl) {
            window.location.assign(res.approveUrl);
            return;
          }
          raise.reset();
          toast.show({ tone: 'success', title: raisedCopy(res), body: raiseToastBody(res) });
          close();
          onRaised(res);
        })();
      }}
      onClose={close}
    />
  );
}
