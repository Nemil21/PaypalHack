import { useMemo } from 'react';
import { AgCharts } from 'ag-charts-react';
import type { AgCartesianChartOptions } from 'ag-charts-enterprise';
import { formatUsd } from '@holdfast/shared';
import { chartTheme, registerAg } from '../../lib/ag';
import { demandCurve, demoBids } from '../../lib/demo-fixtures';
import { color } from '../../lib/tokens';
import { TierBadge } from './DemoBidsGrid';

const { gridEnterprise } = registerAg();

/**
 * AG Charts on the v3 theme, styled like the "How it works" demand bars: charcoal above the
 * cutoff, grey below, an orange cutoff line. Zoom is Enterprise-only, so it is on only when the
 * key covers AG Charts Enterprise (an invalid key would show the watermark here).
 */
export default function DemoDemandChart({ cutoffCents = 21_900 }: { cutoffCents?: number }) {
  const options = useMemo<AgCartesianChartOptions>(() => {
    const data = demandCurve(demoBids()).map((d) => ({
      price: formatUsd(d.priceCents),
      count: d.count,
      fill: d.priceCents >= cutoffCents ? color.charcoal : color.bar,
    }));
    return {
      theme: chartTheme,
      data,
      series: [
        {
          type: 'bar',
          xKey: 'price',
          yKey: 'count',
          yName: 'Bids',
          cornerRadius: 0,
          itemStyler: ({ datum }) => ({ fill: (datum as { fill: string }).fill }),
        },
      ],
      axes: {
        x: {
          type: 'category',
          position: 'bottom',
          crossLines: [
            {
              type: 'line',
              value: formatUsd(cutoffCents),
              stroke: color.orange,
              strokeWidth: 1.5,
              label: {
                text: `CLEAR @ ${formatUsd(cutoffCents)}`,
                color: color.orange,
                placement: 'top',
              },
            },
          ],
        },
        y: { type: 'number', position: 'left', title: { text: 'Bids' } },
      },
      ...(gridEnterprise ? { zoom: { enabled: true } } : {}),
      legend: { enabled: false },
    };
  }, [cutoffCents]);

  return (
    <div className="flex flex-col gap-2">
      <TierBadge enterprise={gridEnterprise} />
      <div className="h-[320px] w-full">
        <AgCharts options={options} style={{ height: '100%' }} />
      </div>
    </div>
  );
}
