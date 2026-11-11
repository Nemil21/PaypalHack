/**
 * AG Grid, AG Charts and AG Studio: licence registration and the v3 themes.
 * Import this module only from lazily loaded components, so the AG bundles stay off first paint.
 *
 * `AG_GRID_LICENSE_KEY` (served by `/api/client-config`) always goes to AG Studio. Standalone
 * grids and charts get the Enterprise modules only when the same key is valid for "AG Grid and AG
 * Charts Enterprise"; otherwise they register the Community modules, so nothing ever renders with
 * a watermark. An AG Studio key licenses Studio and the grids and charts inside its widgets, but
 * not standalone `AgGridReact` / `AgCharts` (checked Nov 11 with the hackathon Studio Pro trial).
 */
import {
  AllCommunityModule as AllChartsCommunityModule,
  AllEnterpriseModule as AllChartsEnterpriseModule,
  LicenseManager as ChartsLicenseManager,
  ModuleRegistry as ChartsModuleRegistry,
  type AgChartTheme,
} from 'ag-charts-enterprise';
import {
  AllCommunityModule,
  ModuleRegistry as GridModuleRegistry,
  themeQuartz,
} from 'ag-grid-community';
import { AllEnterpriseModule, IntegratedChartsModule, LicenseManager } from 'ag-grid-enterprise';
import { AgChartsEnterpriseModule } from 'ag-charts-enterprise';
import { AgStudioLicenseManager, studioTheme } from 'ag-studio';
import { clientConfig } from './client-config';
import { chartPalette, color, font, radius } from './tokens';

export interface AgLicenceState {
  /** A key was supplied (it always goes to AG Studio). */
  keyLoaded: boolean;
  /** Standalone AG Grid / AG Charts run with Enterprise modules (else Community). */
  gridEnterprise: boolean;
}

let state: AgLicenceState | null = null;

/** Whether `key` is a valid AG Grid + AG Charts Enterprise key. Never logs the key. */
function isGridEnterpriseKey(key: string): boolean {
  try {
    return LicenseManager.getLicenseDetails(key).valid === true;
  } catch {
    return false;
  }
}

/** Idempotent. Call before rendering any AG component. */
export function registerAg(): AgLicenceState {
  if (state) return state;
  const key = clientConfig().agGridLicenseKey;
  const gridEnterprise = !!key && isGridEnterpriseKey(key);

  if (key) AgStudioLicenseManager.setLicenseKey(key);
  if (gridEnterprise) {
    GridModuleRegistry.registerModules([
      AllEnterpriseModule,
      IntegratedChartsModule.with(AgChartsEnterpriseModule),
    ]);
    ChartsModuleRegistry.registerModules([AllChartsEnterpriseModule]);
    LicenseManager.setLicenseKey(key);
    ChartsLicenseManager.setLicenseKey(key);
  } else {
    GridModuleRegistry.registerModules([AllCommunityModule]);
    ChartsModuleRegistry.registerModules([AllChartsCommunityModule]);
  }
  state = { keyLoaded: !!key, gridEnterprise };
  return state;
}

const line = (c: string) => ({ width: 1, color: c });

/** AG Grid on v3: Geist body, Geist Mono uppercase headers, thin lines, square corners. */
export const gridTheme = themeQuartz.withParams({
  fontFamily: font.sans,
  fontSize: 14,
  foregroundColor: color.ink,
  textColor: color.ink,
  subtleTextColor: color.muted,
  backgroundColor: color.page,
  accentColor: color.orange,
  borderColor: color.line,
  borderRadius: radius.sm,
  wrapperBorderRadius: 0,
  headerFontFamily: font.mono,
  headerFontSize: 11,
  headerFontWeight: 500,
  headerTextColor: color.muted,
  headerBackgroundColor: color.surface,
  rowBorder: line(color.line),
  rowHoverColor: color.surface,
  selectedRowBackgroundColor: color.orangeTint,
  rowHeight: 40,
  headerHeight: 36,
  spacing: 6,
});

/** AG Charts on v3. Charts draw on canvas, so values are hex, not CSS variables. */
export const chartTheme: AgChartTheme = {
  baseTheme: 'ag-default',
  palette: { fills: [...chartPalette], strokes: [...chartPalette] },
  params: {
    fontFamily: font.sans,
    fontSize: 12,
    textColor: color.ink,
    subtleTextColor: color.muted,
    backgroundColor: color.page,
    axisLineColor: color.line,
    axisLabelColor: color.muted,
    axisLabelFontFamily: font.mono,
    gridLineColor: color.line,
    chartPadding: 16,
  },
};

/** AG Studio on v3: the canvas is the page, widgets are thin-ruled square cards. */
export const studioV3Theme = studioTheme.withParams({
  fontFamily: font.sans,
  fontSize: 14,
  textColor: color.ink,
  foregroundColor: color.ink,
  subtleTextColor: color.muted,
  backgroundColor: color.page,
  borderColor: color.line,
  accentColor: color.orange,
  iconColor: color.charcoal,
  rowHoverColor: color.surface,

  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: color.page,
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: color.page,
  studioCanvasPadding: 0,
  studioCanvasFontFamily: font.sans,

  studioWidgetBackgroundColor: color.page,
  studioWidgetBorder: line(color.line),
  studioWidgetBorderRadius: radius.md,
  studioWidgetPadding: 12,
  studioWidgetTitleFontFamily: font.mono,
  studioWidgetTitleFontSize: 11,
  studioWidgetTitleFontWeight: 500,
  studioWidgetTitleTextColor: color.muted,
  studioWidgetSubtitleFontFamily: font.sans,
  studioWidgetSubtitleTextColor: color.muted,
  studioWidgetCaptionFontFamily: font.sans,
  studioWidgetCaptionTextColor: color.muted,

  gridFontFamily: font.sans,
  gridHeaderFontFamily: font.mono,
  gridHeaderTextColor: color.muted,
  gridHeaderBackgroundColor: color.surface,
  gridRowBorder: line(color.line),
  gridWrapperBorder: false,

  chartFontFamily: font.sans,
  chartTextColor: color.ink,
  chartSubtleTextColor: color.muted,
  chartAxisLineColor: color.line,
  chartGridLineColor: color.line,
  ...Object.fromEntries(
    chartPalette.flatMap((c, i) => [
      [`chartPaletteFills${i + 1}Color`, c],
      [`chartPaletteStrokes${i + 1}Color`, c],
    ]),
  ),
});
