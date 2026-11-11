import { z } from 'zod';
import type { Recommendation } from './book.js';
import { formatUsd } from './money.js';

/**
 * Brand agent "Ask about this book" (HF-051b; features/09 §Logic 2–3, api.md
 * `POST /brand-agent/ask`). Brand-only: the answer, the tool JSON and the recommendation never
 * reach a shopper-facing response.
 */

/**
 * Widgets the agent may add to the W06 agent dashboard (AG Studio). The model picks a kind; the
 * browser builds the widget from the console's own bids. Nothing on the server changes.
 */
export const BRAND_AGENT_WIDGETS = [
  'held_by_source',
  'bids_by_price',
  'simulated_vs_real',
] as const;
export type BrandAgentWidgetKind = (typeof BRAND_AGENT_WIDGETS)[number];

export const BRAND_AGENT_WIDGET_TITLES: Record<BrandAgentWidgetKind, string> = {
  held_by_source: 'Held $ by source',
  bids_by_price: 'Bids by price',
  simulated_vs_real: 'Held $: simulated vs real',
};

export const brandAgentAskRequestSchema = z
  .object({
    listingId: z.string().uuid(),
    /** Absent: explain the code recommendation (the prose under the W06 card). */
    question: z.string().trim().min(1).max(1_000).optional(),
    /**
     * Earlier turns of this panel's thread, text only (no tool results), so a follow-up such as
     * "and at 260?" has its context. Numbers in the new answer still come from this turn's tools.
     */
    history: z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4_000) }).strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type BrandAgentAskRequest = z.infer<typeof brandAgentAskRequestSchema>;

/** One read-only tool call this turn, with the JSON the model was given. */
export const brandAgentStepSchema = z.object({
  tool: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  result: z.unknown(),
});
export type BrandAgentStep = z.infer<typeof brandAgentStepSchema>;

export const brandAgentAskResponseSchema = z.object({
  /** Claude's text: commentary. Null when Claude is down, timed out or not configured. */
  answer: z.string().nullable(),
  available: z.boolean(),
  /** The code recommendation (HF-051a); null when there is nothing to recommend. */
  recommendation: z
    .object({
      quantity: z.number().int(),
      cutoffCents: z.number().int(),
      grossCents: z.number().int(),
      reasons: z.array(z.string()),
    })
    .nullable(),
  steps: z.array(brandAgentStepSchema),
  /** UI-only tool calls for the AG Studio panel to carry out (add a widget). */
  widgets: z.array(z.object({ kind: z.enum(BRAND_AGENT_WIDGETS) })),
  /** Numbers in `answer` that match no tool result: the UI says to trust the cards instead. */
  unverifiedNumbers: z.array(z.string()),
});
export type BrandAgentAskResponse = z.infer<typeof brandAgentAskResponseSchema>;

/** Code-written reasons for the recommendation (api.md `recommendation.reasons`). */
export function recommendationReasons(rec: Recommendation): string[] {
  if (rec.kind === 'NO_DEMAND') return ['Not enough demand yet; share your link.'];
  if (rec.kind === 'BELOW_GUARD') {
    return [
      `The best bid, ${formatUsd(rec.bestBidCents)}, is below your ${formatUsd(rec.minCutoffCents)} guard (floor and max discount).`,
    ];
  }
  const reasons = [
    `Highest net recovery (${formatUsd(rec.netCents)}) with the cutoff at or above ${formatUsd(rec.minCutoffCents)} (your floor and max discount).`,
  ];
  if (rec.liquidationCents !== null) {
    reasons.push(
      `${formatUsd(rec.grossCents)} gross vs ${formatUsd(rec.liquidationCents)} liquidation for the same units.`,
    );
  }
  for (const a of rec.alternatives) {
    if (a.quantity > rec.quantity && !a.withinGuard) {
      reasons.push(
        `Clearing ${a.quantity} drops the cutoff to ${formatUsd(a.cutoffCents)}, below the guard.`,
      );
    }
  }
  reasons.push('Each winner pays their own bid; no public price changes.');
  return reasons;
}
