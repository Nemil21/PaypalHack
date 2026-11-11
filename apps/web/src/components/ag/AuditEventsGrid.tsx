import { useCallback, useMemo } from 'react';
import type {
  ColDef,
  GetRowIdParams,
  ICellRendererParams,
  RowClassParams,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { gridTheme, registerAg } from '../../lib/ag';
import { actorLabel, dataSummary, isAlertRow, type AuditRow } from '../../lib/ops';
import { Badge } from '../ui';

registerAg();

function ActionCell({ data }: ICellRendererParams<AuditRow>) {
  if (!data) return null;
  return <Badge tone={isAlertRow(data) ? 'danger' : 'neutral'}>{data.action}</Badge>;
}

function EntityCell({ data }: ICellRendererParams<AuditRow>) {
  if (!data) return null;
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-[13px] text-ink">{data.entity}</span>
      {data.entityId && (
        <span className="font-mono text-[11px] text-muted" title={data.entityId}>
          {data.entityId.slice(0, 8)}…
        </span>
      )}
    </span>
  );
}

function PayPalCell({ data }: ICellRendererParams<AuditRow>) {
  if (!data) return null;
  if (!data.paypalId && !data.requestId) return <span className="text-muted">–</span>;
  return (
    <span className="flex flex-col leading-tight" title={data.requestId ?? undefined}>
      <span className={data.direct ? 'font-medium text-orange' : 'text-ink'}>
        {data.paypalId ?? '–'}
      </span>
      {data.requestId && <span className="text-[11px] text-muted">{data.requestId}</span>}
    </span>
  );
}

const time = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });

/**
 * W20 events table (HF-058) on AG Grid with the v3 grid theme shared with the bids grid (HF-025).
 * Newest first, as the API returns them; alert rows (VOID_STUCK, RECONCILE_MISMATCH, *_FAILED)
 * are tinted, and the PayPal id that matched a search is orange. Clicking a row selects it (the
 * action panel picks up its brand and listing).
 */
export default function AuditEventsGrid({
  rows,
  onSelect,
}: {
  rows: AuditRow[];
  onSelect(row: AuditRow): void;
}) {
  const columns = useMemo<ColDef<AuditRow>[]>(
    () => [
      {
        field: 'at',
        headerName: 'Time',
        valueFormatter: (p) => (p.value ? time(p.value) : ''),
        width: 170,
        flex: 0,
        cellClass: 'tabular-nums font-mono text-[12px]',
        sort: 'desc',
        comparator: (_a, _b, na, nb) => Number(na.data?.id ?? 0) - Number(nb.data?.id ?? 0),
      },
      { field: 'action', headerName: 'Action', cellRenderer: ActionCell, minWidth: 220 },
      { field: 'entity', headerName: 'Entity', cellRenderer: EntityCell, minWidth: 130, flex: 0 },
      {
        colId: 'actor',
        headerName: 'Actor',
        valueGetter: (p) => (p.data ? actorLabel(p.data) : ''),
        tooltipValueGetter: (p) => p.data?.actorId ?? '',
        minWidth: 150,
      },
      {
        field: 'brandName',
        headerName: 'Brand',
        valueFormatter: (p) => p.value ?? '–',
        minWidth: 130,
      },
      {
        field: 'paypalId',
        headerName: 'PayPal ID',
        cellRenderer: PayPalCell,
        cellClass: 'font-mono text-[12px]',
        minWidth: 200,
        // Search on both ids with the quick filter.
        getQuickFilterText: (p) => `${p.data?.paypalId ?? ''} ${p.data?.requestId ?? ''}`,
      },
      {
        colId: 'detail',
        headerName: 'Detail',
        valueGetter: (p) => (p.data ? dataSummary(p.data.data) : ''),
        tooltipValueGetter: (p) => (p.data ? JSON.stringify(p.data.data, null, 2) : ''),
        minWidth: 260,
        flex: 2,
        cellClass: 'text-[13px]',
      },
    ],
    [],
  );

  const getRowId = useCallback((p: GetRowIdParams<AuditRow>) => p.data.id, []);
  const rowClassRules = useMemo(
    () => ({ 'hf-row-alert': (p: RowClassParams<AuditRow>) => !!p.data && isAlertRow(p.data) }),
    [],
  );

  return (
    <div className="h-[520px] w-full" data-testid="audit-events">
      <AgGridReact<AuditRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ flex: 1, minWidth: 100, sortable: true, resizable: true }}
        getRowId={getRowId}
        rowClassRules={rowClassRules}
        rowHeight={48}
        rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
        onRowClicked={(e) => e.data && onSelect(e.data)}
        rowStyle={{ cursor: 'pointer' }}
        tooltipShowDelay={300}
        overlayNoRowsTemplate="No events match this search."
        suppressCellFocus
      />
    </div>
  );
}
