import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { SettlementView } from '@holdfast/shared';
import { settlementGantt } from '../../lib/settlement/gantt';
import { Skeleton } from '../ui';
import { useWide } from './OrderTimeline';

const BryntumGantt = lazy(() => import('./BryntumGantt'));

/** Running bars grow to "now"; a 2 s tick is smooth enough without re-laying out every frame. */
const TICK_MS = 2_000;
const ROW_PX = 34;

/**
 * W08 settlement fan-out on Bryntum Gantt (HF-060 part 1): every capture and release with its
 * real PayPal timing, the decline → promotion arrow and the payout milestone. Reads the same
 * `SettlementView` as the rest of W08, so it follows the SSE stream for free. `now` pins the clock
 * (fixture replay); the live screen ticks while the listing is CLEARING.
 */
export function SettlementGanttPanel({ view, now }: { view: SettlementView; now?: Date }) {
  const live = !now && view.listingStatus === 'CLEARING';
  // At 375 px the bidder column shrinks and the amount column goes, so the bars keep ~60 % of the
  // width (the log below still has every amount). The Gantt is rebuilt when this flips.
  const wide = useWide();
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [live]);

  const clock = now?.getTime() ?? (live ? tick : Date.now());
  const data = useMemo(
    () => settlementGantt(view, new Date(clock)),
    // A settled view does not need the clock: only recompute when it changes.
    [view, live || now ? clock : null],
  );
  if (data.tasks.length === 0) return null;

  // Header + group rows + bars + payout, capped so a big listing scrolls inside the Gantt.
  const rows = view.rows.length + data.tasks.length;
  const height = Math.min(680, Math.max(260, 96 + rows * ROW_PX));

  return (
    <section aria-label="Settlement timeline" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="label text-[11px] text-muted">Settlement timeline</h2>
        <p className="text-[13px] text-body">
          Each bar runs from the PayPal call to its answer. The arrow shows a declined unit going to
          the next bidder at their own bid.
        </p>
      </div>
      <div className="overflow-hidden rounded-md border border-line">
        <Suspense
          fallback={
            <div style={{ height }}>
              <Skeleton className="h-full w-full" />
            </div>
          }
        >
          <BryntumGantt
            key={wide ? 'wide' : 'narrow'}
            data={data}
            nameHeader="Bidder · step"
            nameWidth={wide ? 250 : 140}
            showAmount={wide}
            height={height}
            ariaLabel="Settlement timeline: captures, releases and the payout"
          />
        </Suspense>
      </div>
    </section>
  );
}
