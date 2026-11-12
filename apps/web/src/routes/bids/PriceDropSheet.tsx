import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AFFILIATE_DISCLOSURE, BANK_PENDING_NOTE, formatUsd } from '@holdfast/shared';
import { Badge, Button } from '../../components/ui';
import { bidLowerLabel, offerHref, type PriceDrop } from '../../lib/bids';
import { ActionLink } from './ErrorState';

/**
 * M06 price-drop sheet (HF-020; features/06 §Logic 6): old vs new price, the "Hold released"
 * badge ("Releasing" until VOIDED), "Buy at <store> $219" (Channel3 affiliate link, with the
 * disclosure) and "Bid lower". A bottom sheet on phones, a centred dialog on wider screens.
 */
export function PriceDropSheet({
  drop,
  offerSlug,
  brandName = null,
  onClose,
}: {
  drop: PriceDrop;
  offerSlug: string | null;
  /** v4 (frame 119:603): "Bid lower in <Brand>'s book". */
  brandName?: string | null;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const store = drop.merchant ?? 'another store';
  const lower = offerHref(offerSlug, drop.newCents != null ? drop.newCents - 1000 : null);

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
        aria-labelledby="m06-title"
        className="relative flex w-full max-w-[440px] flex-col gap-5 rounded-t-md bg-white p-5 pb-8 shadow-card sm:rounded-md sm:pb-6"
      >
        <span aria-hidden className="mx-auto h-1 w-10 rounded-full bg-line sm:hidden" />
        <div className="flex items-center justify-between gap-3">
          <h2 id="m06-title" className="text-[20px] font-medium tracking-headline text-ink">
            The price dropped
          </h2>
          <Badge tone={drop.released ? 'success' : 'neutral'}>
            {drop.released ? 'Hold released' : 'Releasing'}
          </Badge>
        </div>
        {drop.replayed && (
          <Badge tone="sim" className="self-start">
            Replayed event (demo)
          </Badge>
        )}
        <dl className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 rounded-md bg-surface p-3">
            <dt className="label text-[11px] text-muted">Your bid</dt>
            <dd className="text-[24px] text-body tabular-nums line-through">
              {formatUsd(drop.oldCents)}
            </dd>
          </div>
          <div className="flex flex-col gap-1 rounded-md bg-orange-tint p-3">
            <dt className="label text-[11px] text-muted">{store}</dt>
            <dd className="text-[24px] text-ink tabular-nums">
              {drop.newCents != null ? formatUsd(drop.newCents) : 'Lower'}
            </dd>
          </div>
        </dl>
        <p className="text-[14px] text-body">
          {drop.released
            ? `We released your ${formatUsd(drop.oldCents)} hold. ${BANK_PENDING_NOTE}`
            : `We're releasing your ${formatUsd(drop.oldCents)} hold.`}
        </p>
        <div className="flex flex-col gap-2">
          {drop.url && (
            <ActionLink
              variant="primary"
              link={{
                label:
                  drop.newCents != null
                    ? `Buy at ${store} ${formatUsd(drop.newCents)}`
                    : `Buy at ${store}`,
                href: drop.url,
                external: true,
              }}
            />
          )}
          {lower && (
            <ActionLink variant="outline" link={{ label: bidLowerLabel(brandName), href: lower }} />
          )}
          <Button autoFocus variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {drop.url && <p className="text-[12px] text-muted">{AFFILIATE_DISCLOSURE}</p>}
      </div>
    </div>,
    document.body,
  );
}
