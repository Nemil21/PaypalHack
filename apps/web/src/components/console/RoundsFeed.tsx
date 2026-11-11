import {
  endedCopy,
  extensionCopy,
  feedRows,
  raiseCopy,
  roundSummaryCopy,
  type RoundsFeed as Feed,
} from '../../lib/console/rounds-feed';
import { SimChip } from '../ui';

/**
 * W06 raises feed (HF-037b; features/19 §Screens): one summary line per round (nudged, raised,
 * expected gross Δ), then raises, late-raise extensions and the end, newest first. A raise reads
 * "New $241 hold placed · $219 hold released": PayPal has no in-place increase.
 */

const time = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(Date.parse(iso));

export function RoundsFeed({ feed }: { feed: Feed }) {
  const rows = feedRows(feed);
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4" data-testid="rounds-feed">
      {feed.rounds.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="round-summaries">
          {feed.rounds.map((r) => (
            <li
              key={r.round}
              className="font-mono text-[13px] text-body tabular-nums"
              data-testid={`round-summary-${r.round}`}
            >
              {roundSummaryCopy(r)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="label text-[11px] text-muted">Raises</h3>
        <span className="text-[12px] text-muted">Newest first</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[14px] text-body" data-testid="raises-feed-empty">
          No raises yet. Bidders below the cutoff hear the real number each round.
        </p>
      ) : (
        <ol
          className="flex max-h-72 flex-col divide-y divide-line overflow-y-auto"
          aria-live="polite"
          aria-label="Raises feed"
          data-testid="raises-feed"
        >
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-[14px]"
              data-testid={`feed-${row.kind}`}
            >
              <span className="w-20 shrink-0 font-mono text-[12px] text-muted tabular-nums">
                {time(row.at)}
              </span>
              {row.kind === 'raise' && (
                <>
                  <span className="flex items-center gap-2 text-ink">
                    {row.raise.shopperLabel}
                    {row.raise.isSimulated && <SimChip />}
                  </span>
                  <span className="text-body">{raiseCopy(row.raise)}</span>
                </>
              )}
              {row.kind === 'extended' && (
                <span className="text-ink">
                  Round {row.extension.round} extended {extensionCopy(row.extension)}
                </span>
              )}
              {row.kind === 'ended' && <span className="text-ink">{endedCopy(row.ended)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
