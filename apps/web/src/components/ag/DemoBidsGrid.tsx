import { useMemo } from 'react';
import type { ColDef, ICellRendererParams, ValueFormatterParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { formatUsd } from '@holdfast/shared';
import { gridTheme, registerAg } from '../../lib/ag';
import { demoBids, type DemoBid } from '../../lib/demo-fixtures';
import { Badge, SimChip } from '../ui';

const { gridEnterprise } = registerAg();

const setFilter = gridEnterprise ? 'agSetColumnFilter' : 'agTextColumnFilter';

const enterpriseProps = gridEnterprise
  ? {
      rowGroupPanelShow: 'onlyWhenGrouping' as const,
      cellSelection: true,
      statusBar: { statusPanels: [{ statusPanel: 'agAggregationComponent' }] },
      sideBar: { toolPanels: ['columns', 'filters'] },
    }
  : {};

const money = (p: ValueFormatterParams<DemoBid, number>) =>
  typeof p.value === 'number' ? formatUsd(p.value) : '';

function LabelCell({ data }: ICellRendererParams<DemoBid>) {
  if (!data) return null;
  return (
    <span className="flex items-center gap-2">
      {data.shopperLabel}
      {data.isSimulated && <SimChip />}
    </span>
  );
}

/**
 * AG Grid on the v3 theme. With an Enterprise key it turns on Enterprise-only features (row
 * grouping, set filter, cell selection with an aggregation status bar, side bar), so an invalid
 * key would show its watermark here; without one it runs on Community.
 */
export default function DemoBidsGrid() {
  const rows = useMemo(() => demoBids(), []);
  const columns = useMemo<ColDef<DemoBid>[]>(
    () => [
      { field: 'shopperLabel', headerName: 'Shopper', cellRenderer: LabelCell, minWidth: 180 },
      {
        field: 'amountCents',
        headerName: 'Bid',
        valueFormatter: money,
        type: 'rightAligned',
        aggFunc: gridEnterprise ? 'sum' : undefined,
        sort: 'desc',
        cellClass: 'tabular-nums',
      },
      { field: 'source', headerName: 'Source', enableRowGroup: gridEnterprise, filter: setFilter },
      { field: 'status', headerName: 'Status', filter: setFilter },
      {
        field: 'placedAt',
        headerName: 'Placed',
        valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString('en-US') : ''),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      <TierBadge enterprise={gridEnterprise} />
      <div className="h-[420px] w-full">
        <AgGridReact<DemoBid>
          theme={gridTheme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ flex: 1, minWidth: 120, filter: true }}
          {...enterpriseProps}
        />
      </div>
    </div>
  );
}

export function TierBadge({ enterprise }: { enterprise: boolean }) {
  return (
    <span>
      <Badge tone={enterprise ? 'success' : 'neutral'}>
        {enterprise ? 'Enterprise · licensed' : 'Community · key is not a Grid Enterprise key'}
      </Badge>
    </span>
  );
}
