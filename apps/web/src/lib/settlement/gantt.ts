import { formatUsd, type SettlementRow, type SettlementView } from '@holdfast/shared';
import {
  atLeast,
  maxIso,
  minIso,
  type GanttData,
  type GanttDependency,
  type GanttTask,
} from '../gantt';
import { logRows, payoutCard, type LogRow } from './model';

/**
 * W08 settlement fan-out as a Gantt (HF-060 part 1; review B-brand §HF-060). One bar per
 * settlement row from `started_at` (RUNNING) to `finished_at` (SUCCEEDED / FAILED / CANCELLED); a
 * row still running grows to "now", a queued row sits at "now" as a short dashed bar. Captures and
 * releases are grouped; a dependency arrow runs from each declined capture to the capture that
 * promoted the next reserve bidder into its unit (`unit_root_bid_id`, D10); the payout is the final
 * milestone, after the captures. Copy comes from the log model, so the Gantt and the log agree
 * ("Charged" only for SUCCEEDED captures, "Released" only for SUCCEEDED voids, D14).
 */

/** Shortest bar drawn: PayPal answers in well under a second. */
const MIN_BAR_MS = 1_000;
const QUEUED_BAR_MS = 2_000;

export const SETTLEMENT_GANTT_IDS = {
  captures: 'captures',
  releases: 'releases',
  payout: 'payout',
} as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function bar(r: SettlementRow, log: LogRow, now: string): GanttTask {
  // A reserve VOID claimed by promoteWithin is CANCELLED without ever running: draw it at the
  // moment it was claimed.
  const queued = !r.startedAt && !r.finishedAt;
  const start = r.startedAt ?? r.finishedAt ?? now;
  const end = r.finishedAt ?? (queued ? start : maxIso([now, start])!);
  const sim = r.isSimulated ? ' · SIM' : '';
  return {
    id: r.settlementId,
    name: `${r.shopperLabel}${sim} · ${log.action}`,
    startDate: start,
    endDate: atLeast(start, end, queued ? QUEUED_BAR_MS : MIN_BAR_MS),
    cls: [
      `hf-${log.kind}`,
      log.promoted ? 'hf-promoted' : '',
      queued ? 'hf-queued' : '',
      !queued && !r.finishedAt ? 'hf-running' : '',
    ]
      .filter(Boolean)
      .join(' '),
    amount: formatUsd(r.amountCents),
    detail: log.note ?? (r.paypalId ? `PayPal ${r.paypalId}` : undefined),
  };
}

/** Started rows by start time, queued rows last in server order. */
function byStart(a: SettlementRow, b: SettlementRow): number {
  if (a.startedAt && b.startedAt) return a.startedAt.localeCompare(b.startedAt);
  if (a.startedAt) return -1;
  if (b.startedAt) return 1;
  return 0;
}

export function settlementGantt(view: SettlementView, nowDate: Date): GanttData {
  const now = nowDate.toISOString();
  const logs = new Map(logRows(view).map((l) => [l.settlementId, l]));
  const rows = [...view.rows].sort(byStart);
  const captures = rows.filter((r) => r.action === 'CAPTURE');
  const releases = rows.filter((r) => r.action === 'VOID');

  const toBar = (r: SettlementRow) => bar(r, logs.get(r.settlementId)!, now);
  const group = (id: string, label: string, list: SettlementRow[]): GanttTask[] =>
    list.length === 0 ? [] : [{ ...span(list.map(toBar)), id, name: label, cls: 'hf-group' }];

  const tasks: GanttTask[] = [
    ...group(
      SETTLEMENT_GANTT_IDS.captures,
      `Captures · ${plural(captures.length, 'winner')}`,
      captures,
    ),
    ...group(
      SETTLEMENT_GANTT_IDS.releases,
      `Releases · ${plural(releases.length, 'hold')}`,
      releases,
    ),
  ];

  // Decline → promotion arrows (D10): the failed winner's capture to the promoted capture.
  const dependencies: GanttDependency[] = [];
  const captureByBid = new Map(captures.map((r) => [r.bidId, r]));
  for (const r of captures) {
    const log = logs.get(r.settlementId)!;
    if (!log.promoted || !log.linkedBidId) continue;
    const failed = captureByBid.get(log.linkedBidId);
    if (!failed) continue;
    dependencies.push({
      id: `promotion-${failed.settlementId}-${r.settlementId}`,
      fromTask: failed.settlementId,
      toTask: r.settlementId,
      cls: 'hf-dep-promotion',
    });
  }

  // Payout: the final milestone, once it exists at its completion (else creation) time; before
  // that, a "waiting" marker right after the last capture (or now, while captures still run).
  const card = payoutCard(view);
  const lastFinish = maxIso(rows.map((r) => r.finishedAt));
  const p = view.payout;
  const payoutAt =
    p?.completedAt ??
    p?.createdAt ??
    (view.listingStatus === 'CLEARING' ? maxIso([now, lastFinish]) : (lastFinish ?? now))!;
  if (captures.length > 0 || p) {
    tasks.push({
      id: SETTLEMENT_GANTT_IDS.payout,
      name: `Payout · ${card.statusLabel}`,
      startDate: payoutAt,
      endDate: payoutAt,
      milestone: true,
      cls: `hf-payout hf-payout-${card.state}`,
      amount: card.estimate ? undefined : formatUsd(card.netCents),
      detail: card.detail ?? undefined,
    });
    if (captures.length > 0) {
      dependencies.push({
        id: 'captures-payout',
        fromTask: SETTLEMENT_GANTT_IDS.captures,
        toTask: SETTLEMENT_GANTT_IDS.payout,
        cls: 'hf-dep-payout',
      });
    }
  }

  // "Now" only matters while money is still moving; once settled it would squash the fan-out.
  const live = view.listingStatus === 'CLEARING';
  const all = tasks.flatMap((t) => [t, ...(t.children ?? [])]);
  const startDate = minIso(all.map((t) => t.startDate)) ?? now;
  const endDate = maxIso([...all.map((t) => t.endDate), live ? now : null]) ?? now;
  return { tasks, dependencies, now: live ? now : null, startDate, endDate };
}

function span(children: GanttTask[]): Omit<GanttTask, 'id' | 'name'> {
  return {
    startDate: minIso(children.map((c) => c.startDate))!,
    endDate: maxIso(children.map((c) => c.endDate))!,
    children,
  };
}
