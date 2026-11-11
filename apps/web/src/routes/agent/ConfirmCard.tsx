import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { formatUsd } from '@holdfast/shared';
import { Badge, Button, ButtonLink } from '../../components/ui';
import {
  approveLabel,
  cardAmount,
  cardNote,
  cardTitle,
  cardWhere,
  doneText,
  expiryText,
  failedText,
  type ChatAction,
  type ConfirmResultBody,
  type ThreadItem,
} from '../../lib/agent-chat';
import { FIXTURE_CONFIRM_RESULT } from '../../lib/agent-chat.fixture';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';
import { ApiAction, ApiError, api } from '../../lib/api';
import { useNow } from '../bids/hooks';

type ConfirmItem = Extract<ThreadItem, { kind: 'confirm' }>;

/**
 * Confirm card (W16; M05 shows the pending one as a bottom sheet). Every number on it is the
 * stored pending action's, from the `confirm_required` event (B10), never the model's prose.
 *   INLINE (vaulted shopper): "Approve with PayPal" → `POST /api/agent/actions/:id/confirm`, which
 *     runs the stored arguments. One `ApiAction` per card: a retry reuses its Idempotency-Key.
 *   OFFER_PAGE (no saved card): "Continue on the offer page" → W12 prefilled (M24).
 */
export function ConfirmCard({
  item,
  sheet,
  fixture,
  dispatch,
  onExecuted,
}: {
  item: ConfirmItem;
  /** The newest pending card on a phone: a bottom sheet over the composer. */
  sheet: boolean;
  fixture: boolean;
  dispatch(a: ChatAction): void;
  onExecuted(): void;
}) {
  const { card, state } = item;
  const now = useNow(15_000);
  const action = useRef<ApiAction | null>(null);
  action.current ??= new ApiAction(api);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const expiry = state.status === 'pending' ? expiryText(card.expiresAt, now) : null;
  const expired = expiry === 'Expired';

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = fixture
        ? await new Promise<ConfirmResultBody>((r) =>
            setTimeout(() => r(FIXTURE_CONFIRM_RESULT), 600),
          )
        : await action.current!.run<ConfirmResultBody>({
            method: 'POST',
            path: `/api/agent/actions/${encodeURIComponent(card.actionId)}/confirm`,
          });
      dispatch({ type: 'confirmed', actionId: card.actionId, result });
      onExecuted();
    } catch (err) {
      const e =
        err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
      const reason = e.details.reason;
      if (reason === 'NEEDS_PAYMENT_METHOD') {
        const offerUrl = typeof e.details.offerUrl === 'string' ? e.details.offerUrl : null;
        dispatch({ type: 'offer_page', actionId: card.actionId, offerUrl });
      } else if (reason === 'ACTION_EXPIRED' || e.code === 'NOT_FOUND') {
        dispatch({
          type: 'expired',
          actionId: card.actionId,
          message: 'This proposal expired. Ask the agent again.',
        });
      } else if (reason === 'ACTION_REJECTED') {
        dispatch({ type: 'declined', actionId: card.actionId });
      } else if (!e.retryable) {
        // The action executed and the bid service refused it (WINDOW_CLOSED, HOLD_FAILED, …):
        // the server stored that answer, so Approve would only replay it.
        dispatch({
          type: 'action_failed',
          actionId: card.actionId,
          message: failedText(card, e.message),
        });
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const where = cardWhere(card);
  const amount = cardAmount(card);
  const offerUrl =
    state.status === 'offer_page' ? (state.offerUrl ?? card.offerUrl) : card.offerUrl;
  const offerMode = card.confirmMode === 'OFFER_PAGE' || state.status === 'offer_page';

  const body = (
    <div
      className={cn(
        'flex flex-col gap-4 bg-white p-5',
        sheet
          ? 'rounded-t-md pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-card lg:rounded-md lg:border lg:border-line lg:shadow-none'
          : 'rounded-md border border-line',
        state.status === 'pending' && 'border-orange/40',
      )}
    >
      {sheet && <span aria-hidden className="mx-auto h-1 w-10 rounded-full bg-line lg:hidden" />}
      <div className="flex items-center justify-between gap-3">
        <p className="label text-[11px] text-muted">Agent proposal</p>
        <StatusBadge item={item} expired={expired} />
      </div>

      <div className="flex gap-4">
        {card.product?.imageUrl && (
          <img
            src={card.product.imageUrl}
            alt=""
            className="h-16 w-16 shrink-0 rounded-sm border border-line object-contain"
          />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <p
            id={`confirm-${card.actionId}`}
            className="text-[28px] leading-none font-medium tracking-headline text-ink tabular-nums"
            data-testid="confirm-amount"
          >
            {cardTitle(card)}
          </p>
          {card.product?.title && <p className="text-[15px] text-ink">{card.product.title}</p>}
          {where && <p className="text-[14px] text-body">{where}</p>}
        </div>
      </div>

      {card.tool === 'cancel_bid' && card.bids && card.bids.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line pt-3 text-[14px] text-body">
          {card.bids.map((b) => (
            <li key={b.bidId} className="flex justify-between gap-3">
              <span className="truncate">{b.title ?? 'Bid'}</span>
              <span className="font-mono tabular-nums">{formatUsd(b.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}

      {state.status === 'pending' && (
        <>
          <p className="text-[13px] text-body">
            {offerMode
              ? 'Add a payment method on the offer page to place this bid. Your amount is filled in.'
              : cardNote(card)}
          </p>
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error.message}
              {error.retryable ? ' Try again.' : ''}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {offerMode ? (
              offerUrl ? (
                <ButtonLink to={offerUrl} block className="sm:w-auto">
                  Continue on the offer page
                </ButtonLink>
              ) : (
                <ButtonLink to={paths.bids} block className="sm:w-auto" variant="outline">
                  Open my bids
                </ButtonLink>
              )
            ) : (
              <Button
                size="lg"
                block
                className="sm:w-auto"
                disabled={busy || expired}
                onClick={() => void approve()}
                aria-describedby={`confirm-${card.actionId}`}
              >
                {busy ? '…' : approveLabel(card)}
              </Button>
            )}
            <Button
              variant="ghost"
              size="lg"
              block
              className="sm:w-auto"
              disabled={busy}
              onClick={() => dispatch({ type: 'declined', actionId: card.actionId })}
            >
              Not now
            </Button>
          </div>
          {expiry && !expired && (
            <p className="font-mono text-[11px] text-muted">
              {expiry} · nothing happens until you approve
            </p>
          )}
          {expired && (
            <p className="text-[13px] text-body">This proposal expired. Ask the agent again.</p>
          )}
        </>
      )}

      {state.status === 'done' && <DoneBlock item={item} result={state.result} />}
      {state.status === 'offer_page' && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-body">
            No saved payment method yet. Place this {amount ?? ''} bid on the offer page; your
            amount is filled in.
          </p>
          {offerUrl && (
            <ButtonLink to={offerUrl} block className="sm:w-auto sm:self-start">
              Continue on the offer page
            </ButtonLink>
          )}
        </div>
      )}
      {state.status === 'expired' && <p className="text-[13px] text-body">{state.message}</p>}
      {state.status === 'failed' && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-[14px] text-danger">
            {state.message}
          </p>
          <p className="text-[13px] text-body">Nothing was held. Ask the agent to try again.</p>
        </div>
      )}
      {state.status === 'declined' && (
        <p className="text-[13px] text-body">Not placed. Nothing was held.</p>
      )}
    </div>
  );

  if (!sheet) return body;
  // Phones: a bottom sheet (M05). From `lg` it sits in the thread like any other card.
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={`confirm-${card.actionId}`}
      className="fixed inset-x-0 bottom-0 z-30 lg:static lg:z-auto"
    >
      {body}
    </div>
  );
}

function StatusBadge({ item, expired }: { item: ConfirmItem; expired: boolean }) {
  switch (item.state.status) {
    case 'pending':
      return expired ? <Badge tone="sim">Expired</Badge> : <Badge tone="held">Needs your OK</Badge>;
    case 'done':
      return item.card.tool === 'cancel_bid' ? (
        <Badge tone="neutral">Cancelled</Badge>
      ) : item.state.result.status === 'HELD' ? (
        <Badge tone="held">Held · not charged</Badge>
      ) : (
        <Badge tone="neutral">{item.state.result.status}</Badge>
      );
    case 'offer_page':
      return <Badge tone="neutral">Finish on offer page</Badge>;
    case 'expired':
      return <Badge tone="sim">Expired</Badge>;
    case 'failed':
      return <Badge tone="danger">Didn’t go through</Badge>;
    case 'declined':
      return <Badge tone="sim">Not now</Badge>;
  }
}

function DoneBlock({ item, result }: { item: ConfirmItem; result: ConfirmResultBody }) {
  return (
    <div className="flex flex-col gap-2" role="status">
      <p className="text-[15px] font-medium text-ink">{doneText(item.card, result)}</p>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {result.bidId && (
          <Link
            to={`${paths.bids}/${encodeURIComponent(result.bidId)}`}
            className="label text-[12px] text-orange underline-offset-4 hover:underline"
          >
            Open bid →
          </Link>
        )}
        <Link
          to={paths.bids}
          className="label text-[12px] text-body underline-offset-4 hover:underline"
        >
          My bids →
        </Link>
      </div>
    </div>
  );
}
