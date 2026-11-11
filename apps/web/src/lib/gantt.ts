/**
 * The data the Bryntum Gantt wrapper (`components/bryntum/BryntumGantt`) renders (HF-060). Plain,
 * serialisable objects so the W08 settlement model and the order-status timeline model stay pure
 * and testable without loading Bryntum; the wrapper maps them onto Bryntum task / dependency /
 * time range records. Every task is manually scheduled: the dates are facts from the database,
 * never something the scheduling engine may move.
 */

export interface GanttTask {
  id: string;
  name: string;
  /** ISO instants. A milestone has `startDate === endDate`. */
  startDate: string;
  endDate: string;
  milestone?: boolean;
  /** A row with no bar yet (a phase that has not happened); its dates are ignored. */
  unscheduled?: boolean;
  /** CSS class on the bar (`hf-*`, styled in components/bryntum/gantt.css). */
  cls?: string;
  /** Right-hand column text, e.g. "$229". */
  amount?: string;
  /** Tooltip / row detail line. */
  detail?: string;
  children?: GanttTask[];
}

export interface GanttDependency {
  id: string;
  fromTask: string;
  toTask: string;
  cls?: string;
}

export interface GanttData {
  tasks: GanttTask[];
  dependencies: GanttDependency[];
  /** The "Now" marker; null hides it. */
  now: string | null;
  /** Visible range; the wrapper zooms to fit it. */
  startDate: string;
  endDate: string;
}

/** `end` no earlier than `start + minMs`, so a sub-second PayPal call still draws as a bar. */
export function atLeast(startIso: string, endIso: string, minMs: number): string {
  const s = Date.parse(startIso);
  return new Date(Math.max(Date.parse(endIso), s + minMs)).toISOString();
}

export function minIso(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (v && (best === null || Date.parse(v) < Date.parse(best))) best = v;
  return best;
}

export function maxIso(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (v && (best === null || Date.parse(v) > Date.parse(best))) best = v;
  return best;
}

/** Every task in the tree, depth first. */
export function flattenTasks(tasks: GanttTask[]): GanttTask[] {
  return tasks.flatMap((t) => [t, ...flattenTasks(t.children ?? [])]);
}
