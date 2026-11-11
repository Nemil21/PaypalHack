import { useEffect, useRef } from 'react';
import { Gantt, StringHelper, TaskModel } from '@bryntum/gantt';
import '@bryntum/gantt/gantt.css';
import '@bryntum/gantt/svalbard-light.css';
import '@bryntum/gantt/fontawesome/css/fontawesome.css';
import '@bryntum/gantt/fontawesome/css/solid.css';
import './gantt.css';
import type { GanttData, GanttTask } from '../../lib/gantt';

/**
 * Read-only Bryntum Gantt (HF-060), the only module that imports `@bryntum/gantt`: screens load it
 * with `React.lazy`, so the trial bundle and its CSS stay in their own chunk, off every first
 * paint. Data comes in as plain `GanttData` (lib/gantt.ts); every task is manually scheduled so
 * the engine never moves a database timestamp. No editing (out of scope): drag, resize, menus and
 * the task editor are off.
 */

class HfTask extends TaskModel {
  static override fields = [
    { name: 'amount', type: 'string' },
    { name: 'detail', type: 'string' },
  ];
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
    startDate: t.startDate,
    ...(t.milestone ? { duration: 0 } : { endDate: t.endDate }),
    manuallyScheduled: true,
    cls: t.cls ?? '',
    amount: t.amount ?? '',
    detail: t.detail ?? '',
    expanded: true,
    ...(t.children ? { children: t.children.map(toRecord) } : {}),
  };
}

const enc = (s: unknown) => StringHelper.encodeHtml(String(s ?? ''));

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

export default function BryntumGantt(props: BryntumGanttProps) {
  const host = useRef<HTMLDivElement>(null);
  const gantt = useRef<Gantt | null>(null);
  const { data, nameHeader, nameWidth = 240, showAmount = false, height, ariaLabel } = props;

  useEffect(() => {
    const g = new Gantt({
      appendTo: host.current!,
      height: '100%',
      readOnly: true,
      rowHeight: 34,
      barMargin: 8,
      ariaLabel,
      project: { taskModelClass: HfTask },
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
          template: ({ taskRecord }: { taskRecord: HfTask }) => {
            const t = taskRecord as HfTask & { amount?: string; detail?: string };
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
        timeRangesData: data.now
          ? [{ id: 'now', name: 'Now', startDate: data.now, duration: 0, cls: 'hf-now' }]
          : [],
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
      });
    return () => {
      live = false;
    };
  }, [data]);

  return <div ref={host} className="hf-gantt w-full" style={{ height }} />;
}
