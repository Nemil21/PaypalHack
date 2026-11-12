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
  dark,
  className,
}: {
  label: string;
  value: string | undefined;
  caption?: ReactNode;
  /** Orange value, for the one number the screen is about. */
  emphasis?: boolean;
  /** Ink tile with white text (v4 overview's headline KPI). */
  dark?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-md border p-4',
        dark ? 'border-ink bg-ink' : 'border-line bg-white',
        className,
      )}
    >
      <span className={cn('label text-[11px]', dark ? 'text-white/70' : 'text-muted')}>
        {label}
      </span>
      {value === undefined ? (
        <MoneySkeleton />
      ) : (
        <span
          className={cn(
            'truncate text-[28px] leading-[34px] font-medium tracking-headline tabular-nums sm:text-[34px]',
            dark ? 'text-white' : emphasis ? 'text-orange' : 'text-ink',
          )}
        >
          {value}
        </span>
      )}
      {caption && (
        <span className={cn('text-[13px]', dark ? 'text-white/70' : 'text-body')}>{caption}</span>
      )}
    </div>
  );
}
