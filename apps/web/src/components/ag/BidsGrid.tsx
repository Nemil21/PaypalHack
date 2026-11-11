import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  IRowNode,
  ValueFormatterParams,
  ValueGetterParams,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { formatUsd, type BidSource, type BookResponse } from '@holdfast/shared';
import { gridTheme, registerAg } from '../../lib/ag';
import { cn } from '../../lib/cn';
import {
  amountLabel,
  compareRank,
  heldBySource,
  rankLabel,
  sourceLabel,
  statusLabel,
  type BidRow,
  type BidRowTracker,
  type SourceSummary,
} from '../../lib/console/bids-grid';
import { formatUsdCompact } from '../../lib/console/kpis';
import { bidWouldWin, type SliderStore } from '../../lib/console/slider-store';
import { color } from '../../lib/tokens';
import { Badge, SimChip } from '../ui';

const { gridEnterprise } = registerAg();

/**
 * The console bids grid (HF-025, features/08 §Layout 5, screens.md W06): every anonymized live
 * bid, sortable and filterable, on the v3 grid theme.
 *
 * Live: the console passes each book snapshot; the row tracker (`lib/console/bids-grid.ts`) turns
 * it into add / update / remove deltas applied with `applyTransactionAsync` (`getRowId` = the
 * row's bid id), so new rows flash in, voided ones drop out and a raise updates its row in place
 * ("$219 → $241" with a cell flash). "Would win?" reads the HF-024 slider store and repaints that
 * one column per drag frame.
 *
 * Enterprise features (row grouping by source with a held-$ group aggregate, set filters, the
 * side-bar tool panels) turn on only when `registerAg()` found a valid AG Grid Enterprise key;
 * otherwise the grid runs on Community, so it never shows a watermark. The source strip above the
 * grid (held $ per source, click to filter) works in both.
 */

interface GridContext {
  slider: SliderStore;
}

const setFilter = gridEnterprise ? 'agSetColumnFilter' : 'agTextColumnFilter';

const theme = gridTheme.withParams({
  valueChangeValueHighlightBackgroundColor: color.orangeTint,
  rangeSelectionHighlightColor: color.orangeTint,
});

const wouldWinOf = (p: ValueGetterParams<BidRow>): string | undefined =>
  p.data
    ? bidWouldWin((p.context as GridContext).slider.get(), p.data.bidId)
      ? 'Yes'
      : 'No'
    : undefined;

const placedFormat = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const placedDayFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatPlaced(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? placedFormat.format(d)
    : placedDayFormat.format(d);
}

function BidCell({ data, node, value }: ICellRendererParams<BidRow, number>) {
  // Group rows (Enterprise grouping): the held-$ aggregate of the group.
  if (!data) {
    return node.group && typeof value === 'number' ? (
      <span className="tabular-nums">{formatUsd(value)} held</span>
    ) : null;
  }
  if (data.raisedFromCents === null) {
    return <span className="tabular-nums">{formatUsd(data.amountCents)}</span>;
  }
  return (
    <span className="tabular-nums" title={amountLabel(data)} data-testid="raise-flash">
      <span className="text-muted line-through">{formatUsd(data.raisedFromCents)}</span>
      <span className="text-orange"> → {formatUsd(data.amountCents)}</span>
    </span>
  );
}

function RankCell({ data }: ICellRendererParams<BidRow>) {
  if (!data) return null;
  return data.rank !== null ? (
    <span className="tabular-nums">{data.rank}</span>
  ) : (
    <span className="text-muted">{rankLabel(data)}</span>
  );
}

function ShopperCell({ data }: ICellRendererParams<BidRow>) {
  if (!data) return null;
  return (
    <span className="flex items-center gap-2">
      <span className="truncate">{data.shopperLabel}</span>
      {data.isSimulated && <SimChip />}
    </span>
  );
}

function WouldWinCell({ value }: ICellRendererParams<BidRow, string>) {
  if (value === 'Yes') return <Badge tone="held">Wins</Badge>;
  if (value === 'No') return <span className="text-muted">No</span>;
  return null;
}

function StatusCell({ data }: ICellRendererParams<BidRow>) {
  if (!data) return null;
  return (
    <Badge tone={data.status === 'held' ? 'held' : 'neutral'}>{statusLabel(data.status)}</Badge>
  );
}

const columns: ColDef<BidRow>[] = [
  {
    colId: 'rank',
    headerName: 'Rank',
    valueGetter: (p) => p.data?.rank ?? null,
    cellRenderer: RankCell,
    comparator: (_a, _b, na, nb) => (na.data && nb.data ? compareRank(na.data, nb.data) : 0),
    sort: 'asc',
    filter: 'agNumberColumnFilter',
    maxWidth: 120,
    minWidth: 90,
  },
  {
    colId: 'bid',
    field: 'amountCents',
    headerName: 'Bid',
    cellRenderer: BidCell,
    enableCellChangeFlash: true,
    aggFunc: gridEnterprise ? 'sum' : undefined,
    // Filter in dollars, not cents.
    filter: 'agNumberColumnFilter',
    filterValueGetter: (p) => (p.data ? p.data.amountCents / 100 : null),
    getQuickFilterText: (p) => (p.data ? formatUsd(p.data.amountCents) : ''),
    minWidth: 140,
  },
  {
    colId: 'placed',
    field: 'placedAtMs',
    headerName: 'Placed',
    valueFormatter: (p: ValueFormatterParams<BidRow, number>) =>
      typeof p.value === 'number' ? formatPlaced(p.value) : '',
    filter: false,
    minWidth: 110,
  },
  {
    colId: 'source',
    headerName: 'Source',
    valueGetter: (p) => (p.data ? sourceLabel(p.data.source) : undefined),
    enableRowGroup: gridEnterprise,
    filter: setFilter,
    minWidth: 100,
  },
  {
    colId: 'shopper',
    field: 'shopperLabel',
    headerName: 'Shopper',
    cellRenderer: ShopperCell,
    filter: 'agTextColumnFilter',
    flex: 1.6,
    minWidth: 160,
  },
  {
    colId: 'status',
    headerName: 'Status',
    valueGetter: (p) => (p.data ? statusLabel(p.data.status) : undefined),
    cellRenderer: StatusCell,
    filter: setFilter,
    minWidth: 100,
  },
  {
    colId: 'wouldWin',
    headerName: 'Would win?',
    valueGetter: wouldWinOf,
    cellRenderer: WouldWinCell,
    filter: setFilter,
    minWidth: 110,
  },
];

const enterpriseProps = gridEnterprise
  ? {
      rowGroupPanelShow: 'onlyWhenGrouping' as const,
      groupDefaultExpanded: -1,
      suppressAggFuncInHeader: true,
      autoGroupColumnDef: { headerName: 'Source', minWidth: 150 },
      sideBar: { toolPanels: ['columns', 'filters'] },
    }
  : {};

const getRowId = (p: GetRowIdParams<BidRow>) => p.data.rowId;

/** Rows arrive only through transactions; an empty start also keeps the loading overlay off. */
const NO_ROWS: BidRow[] = [];

export interface BidsGridProps {
  book: BookResponse;
  tracker: BidRowTracker;
  slider: SliderStore;
}

export default function BidsGrid({ book, tracker, slider }: BidsGridProps) {
  const [api, setApi] = useState<GridApi<BidRow> | null>(null);
  const [summary, setSummary] = useState<SourceSummary[]>([]);
  const [sourceFilter, setSourceFilter] = useState<BidSource | null | undefined>(undefined);
  const [grouped, setGrouped] = useState(false);
  const sourceFilterRef = useRef(sourceFilter);
  sourceFilterRef.current = sourceFilter;
  const applied = useRef(false);
  const context = useMemo<GridContext>(() => ({ slider }), [slider]);

  const onGridReady = useCallback(
    (e: GridReadyEvent<BidRow>) => {
      // A fresh grid holds no rows: the next snapshot is added in full.
      tracker.reset();
      applied.current = false;
      setApi(e.api);
    },
    [tracker],
  );

  // Each book snapshot → one async transaction. New rows and raised rows flash.
  useEffect(() => {
    if (!api || api.isDestroyed()) return;
    const delta = tracker.apply(book, Date.now());
    const initial = !applied.current;
    applied.current = true;
    setSummary(heldBySource(tracker.rows()));
    if (!delta.add.length && !delta.update.length && !delta.remove.length) return;
    const raised = new Set(delta.raised);
    api.applyTransactionAsync(
      { add: delta.add, update: delta.update, remove: delta.remove },
      (res) => {
        if (initial || api.isDestroyed()) return;
        const flash: IRowNode<BidRow>[] = [
          ...res.add,
          ...res.update.filter((n) => n.id !== undefined && raised.has(n.id)),
        ];
        if (!flash.length) return;
        // The callback runs before new rows have rendered cells; flash once they have.
        requestAnimationFrame(() => {
          if (!api.isDestroyed()) api.flashCells({ rowNodes: flash, flashDuration: 1200 });
        });
      },
    );
  }, [api, book, tracker]);

  // Raise flashes end after a few seconds: clear "$219 →" from those rows.
  useEffect(() => {
    if (!api) return;
    const at = tracker.nextRaiseExpiry();
    if (at === null) return;
    const id = setTimeout(
      () => {
        const done = tracker.expireRaises(Date.now());
        if (!done.length || api.isDestroyed()) return;
        // The amount is unchanged, so the grid would keep the cell: repaint it without the arrow.
        api.applyTransactionAsync({ update: done }, (res) => {
          if (!api.isDestroyed()) {
            api.refreshCells({ rowNodes: res.update, columns: ['bid'], force: true });
          }
        });
      },
      Math.max(0, at - Date.now()) + 20,
    );
    return () => clearTimeout(id);
  }, [api, book, tracker]);

  // "Would win?" follows the slider: repaint that column once per frame while dragging.
  useEffect(() => {
    if (!api) return;
    let frame = 0;
    const unsubscribe = slider.subscribe(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (api.isDestroyed()) return;
        api.refreshCells({ columns: ['wouldWin'] });
        if (api.getColumnFilterModel('wouldWin')) api.onFilterChanged();
      });
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [api, slider]);

  useEffect(() => {
    if (api && !api.isDestroyed()) api.onFilterChanged();
  }, [api, sourceFilter]);

  const toggleGrouping = () => {
    if (!api) return;
    const next = !grouped;
    api.applyColumnState({ state: [{ colId: 'source', rowGroup: next, hide: next }] });
    setGrouped(next);
  };

  const total = summary.reduce((s, x) => s + x.count, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" aria-label="Bids by source">
        <SourceChip
          active={sourceFilter === undefined}
          onClick={() => setSourceFilter(undefined)}
          label="All"
          detail={`${total.toLocaleString('en-US')}`}
        />
        {summary.map((s) => (
          <SourceChip
            key={s.label}
            active={sourceFilter === s.source}
            onClick={() => setSourceFilter(sourceFilter === s.source ? undefined : s.source)}
            label={s.label}
            detail={`${s.count.toLocaleString('en-US')} · ${formatUsdCompact(s.heldCents)} held`}
          />
        ))}
        {gridEnterprise && (
          <button
            type="button"
            onClick={toggleGrouping}
            aria-pressed={grouped}
            className={cn(
              'ml-auto rounded-sm border px-3 py-1 text-[12px]',
              grouped ? 'border-charcoal bg-charcoal text-white' : 'border-border text-body',
            )}
          >
            Group by source
          </button>
        )}
      </div>
      <div className="h-[480px] w-full" data-testid="bids-grid">
        <AgGridReact<BidRow>
          theme={theme}
          columnDefs={columns}
          rowData={NO_ROWS}
          defaultColDef={{ flex: 1, minWidth: 80, sortable: true, resizable: true, filter: true }}
          getRowId={getRowId}
          context={context}
          onGridReady={onGridReady}
          animateRows
          asyncTransactionWaitMillis={50}
          isExternalFilterPresent={() => sourceFilterRef.current !== undefined}
          doesExternalFilterPass={(node) => node.data?.source === sourceFilterRef.current}
          {...enterpriseProps}
        />
      </div>
    </div>
  );
}

function SourceChip({
  active,
  onClick,
  label,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-baseline gap-2 rounded-sm border px-3 py-1 text-[12px]',
        active ? 'border-orange bg-orange-tint text-ink' : 'border-line text-body hover:bg-surface',
      )}
    >
      <span className="label text-[11px]">{label}</span>
      <span className="tabular-nums text-muted">{detail}</span>
    </button>
  );
}
