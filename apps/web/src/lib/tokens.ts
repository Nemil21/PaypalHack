/**
 * Design tokens from the Figma "PayPal-Hack26" file, page **Holdfast — v3** (D16).
 *
 * The v3 frames don't bind Figma variables, so these are the fills, type and radii used on the
 * page (nodes 71:4 "Landing — Hero" and 81:2 "Landing — How it works"). `styles.css` declares the
 * same values as CSS variables and the Tailwind theme; `tokens.test.ts` keeps the two in sync.
 *
 * Canvas-drawn widgets (AG Charts, AG Studio charts) can't resolve `var(--…)`, so they read the
 * hex values from here.
 */
export const color = {
  /** Page background. */
  page: '#ffffff',
  /** Headlines, amounts, active labels. */
  ink: '#141414',
  /** Body copy, nav links. */
  body: '#4a4a4a',
  /** Captions, inactive labels, axis ticks. */
  muted: '#8a8a8a',
  /** Main action. */
  orange: '#f26b2c',
  /** Orange pill background ("HELD · NOT CHARGED"). */
  orangeTint: '#fdebe2',
  /** Key-chip text on an orange button. */
  orangeKey: '#ffd9c7',
  /** Secondary action, filled bars. */
  charcoal: '#2b2b2b',
  /** Key-chip text on a charcoal button. */
  charcoalKey: '#bdbdbd',
  /** Outlined button border. */
  border: '#dadada',
  /** Thin guide lines, dividers, section rules. */
  line: '#e6e6e6',
  /** Inset panels (visual wells, timeline track). */
  surface: '#f6f6f4',
  /** Inset panel border. */
  surfaceLine: '#ececea',
  /** Column rules inside an inset panel. */
  surfaceRule: '#e2e2df',
  /** Dashed "planned" outline. */
  planned: '#cfcfcb',
  /** Below-cutoff bars. */
  bar: '#c9c9c6',
  /** Money returned to the shopper ("Released to you"). */
  success: '#3f8f5b',
  /**
   * Errors. Not on the v3 page (no error state is drawn yet); chosen to sit with the palette.
   * Replace when a v3 error frame lands.
   */
  danger: '#b3261e',
  dangerTint: '#fbeae8',
} as const;

export type ColorToken = keyof typeof color;

/** v3 uses a 4 px grid: 4, 8, 12, 16, 24, 32, 48, 72 (page gutter). */
export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  12: 48,
  18: 72,
} as const;

/** Square corners: 2 px on buttons, pills and chips; 4 px on cards and wells. */
export const radius = { sm: 2, md: 4 } as const;

export const font = {
  sans: '"Geist Variable", Geist, ui-sans-serif, system-ui, sans-serif',
  mono: '"Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  /** v4: italic only, orange accent words on the landing and Docs. */
  serif: '"Instrument Serif", ui-serif, Georgia, serif',
} as const;

/** Card shadow on the held card and receipt. */
export const shadow = { card: '0 4px 14px 0 rgba(0, 0, 0, 0.06)' } as const;

/** Desktop page gutters: guide lines at 48 px, content at 72 px. */
export const layout = { guide: 48, gutter: 72, maxWidth: 1440 } as const;

/** Categorical series for charts: charcoal first, orange for the highlighted series. */
export const chartPalette = [
  color.charcoal,
  color.orange,
  color.bar,
  color.muted,
  color.success,
] as const;
