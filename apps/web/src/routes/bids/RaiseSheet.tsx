import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatUsd } from '@holdfast/shared';
import { Button } from '../../components/ui';
import { raiseSheetConfirm, raiseSheetKeep, raiseSheetMinCents, stepRaise } from '../../lib/bids';

/**
 * M07 raise sheet (HF-038b; screens.md §M07, features/19 §Logic 4): the agent asks instead of
 * raising (no mandate, over its max or the public price, out of raises …), or the shopper wants
 * a different amount. Current bid, the suggested raise with a stepper, the new hold amount,
 * "Raise to $241 (new hold, old one released)" and "Keep $219". A bottom sheet on phones, a
 * centred dialog on wider screens (same frame as M06).
 */
export function RaiseSheet({
  currentCents,
  suggestedCents,
  cutoffCents,
  agentMessage,
  pending,
  error,
  onRaise,
  onClose,
}: {
  currentCents: number;
  suggestedCents: number;
  /** The round's cutoff; null on an OPEN listing (no rounds yet, v4 "Raise" on OPEN bids). */
  cutoffCents: number | null;
  /** Why the agent asked; shown above the numbers when set. */
  agentMessage: string | null;
  pending: boolean;
  error: string | null;
  onRaise(amountCents: number): void;
  onClose(): void;
}) {
  const min = raiseSheetMinCents(currentCents);
  const [amount, setAmount] = useState(Math.max(min, suggestedCents));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const wins = cutoffCents == null || amount > cutoffCents;

  // Portalled to <body>: <main> is its own stacking context and the footer would paint over it.
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-ink/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="m07-title"
        className="relative flex w-full max-w-[440px] flex-col gap-5 rounded-t-md bg-white p-5 pb-8 shadow-card sm:rounded-md sm:pb-6"
      >
        <span aria-hidden className="mx-auto h-1 w-10 rounded-full bg-line sm:hidden" />
        <h2 id="m07-title" className="text-[20px] font-medium tracking-headline text-ink">
          {cutoffCents != null
            ? `Bids around ${formatUsd(cutoffCents)} are likely to clear.`
            : 'Raise your bid'}
        </h2>
        {agentMessage && <p className="text-[14px] text-body">{agentMessage}</p>}
        <dl className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 rounded-md bg-surface p-3">
            <dt className="label text-[11px] text-muted">Current bid</dt>
            <dd className="text-[24px] text-body tabular-nums">{formatUsd(currentCents)}</dd>
          </div>
          <div className="flex flex-col gap-1 rounded-md bg-orange-tint p-3">
            <dt className="label text-[11px] text-muted">New hold</dt>
            <dd className="text-[24px] text-ink tabular-nums" aria-live="polite">
              {formatUsd(amount)}
            </dd>
          </div>
        </dl>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[14px] text-body">Suggested raise {formatUsd(suggestedCents)}</span>
          <div className="flex items-center gap-2" role="group" aria-label="Raise amount">
            <Button
              variant="outline"
              aria-label="Lower the raise"
              disabled={pending || amount <= min}
              onClick={() => setAmount((a) => stepRaise(currentCents, a, -1))}
            >
              −
            </Button>
            <Button
              variant="outline"
              aria-label="Raise more"
              disabled={pending}
              onClick={() => setAmount((a) => stepRaise(currentCents, a, 1))}
            >
              +
            </Button>
          </div>
        </div>
        {!wins && (
          <p className="text-[13px] text-orange">
            {formatUsd(amount)} may still be below the cutoff of {formatUsd(cutoffCents!)}.
          </p>
        )}
        <p className="text-[13px] text-body">
          We place the new {formatUsd(amount)} hold first, then release your{' '}
          {formatUsd(currentCents)} hold. You're only charged if you win, at your own bid.
        </p>
        <div className="flex flex-col gap-2">
          <Button autoFocus disabled={pending} onClick={() => onRaise(amount)}>
            {pending ? '…' : raiseSheetConfirm(amount)}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {raiseSheetKeep(currentCents)}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
