import { Link } from 'react-router';
import { BANK_PENDING_NOTE, formatUsd } from '@holdfast/shared';
import { ButtonLink } from '../../components/ui';
import { timeLeftText, type BidDetail } from '../../lib/bids';
import { cn } from '../../lib/cn';
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

  const left = timeLeftText(bid, Date.now());

  return (
    <section
      aria-labelledby="w13-title"
      className="flex min-h-[calc(100dvh-4rem)] flex-col gap-6 py-6 sm:min-h-0 lg:py-10"
    >
      <div className="flex flex-col items-start gap-4">
        <span
          aria-hidden
          className="flex h-14 w-14 animate-pop items-center justify-center rounded-full bg-success/15 text-success sm:h-16 sm:w-16"
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
          className="text-[32px] leading-[1.05] font-medium tracking-headline text-ink sm:text-[44px]"
        >
          <span className="sr-only">✓ </span>
          {amount} held, not charged.
        </h1>
        <p className="text-[16px] text-body sm:text-[18px]">
          {bid.listing.title ?? 'Your bid'}
          {left ? ` · ${left.charAt(0).toLowerCase()}${left.slice(1)}` : ''}
        </p>
      </div>

      <div className="flex flex-col gap-4 rounded-sm border border-line bg-white p-5 sm:p-6">
        <h2 className="label text-[11px] text-muted">What happens next</h2>
        <ol className="flex flex-col">
          <Step
            current
            title="Your hold sits on PayPal"
            body="Nothing is charged while the window is open. You can cancel any time before the brand clears."
            when="now"
          />
          <Step
            title={`${bid.listing.brandName ?? 'The brand'} clears the window`}
            body={closes ? `The window closes ${formatWhen(closes)}.` : 'The window closes soon.'}
          />
          <Step
            last
            title={`You win and pay ${amount}, or it’s released`}
            body={`Never more than your bid. If you don’t win, we release your hold. ${BANK_PENDING_NOTE}`}
          />
        </ol>
      </div>

      <div className="flex flex-col divide-y divide-line rounded-sm border border-line bg-white px-5 sm:px-6">
        <ReleaseToggle bid={bid} onChanged={onChanged} bare className="py-5" />
        <Link to={mandateHref} className="group flex items-center justify-between gap-4 py-5">
          <span className="flex flex-col gap-1">
            <span className="text-[15px] font-medium text-ink">Let my agent manage this</span>
            <span className="text-[13px] text-body">
              Creates a mandate prefilled with this product and {amount}
            </span>
          </span>
          <span className="label shrink-0 text-[12px] text-ink group-hover:text-orange">
            Set up <span aria-hidden>→</span>
          </span>
        </Link>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink to="/bids" size="lg" className="sm:w-auto">
          View my bids
        </ButtonLink>
        <ButtonLink to="/" variant="outline" size="lg" className="sm:w-auto">
          Bid on something else
        </ButtonLink>
      </div>
    </section>
  );
}

function Step({
  title,
  body,
  when,
  current = false,
  last = false,
}: {
  title: string;
  body: string;
  when?: string;
  current?: boolean;
  last?: boolean;
}) {
  return (
    <li className={cn('relative flex gap-4', !last && 'pb-5')}>
      {!last && <span aria-hidden className="absolute top-3 left-[5px] h-full w-0.5 bg-line" />}
      <span
        aria-hidden
        className={cn(
          'relative mt-1.5 h-3 w-3 shrink-0 rounded-full border-2',
          current ? 'border-orange bg-orange' : 'border-line bg-white',
        )}
      />
      <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className={cn('text-[15px]', current ? 'text-ink' : 'text-body')}>{title}</p>
          <p className="text-[13px] text-body">{body}</p>
        </div>
        <span className="shrink-0 font-mono text-[12px] text-muted">{when ?? '–'}</span>
      </div>
    </li>
  );
}
