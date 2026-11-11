import { Link } from 'react-router';
import { BANK_PENDING_NOTE, formatUsd } from '@holdfast/shared';
import { ButtonLink } from '../../components/ui';
import type { BidDetail } from '../../lib/bids';
import { formatWhen } from './format';
import { ReleaseToggle, type PatchedBid } from './ReleaseToggle';

/**
 * W13 / M02 hold confirmation (HF-020; features/03 §Logic 5). Shown on `/bids/:id?held=1`, where
 * the offer page and the PayPal return land after a hold:
 *   "✓ $229 held, not charged", what happens next, two opt-in cards ("Let my agent manage this"
 *   → the W17 mandate form (HF-017b); "Release my hold if it's cheaper elsewhere", on by default),
 *   and "View my bids". On phones it is a full-screen success with an animated check.
 * While PayPal is still confirming (PENDING_APPROVAL) it shows the approving state instead.
 */
export function HoldConfirmation({
  detail,
  onChanged,
}: {
  detail: BidDetail;
  onChanged(res: PatchedBid): void;
}) {
  const { bid } = detail;
  const amount = formatUsd(bid.amountCents);

  if (bid.status === 'PENDING_APPROVAL') {
    return (
      <section
        aria-live="polite"
        className="flex flex-col gap-3 rounded-md border border-line bg-white p-6 shadow-card"
      >
        <h1 className="text-[24px] font-medium tracking-headline text-ink">
          Waiting for PayPal to confirm your {amount} hold…
        </h1>
        <p className="text-[15px] text-body">Nothing is held yet. This page updates by itself.</p>
      </section>
    );
  }

  const closes =
    bid.listing.status === 'ROUNDS'
      ? (bid.listing.roundsEndAt ?? bid.listing.windowClosesAt)
      : bid.listing.windowClosesAt;
  // HF-017b mandate form, prefilled with this product and the bid as the max price.
  const mandateHref = `/mandates/new?productId=${encodeURIComponent(bid.listing.productId)}&maxPriceCents=${bid.amountCents}`;

  return (
    <section
      aria-labelledby="w13-title"
      className="flex min-h-[calc(100dvh-4rem)] flex-col gap-8 py-6 sm:min-h-0 sm:rounded-md sm:border sm:border-line sm:bg-white sm:p-8 sm:shadow-card"
    >
      <div className="flex flex-col items-start gap-4">
        <span
          aria-hidden
          className="flex h-14 w-14 animate-pop items-center justify-center rounded-full bg-success text-white"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          >
            <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h1
          id="w13-title"
          className="text-[32px] leading-[1.05] font-medium tracking-headline text-ink sm:text-[40px]"
        >
          <span className="sr-only">✓ </span>
          {amount} held, not charged
        </h1>
        <p className="text-[15px] text-body">
          {bid.listing.title ?? 'Your bid'} · PayPal is holding exactly {amount}.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="label text-[12px] text-muted">What happens next</h2>
        <ol className="flex flex-col gap-4 border-l border-line pl-5">
          <li className="relative">
            <Dot />
            <p className="text-[15px] text-ink">Your {amount} stays held, not charged.</p>
            <p className="text-[13px] text-body">
              You can cancel any time before the brand clears.
            </p>
          </li>
          <li className="relative">
            <Dot />
            <p className="text-[15px] text-ink">
              {closes ? `The window closes ${formatWhen(closes)}.` : 'The window closes soon.'}
            </p>
            <p className="text-[13px] text-body">The brand then picks winners by price.</p>
          </li>
          <li className="relative">
            <Dot />
            <p className="text-[15px] text-ink">
              If you win, you're charged your bid of {amount}, exactly.
            </p>
            <p className="text-[13px] text-body">
              If you don't, we release your hold. {BANK_PENDING_NOTE}
            </p>
          </li>
        </ol>
      </div>

      <div className="flex flex-col gap-3">
        <Link
          to={mandateHref}
          className="flex flex-col gap-1 rounded-md border border-line bg-white p-4 hover:bg-surface"
        >
          <span className="text-[15px] font-medium text-ink">Let my agent manage this →</span>
          <span className="text-[13px] text-body">
            Set a limit once; your agent can raise or re-bid within it.
          </span>
        </Link>
        <ReleaseToggle bid={bid} onChanged={onChanged} />
      </div>

      <ButtonLink to="/bids" variant="secondary" size="lg" block>
        View my bids
      </ButtonLink>
    </section>
  );
}

function Dot() {
  return (
    <span aria-hidden className="absolute top-1.5 -left-[25px] h-2 w-2 rounded-full bg-orange" />
  );
}
