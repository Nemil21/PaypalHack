import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  ColDef,
  GetRowIdParams,
  ICellRendererParams,
  IRowNode,
  RowClassParams,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { formatUsd } from '@holdfast/shared';
import { gridTheme, registerAg } from '../../lib/ag';
import {
  matchesFilter,
  type LogFilter,
  type LogKind,
  type LogRow,
} from '../../lib/settlement/model';
import { Badge, SimChip, type BadgeTone } from '../ui';

registerAg();

const TONE: Record<LogKind, BadgeTone> = {
  charged: 'success',
  'charged-pending': 'success',
  capturing: 'held',
  'capture-failed': 'danger',
  released: 'neutral',
  releasing: 'neutral',
  reserve: 'neutral',
  'release-failed': 'danger',
  'promoted-out': 'held',
};

function BidderCell({ data }: ICellRendererParams<LogRow>) {
  if (!data) return null;
  return (
    <span className="flex items-center gap-2">
      {data.shopperLabel}
      {data.isSimulated && <SimChip />}
    </span>
  );
}

function ActionCell({ data }: ICellRendererParams<LogRow>) {
  if (!data) return null;
  return <Badge tone={TONE[data.kind]}>{data.action}</Badge>;
}

function NoteCell({ data }: ICellRendererParams<LogRow>) {
  if (!data?.note) return null;
  return <span className="text-[13px] text-ink">{data.note}</span>;
}

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'Queued';

/**
 * W08 live log (HF-035) on AG Grid with the v3 grid theme shared with the bids grid (HF-025).
 * Rows keep their identity by settlement id, so a re-read updates cells in place. Promotion rows
 * are tinted; clicking any row opens the bid drawer.
 */
export default function SettlementLogGrid({
  rows,
  filter,
  search,
  onOpen,
}: {
  rows: LogRow[];
  filter: LogFilter;
  search: string;
  onOpen(row: LogRow): void;
}) {
  const grid = useRef<AgGridReact<LogRow>>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    grid.current?.api?.onFilterChanged();
  }, [filter]);

  const columns = useMemo<ColDef<LogRow>[]>(
    () => [
      {
        field: 'at',
        headerName: 'Time',
        valueFormatter: (p) => time(p.value ?? null),
        width: 120,
        flex: 0,
        cellClass: 'tabular-nums font-mono text-[12px]',
        sortable: false,
      },
      { field: 'shopperLabel', headerName: 'Bidder', cellRenderer: BidderCell, minWidth: 160 },
      { field: 'action', headerName: 'Action', cellRenderer: ActionCell, minWidth: 170 },
      {
        field: 'amountCents',
        headerName: 'Amount',
        valueFormatter: (p) => (typeof p.value === 'number' ? formatUsd(p.value) : ''),
        type: 'rightAligned',
        cellClass: 'tabular-nums',
        width: 110,
        flex: 0,
      },
      {
        field: 'paypalId',
        headerName: 'PayPal ID',
        valueFormatter: (p) => p.value ?? '–',
        cellClass: 'font-mono text-[12px]',
        minWidth: 170,
      },
      { field: 'note', headerName: 'Note', cellRenderer: NoteCell, minWidth: 300, flex: 2 },
    ],
    [],
  );

  const getRowId = useCallback((p: GetRowIdParams<LogRow>) => p.data.settlementId, []);
  const rowClassRules = useMemo(
    () => ({
      'hf-row-promotion': (p: RowClassParams<LogRow>) => !!p.data?.highlight,
    }),
    [],
  );

  return (
    <div className="h-[460px] w-full" data-testid="settlement-log">
      <AgGridReact<LogRow>
        ref={grid}
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ flex: 1, minWidth: 100, sortable: true, resizable: true }}
        getRowId={getRowId}
        rowClassRules={rowClassRules}
        quickFilterText={search}
        isExternalFilterPresent={() => filterRef.current !== 'all'}
        doesExternalFilterPass={(node: IRowNode<LogRow>) =>
          !!node.data && matchesFilter(node.data, filterRef.current)
        }
        onRowClicked={(e) => e.data && onOpen(e.data)}
        rowStyle={{ cursor: 'pointer' }}
        overlayNoRowsTemplate="No settlement rows match."
        suppressCellFocus
      />
    </div>
  );
}
