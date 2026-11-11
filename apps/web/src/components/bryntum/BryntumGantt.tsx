import { useEffect, useRef, type ComponentType } from 'react';
import type * as BryntumModule from '@bryntum/gantt';
import type { Gantt, TaskModel } from '@bryntum/gantt';
// `?url`: the trial's prebuilt ES module is copied to dist as an asset, never parsed or rendered
// by Rollup (4.7 MB unminified; bundling it ran CI's `vite build` out of heap). It is fetched at
// runtime by the dynamic import() below, only when a Gantt screen mounts.
import bryntumUrl from '@bryntum/gantt/gantt.module.js?url';
import '@bryntum/gantt/gantt.css';
import '@bryntum/gantt/svalbard-light.css';
import '@bryntum/gantt/fontawesome/css/fontawesome.css';
import '@bryntum/gantt/fontawesome/css/solid.css';
import './gantt.css';
import type { GanttData, GanttTask } from '../../lib/gantt';

/**
 * Read-only Bryntum Gantt (HF-060), the only module that touches `@bryntum/gantt`: screens load it
 * with `React.lazy(loadBryntumGantt)`, which also fetches the Bryntum module itself, so neither the
 * trial bundle nor its CSS is on any first paint. Data comes in as plain `GanttData`
 * (lib/gantt.ts); every task is manually scheduled so the engine never moves a database timestamp.
 * No editing (out of scope): drag, resize, menus and the task editor are off.
 */

type Bryntum = typeof BryntumModule;
let bryntum: Promise<Bryntum> | null = null;

function loadBryntum(): Promise<Bryntum> {
  bryntum ??= import(/* @vite-ignore */ bryntumUrl) as Promise<Bryntum>;
  return bryntum;
}

type Loaded = { default: ComponentType<BryntumGanttProps> };
let loaded: Promise<Loaded> | null = null;

/** `React.lazy` factory: resolves once Bryntum itself has loaded (shared by every screen). */
export function loadBryntumGantt(): Promise<Loaded> {
  loaded ??= bind();
  return loaded;
}

async function bind(): Promise<Loaded> {
  const b = await loadBryntum();
  class HfTask extends b.TaskModel {
    static override fields = [
      { name: 'amount', type: 'string' },
      { name: 'detail', type: 'string' },
    ];
  }
  const Bound = (props: BryntumGanttProps) => (
    <BryntumGantt {...props} bryntum={b} taskModelClass={HfTask} />
  );
  return { default: Bound };
}

export interface BryntumGanttProps {
  data: GanttData;
  /** Header of the task-name column. */
  nameHeader: string;
  nameWidth?: number;
  /** Show the right-aligned amount column. */
  showAmount?: boolean;
  height: number;
  ariaLabel: string;
}

function toRecord(t: GanttTask): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    ...(t.unscheduled
      ? { unscheduled: true }
      : { startDate: t.startDate, ...(t.milestone ? { duration: 0 } : { endDate: t.endDate }) }),
    manuallyScheduled: true,
    cls: t.cls ?? '',
    amount: t.amount ?? '',
    detail: t.detail ?? '',
    expanded: true,
    ...(t.children ? { children: t.children.map(toRecord) } : {}),
  };
}

function fmt(d: Date | null | undefined): string {
  return d
    ? d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
    : '–';
}

function BryntumGantt(
  props: BryntumGanttProps & { bryntum: Bryntum; taskModelClass: typeof TaskModel },
) {
  const host = useRef<HTMLDivElement>(null);
  const gantt = useRef<Gantt | null>(null);
  const { data, nameHeader, nameWidth = 240, showAmount = false, height, ariaLabel } = props;
  const { bryntum: b, taskModelClass } = props;

  useEffect(() => {
    const enc = (s: unknown) => b.StringHelper.encodeHtml(String(s ?? ''));
    const g = new b.Gantt({
      appendTo: host.current!,
      height: '100%',
      readOnly: true,
      rowHeight: 34,
      barMargin: 8,
      ariaLabel,
      project: { taskModelClass },
      columns: [
        { type: 'name', text: nameHeader, width: nameWidth, sortable: false },
        ...(showAmount
          ? [
              {
                text: 'Amount',
                field: 'amount',
                width: 84,
                align: 'right' as const,
                sortable: false,
              },
            ]
          : []),
      ],
      subGridConfigs: { locked: { width: nameWidth + (showAmount ? 84 : 0) } },
      features: {
        timeRanges: { showCurrentTimeLine: false, showHeaderElements: true },
        taskTooltip: {
          template: ({ taskRecord }: { taskRecord: TaskModel }) => {
            const t = taskRecord as TaskModel & { amount?: string; detail?: string };
            const when = t.isMilestone
              ? fmt(t.startDate as Date)
              : `${fmt(t.startDate as Date)} → ${fmt(t.endDate as Date)}`;
            return `<div class="hf-gantt-tip"><strong>${enc(t.name)}</strong>${
              t.amount ? `<span>${enc(t.amount)}</span>` : ''
            }<span>${enc(when)}</span>${t.detail ? `<span>${enc(t.detail)}</span>` : ''}</div>`;
          },
        },
        dependencyEdit: false,
        taskEdit: false,
        taskMenu: false,
        cellMenu: false,
        headerMenu: false,
        timeAxisHeaderMenu: false,
        scheduleMenu: false,
        taskDrag: false,
        taskDragCreate: false,
        taskResize: false,
        cellEdit: false,
        percentBar: false,
        projectLines: false,
        rowReorder: false,
        sort: false,
      },
    });
    gantt.current = g;
    return () => {
      gantt.current = null;
      g.destroy();
    };
    // The Gantt is built once per mount; data changes go through loadInlineData below.
  }, []);

  useEffect(() => {
    const g = gantt.current;
    if (!g) return;
    let live = true;
    void g.project
      .loadInlineData({
        tasksData: data.tasks.map(toRecord),
        dependenciesData: data.dependencies.map((d) => ({ ...d, type: 2 })),
      })
      .then(() => {
        if (!live || g.isDestroyed) return;
        // Fit the whole range (tasks and the Now marker); the margins keep the first bar and the
        // payout diamond off the edges.
        g.zoomToSpan({
          startDate: new Date(data.startDate),
          endDate: new Date(data.endDate),
          leftMargin: 24,
          rightMargin: 64,
        });
        // After the zoom, so the line is placed on the final time axis. The Now marker: a zero-length time range (TimeRanges feature draws it as a line).
        g.project.timeRangeStore.data = data.now
          ? [{ id: 'now', name: 'Now', startDate: data.now, duration: 0, cls: 'hf-now' }]
          : [];
      });
    return () => {
      live = false;
    };
  }, [data]);

  return <div ref={host} className="hf-gantt w-full" style={{ height }} />;
}
