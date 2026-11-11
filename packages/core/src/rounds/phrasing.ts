import { formatUsd, nudgeText, type NudgeDraft } from '@holdfast/shared';

/**
 * Claude-phrased nudge text (HF-036b; features/19 §Logic 3, features/09 §Purpose, Q#26).
 *
 * One Claude call per round returns a **template with placeholders**; code fills every number.
 * The model never sees a number: not the cutoff, not any bid, and never the floor. It gets only
 * the product title and brand name. On error, an invalid template or a 5 s timeout the round
 * uses HF-036a's template text (`nudgeText`), in the same tick.
 */

/** Placeholders the model may use; `{yourBid}`, `{cutoff}` and `{suggested}` are required. */
export const NUDGE_PLACEHOLDERS = ['yourBid', 'cutoff', 'suggested', 'targetQuantity'] as const;
const REQUIRED = ['yourBid', 'cutoff', 'suggested'] as const;
const MAX_TEMPLATE_LENGTH = 240;
export const PHRASING_TIMEOUT_MS = 5_000;

export interface PhrasingContext {
  listingId: string;
  round: number;
  productTitle: string | null;
  brandName: string | null;
}

/** Returns a placeholder template, or null to use the template text. May throw. */
export type NudgePhraser = (ctx: PhrasingContext, signal: AbortSignal) => Promise<string | null>;

/**
 * A usable template: one line, at most 240 characters, the three required placeholders, no
 * unknown placeholder and **no digits or currency signs** (so the model cannot invent a number,
 * a deadline or scarcity figures; every number comes from code).
 */
export function validNudgeTemplate(template: string): boolean {
  if (!template || template.length > MAX_TEMPLATE_LENGTH || /[\r\n]/.test(template)) return false;
  const names = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
  if (names.some((n) => !(NUDGE_PLACEHOLDERS as readonly string[]).includes(n))) return false;
  if (REQUIRED.some((r) => !names.includes(r))) return false;
  const bare = template.replace(/\{[^{}]*\}/g, '');
  return !/[{}0-9$€£¥%]/.test(bare);
}

/** Fill a valid template with the draft's numbers. */
export function fillNudgeTemplate(template: string, draft: NudgeDraft): string {
  const values: Record<(typeof NUDGE_PLACEHOLDERS)[number], string> = {
    yourBid: formatUsd(draft.yourBidCents),
    cutoff: formatUsd(draft.cutoffCents),
    suggested: formatUsd(draft.suggestedCents),
    targetQuantity: String(draft.targetQuantity),
  };
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k as keyof typeof values]);
}

/** The nudge text for one draft: the round's Claude template if any, else HF-036a's template. */
export function nudgeTextFor(template: string | null, draft: NudgeDraft): string {
  return template && validNudgeTemplate(template)
    ? fillNudgeTemplate(template, draft)
    : nudgeText(draft);
}

/**
 * Ask the phraser for this round's template, bounded by `timeoutMs`. Never throws: any error, an
 * invalid template or the timeout gives null (template text).
 */
export async function roundTemplate(
  phraser: NudgePhraser | undefined,
  ctx: PhrasingContext,
  opts: { timeoutMs?: number; onError?: (err: unknown) => void } = {},
): Promise<string | null> {
  if (!phraser) return null;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, opts.timeoutMs ?? PHRASING_TIMEOUT_MS);
  });
  try {
    const template = await Promise.race([phraser(ctx, controller.signal), timeout]);
    return template && validNudgeTemplate(template) ? template : null;
  } catch (err) {
    opts.onError?.(err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Claude ---------------------------------------------------------------------------------

export const DEFAULT_NUDGE_MODEL = 'claude-haiku-5-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You write one short, friendly, honest message a brand sends to a shopper whose bid is currently below the cutoff in a live auction round.
Write a TEMPLATE, not a filled-in message. Use these placeholders exactly, with curly braces:
{yourBid} = the shopper's current bid, {cutoff} = the current lowest winning bid, {suggested} = the raise we suggest, and optionally {targetQuantity} = units the brand is selling.
Rules:
- Use {yourBid}, {cutoff} and {suggested} once each. Never write any digit, price or currency symbol yourself.
- One sentence or two, under 200 characters, plain text, no quotes, no emoji.
- Only state what the placeholders say. No invented scarcity, urgency, deadlines or claims about other shoppers.
- End by asking whether they want to raise to {suggested}.
Reply with the template only.`;

/** The exact request body sent for a context (exported for the "no numbers, no floor" test). */
export function claudeNudgeRequest(ctx: PhrasingContext, model: string): Record<string, unknown> {
  const facts = [
    ctx.productTitle ? `Product: ${ctx.productTitle}` : null,
    ctx.brandName ? `Brand: ${ctx.brandName}` : null,
  ].filter(Boolean);
  return {
    model,
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${facts.join('\n') || 'Product: this item'}\nWrite the nudge template.`,
      },
    ],
  };
}

export interface ClaudePhraserOptions {
  apiKey: string;
  model?: string;
  /** Test seam. */
  fetch?: typeof fetch;
}

/** A `NudgePhraser` backed by the Anthropic Messages API (no SDK; `fetch` only). */
export function createClaudeNudgePhraser(opts: ClaudePhraserOptions): NudgePhraser {
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? DEFAULT_NUDGE_MODEL;
  return async (ctx, signal) => {
    const res = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(claudeNudgeRequest(ctx, model)),
    });
    // Status only: the body may echo request details, and the key must never reach logs.
    if (!res.ok) throw new Error(`anthropic messages ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === 'text')?.text?.trim();
    if (!text) return null;
    return text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  };
}
