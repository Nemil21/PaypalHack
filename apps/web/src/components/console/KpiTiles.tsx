import { formatUsd } from '@holdfast/shared';
import { cn } from '../../lib/cn';
import { formatUsdCompact, simulatedNote, type ConsoleKpis } from '../../lib/console/kpis';
import { MoneySkeleton } from '../ui';

/**
 * Console KPI tiles (HF-023) and the store that feeds them. No AG imports here: the AG Studio
 * row (`ag/ConsoleKpiStudio`) is lazy, and the same tiles render as its loading fallback.
 */

export type KpiKind = 'held' | 'bids' | 'projected' | 'recovery' | 'released';

/** Live values for the widgets; `null` while the book loads (tiles show skeletons). */
export interface KpiStore {
  get(): ConsoleKpis | null;
  set(k: ConsoleKpis | null): void;
  subscribe(fn: () => void): () => void;
}

export function createKpiStore(): KpiStore {
  let value: ConsoleKpis | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(k) {
      value = k;
      subs.forEach((fn) => fn());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

interface TileContent {
  label: string;
  value: string;
  caption?: string;
  /** Native hover text (the "incl. $X simulated" note). */
  hover?: string;
  emphasis?: boolean;
}

/** What each tile shows for a set of KPI values (exported for tests and the fallback row). */
export function kpiTile(kind: KpiKind, k: ConsoleKpis): TileContent {
  switch (kind) {
    case 'held': {
      const note = simulatedNote(k) ?? undefined;
      return {
        label: 'Held demand',
        value: formatUsdCompact(k.heldCents),
        caption: note ?? 'Held, not charged',
        hover: note ? `${formatUsd(k.heldCents)} held · ${note}` : undefined,
        emphasis: true,
      };
    }
    case 'bids':
      return {
        label: 'Live bids',
        value: k.liveBids.toLocaleString('en-US'),
        caption: 'Each one a PayPal hold',
      };
    case 'projected':
      return {
        label: 'Projected cutoff',
        value: k.cutoffCents === null ? '—' : formatUsd(k.cutoffCents),
        caption:
          k.winners === 0
            ? `At ${units(k.quantity)}: no bids at or above the floor yet`
            : `At ${units(k.quantity)}: ${formatUsdCompact(k.grossCents)} gross from ${k.winners.toLocaleString('en-US')} winners`,
      };
    case 'recovery':
      return {
        label: 'Vs liquidation',
        value: k.recoveryMultiple === null ? '—' : `×${k.recoveryMultiple.toFixed(1)}`,
        caption: !k.hasLiquidationQuote
          ? 'No liquidation quote'
          : k.recoveryMultiple === null
            ? 'Shown once bids clear the floor'
            : 'Gross ÷ liquidation value',
      };
    case 'released':
      return {
        label: 'Price watch',
        value: k.releasedByPriceWatch.toLocaleString('en-US'),
        caption: 'Holds released on a public price drop',
      };
  }
}

function units(q: number): string {
  return `${q.toLocaleString('en-US')} ${q === 1 ? 'unit' : 'units'}`;
}

export const KPI_LABEL: Record<KpiKind, string> = {
  held: 'Held demand',
  bids: 'Live bids',
  projected: 'Projected cutoff',
  recovery: 'Vs liquidation',
  released: 'Price watch',
};

/** One v3 KPI tile: mono label, large tabular value, caption. Skeleton while loading. */
export function KpiTile({ kind, kpis }: { kind: KpiKind; kpis: ConsoleKpis | null }) {
  const t = kpis ? kpiTile(kind, kpis) : null;
  return (
    <div
      className="flex h-full min-w-0 flex-col gap-2 bg-white p-4"
      title={t?.hover}
      data-kpi={kind}
    >
      <span className="label truncate text-[11px] text-muted">{t?.label ?? KPI_LABEL[kind]}</span>
      {t ? (
        <span
          className={cn(
            'truncate text-[26px] leading-[32px] font-medium tracking-headline tabular-nums',
            t.emphasis ? 'text-orange' : 'text-ink',
          )}
        >
          {t.value}
        </span>
      ) : (
        <MoneySkeleton />
      )}
      {t?.caption && (
        <span className="line-clamp-2 text-[13px] leading-[18px] text-body">{t.caption}</span>
      )}
    </div>
  );
}
