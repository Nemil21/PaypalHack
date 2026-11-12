import { readFileSync } from 'node:fs';
import { MCP_TOOL_DOCS } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import { allDocsCopy, docsNav, docsReference, docsSections } from './docs';

/** Same uniform-price phrases the landing test bans (D14: pay-your-bid). */
const UNIFORM_PRICE = [
  /one fair price/i,
  /same (clearing )?price/i,
  /clearing price/i,
  /single price/i,
  /uniform/i,
  /everyone pays/i,
];

describe('docs copy (v4 Docs, frame 107:137)', () => {
  it('has no uniform-price copy, in the data or in the page markup', () => {
    const page = readFileSync(new URL('../routes/Docs.tsx', import.meta.url), 'utf8');
    for (const text of [...allDocsCopy(), page]) {
      for (const re of UNIFORM_PRICE)
        expect(text, `${re} in "${text.slice(0, 80)}"`).not.toMatch(re);
    }
  });

  it('every sidebar link has a section to land on', () => {
    const ids = new Set([
      'connect-an-agent',
      ...docsSections.map((s) => s.id),
      'mcp-tools',
      'rest-api',
      'webhooks',
    ]);
    for (const l of docsNav.flatMap((g) => g.links)) expect(ids, l.id).toContain(l.id);
  });

  it('says brand API keys and outbound webhooks are not available (decision 4)', () => {
    expect(docsReference.rest.paragraphs.join(' ')).toContain(
      'Brand API keys aren’t available yet',
    );
    expect(docsReference.webhooks.paragraphs.join(' ')).toContain('aren’t available yet');
  });

  it('lists every MCP tool', () => {
    expect(docsReference.mcp.tools.map((t) => t.name)).toEqual(MCP_TOOL_DOCS.map((t) => t.name));
  });
});
