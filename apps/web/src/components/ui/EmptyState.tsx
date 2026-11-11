import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Empty state (screens.md): a short sentence and one action. */
export function EmptyState({
  message,
  action,
  className,
}: {
  message: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-4 rounded-md border border-dashed border-planned bg-surface p-6',
        className,
      )}
    >
      <p className="text-[15px] text-body">{message}</p>
      {action}
    </div>
  );
}
