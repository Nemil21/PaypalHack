import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui';
import { fixtureViewAt, settlementFixture } from '../../lib/settlement/fixture';
import { SettlementScreen } from './SettlementScreen';

const SPEEDS = [1, 2, 4] as const;

/**
 * `/dev/settlement` (HF-035): W08 on the recorded fixture event stream, no sign-in or database.
 * Plays the `settlement.updated` / `listing.status` / `payout.updated` frames on a timer.
 */
export function SettlementFixture() {
  const fx = useMemo(() => settlementFixture(), []);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const done = index >= fx.frames.length - 1;

  useEffect(() => {
    if (!playing || done) return;
    const next = fx.frames[index + 1]!;
    const id = setTimeout(() => setIndex((i) => i + 1), next.delayMs / speed);
    return () => clearTimeout(id);
  }, [playing, done, index, speed, fx]);

  const view = useMemo(() => fixtureViewAt(fx, index), [fx, index]);

  return (
    <SettlementScreen
      view={view}
      title="Aurel A7 (fixture stream)"
      toolbar={
        <div className="mt-6 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-4 py-2 text-[13px] text-body">
          <span className="label text-[11px] text-muted">Recorded stream</span>
          <span className="tabular-nums">
            frame {index + 1} / {fx.frames.length}
          </span>
          <Button variant="ghost" onClick={() => setPlaying((p) => !p)} disabled={done}>
            {playing && !done ? 'Pause' : 'Play'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setIndex(-1);
              setPlaying(true);
            }}
          >
            Restart
          </Button>
          <Button variant="ghost" onClick={() => setIndex(fx.frames.length - 1)}>
            Jump to end
          </Button>
          {SPEEDS.map((s) => (
            <Button
              key={s}
              variant={speed === s ? 'outline' : 'ghost'}
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
            >
              {s}×
            </Button>
          ))}
        </div>
      }
    />
  );
}
