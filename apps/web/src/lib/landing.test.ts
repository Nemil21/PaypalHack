import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allCopy,
  comparison,
  type ComparisonRow,
  compactUsd,
  DEMO_BOOK,
  netAfterFee,
  PRIMARY_CTA,
  sponsors,
  steps,
  youtubeEmbedUrl,
} from './landing';
import { paths } from './routes';

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
    const page = readFileSync(new URL('../routes/Landing.tsx', import.meta.url), 'utf8');
    for (const text of [...allCopy(), page]) {
      for (const re of UNIFORM_PRICE)
        expect(text, `${re} in "${text.slice(0, 80)}"`).not.toMatch(re);
    }
  });

  it('step 3 says each winner pays their own bid, never more than their hold (D14)', () => {
    expect(steps[2].body).toContain('Every winner pays their own bid, never more than their hold.');
  });

  it('the primary CTA leads to W02 brand sign-in', () => {
    expect(PRIMARY_CTA).toEqual({ label: 'Open a private window', to: paths.brandSignIn });
    expect(paths.brandSignIn).toBe('/brand/sign-in');
  });

  it('comparison bar: $11.4k liquidator vs $49.4k net after 9%', () => {
    expect(netAfterFee(DEMO_BOOK.grossCents)).toBe(4_935_840);
    const [liq, hf] = comparison() as [ComparisonRow, ComparisonRow];
    expect(compactUsd(liq.cents)).toBe('$11.4k');
    expect(compactUsd(hf.cents)).toBe('$49.4k');
    expect(hf.share).toBe(1);
    expect(liq.share).toBeCloseTo(0.231, 3);
  });

  it('credits only sponsors the product uses (README "Sponsor tools")', () => {
    expect([...sponsors]).toEqual(['PayPal', 'AG Grid', 'Channel3', 'Render']);
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
