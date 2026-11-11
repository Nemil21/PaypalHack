import { formatUsd, type Recommendation, type RecommendationOption } from '@holdfast/shared';
import { formatUsdCompact } from './kpis';

/**
 * Copy for the brand agent recommendation card (HF-051a, features/09 §Logic 1 and 4) and its line
 * in the W07 modal. Every number comes from the `book.recommendation` JSON fields, which the
 * server computed with the shared `clear()` (no model call, no client-side maths); this file only
 * formats them. No React, so the console and HF-061's M10 sheet can reuse it.
 */

export interface RecommendationChoice {
  quantity: number;
  /** "Clear 240 (cutoff $219)" */
  label: string;
  /** "$54.2k gross · $49.4k net vs $9,120 liquidation" */
  detail: string;
  /** "Below your $217.62 max-discount guard" when the cutoff breaks it. */
  warning: string | null;
}

export type RecommendationView =
  | { kind: 'empty'; message: string }
  | {
      kind: 'recommend';
      primary: RecommendationChoice;
      /** "Cutoff stays at or above $217.62 (floor and max discount). No public price change." */
      guardNote: string;
      alternatives: RecommendationChoice[];
    }
  | { kind: 'below_guard'; message: string; alternatives: RecommendationChoice[] };

const units = (q: number) => q.toLocaleString('en-US');

function choice(o: RecommendationOption, minCutoffCents: number): RecommendationChoice {
  const vs =
    o.liquidationCents === null ? '' : ` vs ${formatUsdCompact(o.liquidationCents)} liquidation`;
  return {
    quantity: o.quantity,
    label: `Clear ${units(o.quantity)} (cutoff ${formatUsd(o.cutoffCents)})`,
    detail: `${formatUsdCompact(o.grossCents)} gross · ${formatUsdCompact(o.netCents)} net${vs}`,
    warning: o.withinGuard ? null : `Below your ${formatUsd(minCutoffCents)} max-discount guard`,
  };
}

export function recommendationView(rec: Recommendation): RecommendationView {
  switch (rec.kind) {
    case 'NO_DEMAND':
      return { kind: 'empty', message: 'Not enough demand yet; share your link.' };
    case 'BELOW_GUARD':
      return {
        kind: 'below_guard',
        message: `No bid clears your max-discount guard yet: the best is ${formatUsd(rec.bestBidCents)}, the guard is ${formatUsd(rec.minCutoffCents)}.`,
        alternatives: rec.alternatives.map((a) => choice(a, rec.minCutoffCents)),
      };
    case 'RECOMMEND':
      return {
        kind: 'recommend',
        primary: choice(rec, rec.minCutoffCents),
        guardNote: `Cutoff stays at or above ${formatUsd(rec.minCutoffCents)} (your floor and max discount). No public price change.`,
        alternatives: rec.alternatives.map((a) => choice(a, rec.minCutoffCents)),
      };
  }
}

/**
 * The W07 line: "Brand agent recommends 240 (cutoff $219)." plus, when the brand is clearing a
 * different quantity, "You are clearing 200." Null without a recommendation.
 */
export function recommendationClearNote(
  rec: Recommendation | null | undefined,
  quantity: number,
): string | null {
  if (!rec || rec.kind !== 'RECOMMEND') return null;
  const line = `Brand agent recommends ${units(rec.quantity)} (cutoff ${formatUsd(rec.cutoffCents)}).`;
  return rec.quantity === quantity
    ? `${line} You are clearing that.`
    : `${line} You are clearing ${units(quantity)}.`;
}
