import { nudgeText, type NudgeDraft } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import {
  claudeNudgeRequest,
  createClaudeNudgePhraser,
  fillNudgeTemplate,
  nudgeTextFor,
  roundTemplate,
  validNudgeTemplate,
  type PhrasingContext,
} from './phrasing.js';

const draft: NudgeDraft = {
  bidId: 'b1',
  shopperId: 's1',
  isSimulated: false,
  cutoffCents: 24_000,
  yourBidCents: 21_900,
  targetQuantity: 240,
  roundEndsAt: null,
  suggestedCents: 24_240,
};
const ctx: PhrasingContext = {
  listingId: 'l1',
  round: 2,
  productTitle: 'Aurel One headphones',
  brandName: 'Aurel Audio',
};
const GOOD = 'Your {yourBid} bid is just under the {cutoff} cutoff. Want to raise to {suggested}?';

describe('nudge templates', () => {
  it('accepts a template with the three required placeholders and no numbers', () => {
    expect(validNudgeTemplate(GOOD)).toBe(true);
    expect(validNudgeTemplate(`${GOOD} {targetQuantity} units are on offer.`)).toBe(true);
  });

  it.each([
    ['missing {suggested}', 'Your {yourBid} bid is under {cutoff}.'],
    ['an unknown placeholder', `${GOOD} {floor}`],
    ['a digit', `${GOOD} Only 3 left!`],
    ['a currency sign', 'Raise from {yourBid} past {cutoff} to {suggested}, just $1 more.'],
    ['a newline', `${GOOD}\nThanks`],
    ['a stray brace', `${GOOD} }`],
    ['too long', `${GOOD} ${'a'.repeat(240)}`],
    ['empty', ''],
  ])('rejects %s', (_n, t) => {
    expect(validNudgeTemplate(t)).toBe(false);
  });

  it('fills every number from code', () => {
    expect(fillNudgeTemplate(`${GOOD} {targetQuantity} units.`, draft)).toBe(
      'Your $219 bid is just under the $240 cutoff. Want to raise to $242.40? 240 units.',
    );
  });

  it('falls back to the HF-036a template text without a valid template', () => {
    expect(nudgeTextFor(null, draft)).toBe(nudgeText(draft));
    expect(nudgeTextFor('Hurry, 2 left at {cutoff}!', draft)).toBe(nudgeText(draft));
  });
});

describe('roundTemplate', () => {
  it('returns a valid Claude template', async () => {
    expect(await roundTemplate(async () => GOOD, ctx)).toBe(GOOD);
  });

  it('error, invalid output or no phraser → null (template text)', async () => {
    const errors: unknown[] = [];
    expect(
      await roundTemplate(
        async () => {
          throw new Error('down');
        },
        ctx,
        { onError: (e) => errors.push(e) },
      ),
    ).toBeNull();
    expect(errors).toHaveLength(1);
    expect(await roundTemplate(async () => 'Raise to 250 dollars', ctx)).toBeNull();
    expect(await roundTemplate(undefined, ctx)).toBeNull();
  });

  it('times out (5 s by default) and aborts the call', async () => {
    let aborted = false;
    const started = Date.now();
    const t = await roundTemplate(
      (_c, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          setTimeout(() => resolve(GOOD), 10_000).unref();
        }),
      ctx,
      { timeoutMs: 50 },
    );
    expect(t).toBeNull();
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('createClaudeNudgePhraser', () => {
  it('sends no numbers (so never the floor) and returns the template text', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: `"${GOOD}"` }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const phraser = createClaudeNudgePhraser({ apiKey: 'k', fetch: fakeFetch });
    expect(await phraser(ctx, new AbortController().signal)).toBe(GOOD);
    const body = String(sent[0]!.init.body);
    const userContent = JSON.stringify(
      (claudeNudgeRequest(ctx, 'm').messages as { content: string }[])[0]!.content,
    );
    expect(body).toContain('Aurel One headphones');
    expect(userContent).not.toMatch(/[0-9]/);
    expect(body).not.toMatch(/floor/i);
  });

  it('throws on a non-2xx response (the caller falls back)', async () => {
    const fakeFetch = (async () => new Response('{}', { status: 529 })) as unknown as typeof fetch;
    const phraser = createClaudeNudgePhraser({ apiKey: 'k', fetch: fakeFetch });
    await expect(phraser(ctx, new AbortController().signal)).rejects.toThrow('529');
  });
});
