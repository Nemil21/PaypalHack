import { cn } from '../../lib/cn';
import { Button } from './Button';

/** Inline error with retry (screens.md shared state). Sits where the failed content would be. */
export function ErrorBanner({
  message,
  onRetry,
  retrying,
  className,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col gap-3 rounded-md border border-danger/30 bg-danger-tint p-4 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <p className="text-[14px] text-ink">{message}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </div>
  );
}
