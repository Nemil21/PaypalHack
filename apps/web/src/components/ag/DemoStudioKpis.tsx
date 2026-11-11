import { useMemo } from 'react';
import type { AgDataSourcesDefinition, AgReportState } from 'ag-studio';
import { AgStudio } from 'ag-studio-react';
import { registerAg, studioV3Theme } from '../../lib/ag';
import { demoBids } from '../../lib/demo-fixtures';
import { font } from '../../lib/tokens';

registerAg();

/**
 * AG Studio dashboard on the v3 theme: the KPI row pattern HF-023 builds the console on (M26, the
 * AG Grid prize criterion), plus a bar chart, over the sample book.
 */
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const data = (): AgDataSourcesDefinition => ({
  description: 'Sample held bids for one Holdfast listing. Amounts are USD.',
  sources: [
    {
      id: 'bids',
      description: 'One row per live PayPal hold.',
      data: demoBids().map((b) => ({ ...b, amount: b.amountCents / 100 })),
      fields: [
        { id: 'bidId', name: 'Bid', format: 'textFormat' },
        { id: 'shopperLabel', name: 'Shopper', format: 'textFormat' },
        {
          id: 'amount',
          name: 'Bid amount',
          format: 'currencyFormat',
          formatOptions: { format: usd },
        },
        { id: 'source', name: 'Source', format: 'textFormat' },
        { id: 'isSimulated', name: 'Simulated', format: 'booleanFormat' },
      ],
    },
  ],
});

const typography = (fontSize: number) => ({
  fontFamily: font.sans,
  fontSize,
  fontWeight: 'normal' as const,
  fontStyle: 'normal' as const,
});

const kpi = (text: string, id: string, aggregation: 'sum' | 'avg' | 'min' | 'count') => ({
  type: 'value' as const,
  dataMapping: { value: [{ id, aggregation }] },
  format: {
    title: { enabled: true, text },
    caption: { enabled: false, text: '' },
    style: { typography: typography(28) },
  },
});

const report: AgReportState = {
  selectedPageId: 'book',
  panels: { filters: { collapsed: true } },
  pages: [
    {
      id: 'book',
      widgets: {
        held: kpi('MONEY HELD', 'bids.amount', 'sum'),
        bids: kpi('LIVE HOLDS', 'bids.bidId', 'count'),
        avg: kpi('AVERAGE BID', 'bids.amount', 'avg'),
        low: kpi('LOWEST BID', 'bids.amount', 'min'),
        bySource: {
          type: 'column-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'bids.source' }],
            valueKey: [{ id: 'bids.amount', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'MONEY HELD BY SOURCE' } },
        },
      },
      widgetLayout: {
        held: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 8 },
        bids: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 8 },
        avg: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 8 },
        low: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 8 },
        bySource: { xTrack: 0, yTrack: 8, xSpan: 24, ySpan: 18 },
      },
    },
  ],
};

export default function DemoStudioKpis() {
  const sources = useMemo(data, []);
  return (
    // Studio's canvas has a minimum width (~620 px); at 375 px it scrolls inside its own box
    // rather than pushing the page sideways.
    <div className="w-full overflow-x-auto">
      <div className="h-[560px] min-w-[640px]">
        <AgStudio
          style={{ height: '100%', width: '100%' }}
          theme={studioV3Theme}
          data={sources}
          initialState={report}
          mode="view"
        />
      </div>
    </div>
  );
}
