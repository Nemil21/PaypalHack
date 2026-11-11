import { useMemo, useSyncExternalStore } from 'react';
import type { AgDataSourcesDefinition, AgReportState, AgWidgetParams } from 'ag-studio';
import { AgStudio, createWidgets, type AgWidgetDefinition } from 'ag-studio-react';
import { registerAg, studioV3Theme } from '../../lib/ag';
import { KPI_LABEL, KpiTile, type KpiKind, type KpiStore } from '../console/KpiTiles';

registerAg();

/**
 * The console KPI row on AG Studio (HF-023, M26: the AG Grid prize criterion). Five custom v3
 * widgets (`holdfast-kpi-*`) laid out by Studio in view mode. Studio is created once; live values
 * reach the widgets through a small external store passed as Studio's `context`, so a burst of
 * bids re-renders five tiles, never the dashboard.
 */

interface KpiContext {
  kpis: KpiStore;
}

function widgetFor(kind: KpiKind) {
  return function KpiWidget(params: AgWidgetParams) {
    const store = (params.context as KpiContext).kpis;
    const kpis = useSyncExternalStore(store.subscribe, store.get, store.get);
    return <KpiTile kind={kind} kpis={kpis} />;
  };
}

const KINDS: KpiKind[] = ['held', 'bids', 'projected', 'recovery', 'released'];

const definitions: AgWidgetDefinition[] = KINDS.map((kind) => ({
  id: `holdfast-kpi-${kind}`,
  label: KPI_LABEL[kind],
  comp: widgetFor(kind),
  form: (p) => p.createDefaults({}),
  defaultSize: { width: 1, height: 6 },
  minSize: { width: 1, height: 6 },
}));

// Studio needs a data source to boot; the KPI widgets read the store, not the data engine.
const data: AgDataSourcesDefinition = {
  description: 'Holdfast listing console KPIs (live values come from the console book).',
  sources: [
    {
      id: 'kpis',
      description: 'Placeholder source; the KPI widgets render live values from the console.',
      data: [{ listing: 'console' }],
      fields: [{ id: 'listing', name: 'Listing', format: 'textFormat' }],
    },
  ],
};

// One Studio column per KPI; 6 rows of 22 px fit a label, a 32 px value and two caption lines.
const report = {
  selectedPageId: 'kpis',
  pages: [
    {
      id: 'kpis',
      layout: { columns: KINDS.length, rowHeight: 22, pagePadding: 0, widgetPadding: 0 },
      widgets: Object.fromEntries(
        KINDS.map((kind) => [kind, { type: `holdfast-kpi-${kind}`, dataMapping: {} }]),
      ),
      widgetLayout: Object.fromEntries(
        KINDS.map((kind, i) => [kind, { xTrack: i, yTrack: 0, xSpan: 1, ySpan: 6 }]),
      ),
    },
  ],
} as unknown as AgReportState;

export default function ConsoleKpiStudio({ store }: { store: KpiStore }) {
  const widgets = useMemo(() => createWidgets({ additionalTypes: definitions } as never), []);
  const context = useMemo<KpiContext>(() => ({ kpis: store }), [store]);
  return (
    // Studio's canvas has a minimum width; below it the row scrolls inside its own box.
    <div className="w-full overflow-x-auto overflow-y-hidden" data-testid="kpi-studio">
      <div className="h-[160px] min-w-[880px]">
        <AgStudio
          style={{ height: '100%', width: '100%' }}
          theme={studioV3Theme}
          data={data}
          widgets={widgets as never}
          context={context}
          initialState={report}
          // No filters panel: the KPI row is read-only numbers.
          panels={{ view: {} }}
          mode="view"
        />
      </div>
    </div>
  );
}
