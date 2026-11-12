import { readFileSync } from 'node:fs';
import type { MandateView } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import { firstSentence } from '../routes/Developer';
import { allDeveloperCopy, brandDeveloper, brandGuides, mandateSummary } from './developer';
import { agentSnippets } from './landing';

const UNIFORM_PRICE = [/one fair price/i, /clearing price/i, /single price/i, /uniform/i];

describe('v4 Developer (W19, frames 113:235 / 115:184)', () => {
  it('has no uniform-price copy (D14)', () => {
    const page = readFileSync(new URL('../routes/Developer.tsx', import.meta.url), 'utf8');
    for (const text of [...allDeveloperCopy(), page])
      for (const re of UNIFORM_PRICE) expect(text).not.toMatch(re);
  });

  it('brand view is docs only: says API keys are not available and offers no key button (decision 4)', () => {
    expect(brandDeveloper.lede).toContain('Brand API keys aren’t available yet');
    const page = readFileSync(new URL('../routes/Developer.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/create api key/i);
    for (const g of brandGuides) expect(g.to).toMatch(/^\/docs#/);
  });

  it('summarises a mandate row', () => {
    const m = {
      maxPriceCents: 25_000,
      totalHoldCapCents: 60_000,
      products: [{ productId: 'p', title: 'Aurel A7', imageUrl: null, listingSlug: 'aurel-a7' }],
      expiresAt: '2026-12-01T12:00:00Z',
    } as MandateView;
    expect(mandateSummary(m)).toEqual({
      title: 'Up to $250',
      detail: 'Cap $600 · Aurel A7 · expires Dec 1',
    });
    expect(mandateSummary({ ...m, products: [], expiresAt: null }).detail).toBe(
      'Cap $600 · Any product',
    );
  });

  it('shows the first sentence of a live tool description', () => {
    expect(firstSentence('Places a real PayPal hold. If you win, you pay it.')).toBe(
      'Places a real PayPal hold.',
    );
    expect(firstSentence('No full stop')).toBe('No full stop');
  });

  it('a just-created token fills every client snippet', () => {
    const s = agentSnippets('https://h.example', 'hf_mcp_abc123');
    expect(s.claude.code).toContain('Bearer hf_mcp_abc123');
    expect(s.codex.comment).toContain('HOLDFAST_MCP_TOKEN=hf_mcp_abc123');
    expect(s.opencode.code).toContain('Bearer hf_mcp_abc123');
  });
});
