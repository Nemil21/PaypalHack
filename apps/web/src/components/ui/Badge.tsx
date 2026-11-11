import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Small uppercase status pill, as "HELD · NOT CHARGED" on the v3 held card. */
export type BadgeTone = 'held' | 'neutral' | 'dark' | 'success' | 'danger' | 'sim';

const tones: Record<BadgeTone, string> = {
  held: 'bg-orange-tint text-orange',
  neutral: 'bg-surface text-body',
  dark: 'bg-charcoal text-white',
  success: 'bg-success/10 text-success',
  danger: 'bg-danger-tint text-danger',
  sim: 'bg-line text-muted',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'label inline-flex items-center rounded-sm px-2 py-1 text-[11px] leading-none whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Grey "SIM" chip on simulated bidders (feature 17): never mistaken for a real shopper. `noHold`:
 * a seed fallback with no PayPal hold ("SIM · no hold", HF-045), which never reaches Clear (D8).
 */
export function SimChip({ noHold = false }: { noHold?: boolean } = {}) {
  return noHold ? (
    <Badge tone="sim" title="Simulated bidder with no PayPal hold (seed fallback); never cleared">
      SIM · no hold
    </Badge>
  ) : (
    <Badge tone="sim" title="Simulated bidder with a real sandbox hold (demo seed)">
      SIM
    </Badge>
  );
}
