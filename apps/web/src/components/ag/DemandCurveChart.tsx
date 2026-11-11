import { useMemo, useSyncExternalStore } from 'react';
import { AgCharts } from 'ag-charts-react';
import type {
  AgCartesianChartOptions,
  AgCartesianLineCrossLineOptions,
} from 'ag-charts-enterprise';
import { formatUsd } from '@holdfast/shared';
import { chartTheme, registerAg } from '../../lib/ag';
import {
  cutoffMarker,
  type CurveDatum,
  type CurveMarker,
  type CurveModel,
} from '../../lib/console/curve';
import { formatUsdCompact } from '../../lib/console/kpis';
import type { SliderStore } from '../../lib/console/slider-store';
import { color } from '../../lib/tokens';

registerAg();

/**
 * The console demand curve on AG Charts (HF-024, features/08 §Layout 3). Step line of bids at or
 * above each price, a second series for held dollars on its own axis, and crossLines for the
 * floor, the public low and the live projected cutoff. Step interpolation, crossLines and a
 * second y axis are all AG Charts Community features, so the chart renders without a watermark
 * whether or not the key unlocks Enterprise (`registerAg`).
 *
 * The model (data + floor/public-low markers) changes only with the book; the cutoff marker
 * follows the slider store directly, so dragging re-renders this chart and nothing else.
 */

const MARKER_STYLE: Record<CurveMarker['kind'], { stroke: string; dash?: number[] }> = {
  floor: { stroke: color.muted, dash: [4, 4] },
  publicLow: { stroke: color.charcoal, dash: [2, 3] },
  cutoff: { stroke: color.orange },
};

function crossLine(m: CurveMarker, top: boolean): AgCartesianLineCrossLineOptions {
  const s = MARKER_STYLE[m.kind];
  return {
    type: 'line',
    value: m.priceCents,
    stroke: s.stroke,
    strokeWidth: m.kind === 'cutoff' ? 2 : 1,
    lineDash: s.dash,
    label: {
      text: m.label,
      color: m.kind === 'cutoff' ? color.orange : color.body,
      fontSize: 11,
      placement: top ? 'inside-top-end' : 'inside-bottom-end',
    },
  };
}

const tooltip = {
  renderer: ({ datum }: { datum: CurveDatum }) => ({
    heading: formatUsd(datum.priceCents),
    data: [{ label: '', value: datum.hover }],
  }),
};

export default function DemandCurveChart({
  model,
  slider,
}: {
  model: CurveModel;
  slider: SliderStore;
}) {
  const cutoffCents = useSyncExternalStore(
    slider.subscribe,
    () => slider.get().numbers?.cutoffCents ?? null,
    () => slider.get().numbers?.cutoffCents ?? null,
  );

  const options = useMemo<AgCartesianChartOptions>(() => {
    const cutoff = cutoffMarker(cutoffCents);
    const markers = cutoff ? [...model.markers, cutoff] : model.markers;
    const domain = model.domain;
    return {
      theme: chartTheme,
      data: model.data,
      series: [
        {
          type: 'line',
          xKey: 'priceCents',
          yKey: 'bidsAtOrAbove',
          yName: 'Bids at or above',
          // bidsAtOrAbove(x) for x in (p[i], p[i+1]] is the count at p[i+1]: step at the start.
          interpolation: { type: 'step', position: 'start' },
          stroke: color.charcoal,
          strokeWidth: 2,
          marker: { enabled: false },
          tooltip,
        },
        {
          type: 'line',
          xKey: 'priceCents',
          yKey: 'heldAtOrAboveCents',
          yName: 'Held at or above',
          yKeyAxis: 'held',
          interpolation: { type: 'step', position: 'start' },
          stroke: color.orange,
          strokeWidth: 1.5,
          lineDash: [6, 4],
          marker: { enabled: false },
          tooltip,
        },
      ],
      axes: {
        x: {
          type: 'number',
          position: 'bottom',
          ...(domain ? { min: domain.min, max: domain.max } : {}),
          label: { formatter: ({ value }: { value: number }) => formatUsd(Math.round(value)) },
          // Alternate label rows so close markers (floor next to the cutoff) do not collide.
          crossLines: markers.map((m, i) => crossLine(m, i % 2 === 0)),
        },
        y: {
          type: 'number',
          position: 'left',
          title: { text: 'Bids at or above' },
        },
        held: {
          type: 'number',
          position: 'right',
          title: { text: 'Held $' },
          label: {
            formatter: ({ value }: { value: number }) => formatUsdCompact(Math.round(value)),
          },
        },
      },
      legend: { enabled: true, position: 'bottom' },
    };
  }, [model, cutoffCents]);

  return (
    <div className="h-[320px] w-full" data-testid="demand-curve">
      <AgCharts options={options} style={{ height: '100%' }} />
    </div>
  );
}
