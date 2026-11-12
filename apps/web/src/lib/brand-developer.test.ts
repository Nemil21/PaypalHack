import { describe, expect, it } from 'vitest';
import { allBrandDeveloperCopy, BRAND_DEVELOPER, BRAND_GUIDES } from './brand-developer';

/** Section ids on `/docs` (lib/docs.ts `docsNav`, PR #103). */
const DOCS_SECTIONS = [
  'overview',
  'connect-an-agent',
  'set-a-mandate',
  'place-a-bid',
  'verify-your-domain',
  'open-a-window',
  'clear-and-get-paid',
  'mcp-tools',
  'rest-api',
  'webhooks',
];

describe('brand Developer view (decision 4)', () => {
  it('is docs only: says keys are not available and never offers to create one', () => {
    const copy = allBrandDeveloperCopy().join('\n');
    expect(BRAND_DEVELOPER.lede).toMatch(/Brand API keys aren’t available yet/);
    expect(copy).not.toMatch(/create (an )?api key|webhook secret/i);
  });

  it('never implies every winner pays the same (D14)', () => {
    expect(allBrandDeveloperCopy().join('\n')).not.toMatch(
      /clearing price|fair price|single price|same price/i,
    );
  });

  it('links every guide to a real /docs section', () => {
    for (const g of BRAND_GUIDES) {
      const [path, id] = g.to.split('#');
      expect(path).toBe('/docs');
      expect(DOCS_SECTIONS).toContain(id);
    }
  });
});
