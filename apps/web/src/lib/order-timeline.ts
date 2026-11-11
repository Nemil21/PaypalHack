import {
  nowIndex,
  orderTimeline,
  timelineDate,
  type OrderPhase,
  type OrderTimelineFacts,
} from '@holdfast/shared';
import { atLeast, maxIso, minIso, type GanttData, type GanttTask } from './gantt';

/**
 * Web side of the order-status timeline (HF-060 part 2): the shared phases (packages/shared
 * `orderTimeline`) as Bryntum Gantt data for wide screens, and as list rows for the vertical
 * fallback at 375 px. Phases that have not happened yet stay as rows without a bar.
 */

export { nowIndex, orderTimeline, type OrderPhase };

/** Shortest visible bar as a share of the whole range: the capture fan-out takes seconds. */
const MIN_BAR_SHARE = 0.012;

export function orderTimelineGantt(phases: OrderPhase[], nowDate: Date): GanttData {
  const now = nowDate.toISOString();
  const known = phases.flatMap((p) => [p.startAt, p.endAt]);
  const startDate = minIso([...known, now])!;
  const endDate = maxIso([...known, now])!;
  const minMs = Math.max(60_000, (Date.parse(endDate) - Date.parse(startDate)) * MIN_BAR_SHARE);

  const tasks: GanttTask[] = phases.map((p) => {
    const base = {
      id: p.key,
      name: p.label,
      cls: `hf-${p.state}${p.planned ? ' hf-planned' : ''}`,
      detail: p.detail,
    };
    if (!p.startAt || p.state === 'skipped') {
      return { ...base, startDate: now, endDate: now, unscheduled: true };
    }
    if (p.milestone) return { ...base, startDate: p.startAt, endDate: p.startAt, milestone: true };
    // An active phase with no recorded end runs to now (or its deadline, when that is later).
    const end = p.endAt ?? now;
    return { ...base, startDate: p.startAt, endDate: atLeast(p.startAt, end, minMs) };
  });
  return { tasks, dependencies: [], now, startDate, endDate };
}

export const STATE_LABEL: Record<OrderPhase['state'], string> = {
  done: 'Done',
  active: 'Now',
  upcoming: 'Next',
  skipped: 'Skipped',
  failed: 'Stopped',
};

/** "Nov 11, 5:00 PM → Nov 13, 5:00 PM", "Nov 13, 5:00 PM (planned)", or null. */
export function phaseWhen(p: OrderPhase): string | null {
  if (!p.startAt) return null;
  if (p.milestone) return `${timelineDate(p.startAt)}${p.planned ? ' (planned)' : ''}`;
  if (!p.endAt) return `Since ${timelineDate(p.startAt)}`;
  return `${timelineDate(p.startAt)} → ${timelineDate(p.endAt)}${p.planned ? ' (planned)' : ''}`;
}

export function timelineFrom(facts: OrderTimelineFacts, now: Date) {
  const phases = orderTimeline(facts, now);
  return { phases, nowAt: nowIndex(phases, now) };
}
