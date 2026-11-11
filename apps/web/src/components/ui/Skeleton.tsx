import { cn } from '../../lib/cn';

/**
 * Loading placeholder (screens.md: skeletons, never spinners on money numbers). Size it like the
 * content it stands in for so the layout doesn't jump when data arrives.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block animate-shimmer rounded-sm bg-line', className)} />;
}

/** Placeholder for a money amount at a given text size. */
export function MoneySkeleton({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  return <Skeleton className={size === 'lg' ? 'h-[34px] w-28' : 'h-[18px] w-16'} />;
}
