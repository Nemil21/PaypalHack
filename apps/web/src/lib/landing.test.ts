import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agentSnippets,
  allCopy,
  comparison,
  type ComparisonRow,
  compactUsd,
  DEMO_BOOK,
  footer,
  mcpPrompt,
  multiple,
  nav,
  netAfterFee,
  sponsors,
  steps,
  youtubeEmbedUrl,
} from './landing';
import { paths } from './routes';

/** The landing page plus the shared chrome it renders (nav, footer, agent code card). */
function landingSource(): string {
  return [
    '../routes/Landing.tsx',
    '../components/marketing/MarketingPage.tsx',
    '../components/marketing/AgentCodeCard.tsx',
  ]
    .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
    .join('\n');
}

/** Phrases that describe uniform-price settlement, which D14 replaced with pay-your-bid. */
const UNIFORM_PRICE = [
  /one fair price/i,
  /same (clearing )?price/i,
  /clearing price/i,
  /uniform/i,
  /everyone pays/i,
  /cleared at \$/i,
];

describe('landing copy (HF-057)', () => {
  it('has no uniform-price copy, in the data or in the page markup', () => {
    const page = landingSource();
    for (const text of [...allCopy(), page]) {
      for (const re of UNIFORM_PRICE)
        expect(text, `${re} in "${text.slice(0, 80)}"`).not.toMatch(re);
    }
  });

  it('step 3 says each winner pays their own bid, never more than their hold (D14)', () => {
    expect(steps[2].body).toContain('Every winner pays their own bid, never more than their hold.');
  });

  it('v4 nav: Sign in goes to the role chooser, Docs to /docs, Contact us to the footer', () => {
    expect(nav.signIn.to).toBe('/sign-in');
    expect(nav.docs.to).toBe('/docs');
    expect(nav.contact.href).toBe('#contact');
    expect(nav.sections.map((s) => s.label)).toEqual([
      'How it works',
      'For brands',
      'For agents',
      'Pricing',
    ]);
  });

  it('drops the v3 "Open a private window" CTA and the hackathon line everywhere', () => {
    const page = landingSource();
    for (const text of [...allCopy(), page]) {
      expect(text).not.toMatch(/open a private window/i);
      expect(text).not.toMatch(/Built for the PayPal AI Hackathon/i);
    }
    expect(footer.contact.url).toBe('https://www.linkedin.com/in/nemil-shah21/');
  });

  it('the MCP prompt points any agent at the Streamable HTTP endpoint and W19 for the token', () => {
    const p = mcpPrompt('https://holdfast.example/');
    expect(p).toContain('https://holdfast.example/mcp');
    expect(p).toContain(`https://holdfast.example${paths.developer}`);
    expect(p).toContain('Authorization: Bearer');
  });

  it('comparison bar: $11.4k liquidator vs $49.4k net after 9%', () => {
    expect(netAfterFee(DEMO_BOOK.grossCents)).toBe(4_935_840);
    const [liq, hf] = comparison() as [ComparisonRow, ComparisonRow];
    expect(compactUsd(liq.cents)).toBe('$11.4k');
    expect(compactUsd(hf.cents)).toBe('$49.4k');
    expect(hf.share).toBe(1);
    expect(liq.share).toBeCloseTo(0.231, 3);
  });

  it('For brands: the tag says 4.3× more, from comparison() numbers', () => {
    expect(multiple()).toBe('4.3× more');
  });

  it('agent code card: every client points at the same /mcp endpoint with an hf_mcp_ token', () => {
    const s = agentSnippets('https://holdfast.example');
    expect(s.claude.code).toContain('claude mcp add --transport http holdfast');
    for (const c of [s.claude, s.codex, s.opencode]) {
      expect(c.code).toContain('https://holdfast.example/mcp');
    }
    expect(s.codex.comment).toContain('hf_mcp_');
    expect(s.opencode.code).toContain('hf_mcp_');
  });

  it('credits only sponsors the product uses (README "Sponsor tools"; Bryntum per decision 1)', () => {
    expect([...sponsors]).toEqual(['PayPal', 'AG Grid', 'Channel3', 'Render', 'Bryntum']);
    expect(sponsors).not.toContain('APIMatic');
  });
});

describe('youtubeEmbedUrl', () => {
  it('turns watch and short links into a privacy-enhanced embed', () => {
    const embed = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0';
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(embed);
    expect(youtubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(embed);
    expect(youtubeEmbedUrl('https://youtube.com/embed/dQw4w9WgXcQ')).toBe(embed);
  });

  it('rejects anything else', () => {
    expect(youtubeEmbedUrl('not a url')).toBeNull();
    expect(youtubeEmbedUrl('https://vimeo.com/123456789')).toBeNull();
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=<script>')).toBeNull();
  });
});
