import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { MoneySkeleton } from './Skeleton';

/**
 * KPI tile: mono label, large value, optional caption. `value === undefined` renders a skeleton
 * (loading); pass a formatted string, never a raw number, so money always goes through formatUsd.
 */
export function StatTile({
  label,
  value,
  caption,
  emphasis,
  className,
}: {
  label: string;
  value: string | undefined;
  caption?: ReactNode;
  /** Orange value, for the one number the screen is about. */
  emphasis?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-md border border-line bg-white p-4',
        className,
      )}
    >
      <span className="label text-[11px] text-muted">{label}</span>
      {value === undefined ? (
        <MoneySkeleton />
      ) : (
        <span
          className={cn(
            'truncate text-[28px] leading-[34px] font-medium tracking-headline tabular-nums sm:text-[34px]',
            emphasis ? 'text-orange' : 'text-ink',
          )}
        >
          {value}
        </span>
      )}
      {caption && <span className="text-[13px] text-body">{caption}</span>}
    </div>
  );
}
