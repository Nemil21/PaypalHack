import { PRICE_WATCH_PAUSED_COPY, PRICE_WATCH_PAUSED_DETAIL } from '@holdfast/shared';
import { cn } from '../lib/cn';

/**
 * HF-042b: Channel3 is unreachable, so the price watch is paused on this listing
 * (`listings.price_watch_paused_at`). Shown on the console (W06) and the offer page (W12 / M01);
 * it clears on its own when Channel3 answers again.
 */
export function PriceWatchPausedBanner({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-1 rounded-md border border-orange/30 bg-orange-tint px-4 py-3',
        className,
      )}
    >
      <p className="text-[14px] font-medium text-ink">{PRICE_WATCH_PAUSED_COPY}</p>
      <p className="text-[13px] text-body">{PRICE_WATCH_PAUSED_DETAIL}</p>
    </div>
  );
}
