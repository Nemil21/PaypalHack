import { describe, expect, it } from 'vitest';
import { encode } from 'uqr';
import type { BrandListingView } from '@holdfast/shared';
import {
  shareSummary,
  conversion,
  previewPath,
  qrPath,
  shareableListings,
  shareLink,
  sourceFrom,
  trackedConversion,
  widgetSnippet,
} from './embed.js';

const ORIGIN = 'https://holdfast.example';

describe('W10 embed & share (HF-055)', () => {
  it('share link carries utm_source', () => {
    expect(shareLink(ORIGIN, 'aurel-a7', 'email')).toBe(
      'https://holdfast.example/o/aurel-a7?utm_source=email',
    );
  });

  it('snippet matches features/14; data-source only when not the default', () => {
    expect(widgetSnippet(ORIGIN, 'aurel-a7', 'light')).toBe(
      '<script src="https://holdfast.example/widget.js" data-listing="aurel-a7" data-theme="light" async></script>',
    );
    expect(widgetSnippet(ORIGIN, 'aurel-a7', 'dark', 'site')).toContain(
      'data-theme="dark" data-source="site" async',
    );
  });

  it('custom sources: normalized, or a reason', () => {
    expect(sourceFrom(' Spring-Email ')).toEqual({ source: 'spring-email', error: null });
    expect(sourceFrom('').error).toMatch(/Enter a source/);
    expect(sourceFrom('a b').error).toMatch(/letters, digits/);
    expect(sourceFrom('x'.repeat(33)).source).toBeNull();
  });

  it('preview is the labelled mock store page with the theme', () => {
    expect(previewPath('aurel-a7', 'dark')).toBe(
      '/demo/aurel-store.html?listing=aurel-a7&theme=dark&source=preview',
    );
  });

  it('only published listings with a slug, live ones first, order kept otherwise', () => {
    const l = (listingId: string, status: string, slug: string | null = listingId) =>
      ({ listingId, status, slug }) as unknown as BrandListingView;
    const out = shareableListings([
      l('settled', 'SETTLED'),
      l('draft', 'DRAFT'),
      l('open', 'OPEN'),
      l('noslug', 'OPEN', null),
      l('cancelled', 'CANCELLED'),
      l('rounds', 'ROUNDS'),
    ]);
    expect(out.map((x) => x.listingId)).toEqual(['open', 'rounds', 'settled', 'cancelled']);
  });

  it('QR path draws exactly the dark modules of a real code', () => {
    const qr = encode(shareLink(ORIGIN, 'aurel-a7', 'email'), { ecc: 'M', border: 2 });
    const dark = qr.data.flat().filter(Boolean).length;
    expect(qrPath(qr.data).match(/M/g)).toHaveLength(dark);
    expect(qrPath([[true, false]])).toBe('M0 0h1v1h-1z');
  });

  it('conversion: bids over clicks, none without clicks', () => {
    expect(conversion({ clicks: 40, bids: 3 })).toBe('8%');
    expect(conversion({ clicks: 0, bids: 2 })).toBeNull();
    const row = (source: string, clicks: number, bids: number) => ({
      source,
      clicks,
      bids,
      heldCents: 0,
    });
    expect(trackedConversion([row('email', 4, 1), row('direct', 0, 3)])).toBe('25%');
    expect(trackedConversion([row('direct', 0, 3)])).toBeNull();
  });
});

describe('W06 share summary (UI-GAPS W06)', () => {
  const totals = { clicks: 12, bids: 1, heldCents: 22_900 };
  it('counts clicks and bids', () => {
    expect(shareSummary({ biddable: true, totals })).toBe(
      '12 clicks · 1 bid from shared links so far.',
    );
  });
  it('warns when the window is not taking bids', () => {
    expect(shareSummary({ biddable: false, totals })).toMatch(/not taking new bids/);
  });
});
