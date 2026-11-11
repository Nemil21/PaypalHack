/**
 * Labelled demo fixture for the fictional brand Aurel Audio (D15: video rules forbid third-party
 * trademarks). The demo products' public anchor and the planned price drop are **fixture data**,
 * not Channel3 results; real Channel3 calls stay on screen elsewhere (wizard search, buyer agent
 * comparisons). Every merchant and domain here is a reserved `.example` name.
 *
 * Shared with the price-drop replay (HF-042a) and `demo:reset` (HF-046), which restores the
 * public anchor from here.
 */

export const FIXTURE_LABEL = 'demo fixture';

export const AUREL_BRAND = {
  name: 'Aurel Audio (demo)',
  domain: 'aurelaudio.example',
  /** Price-watch retailer allowlist (also the Channel3 subscription domains, D17). */
  authorizedDomains: ['retailer.example', 'audio-outlet.example', 'soundshop.example'],
  /** Brand agent objective: cutoff ≥ (1 − 22%) × $279 ≈ $218, so it recommends 240 at $219. */
  maxDiscountBps: 2200,
} as const;

export interface DemoProductFixture {
  key: 'A7' | 'A5';
  /** Fixture Channel3-style id (not a real Channel3 product). */
  channel3Id: string;
  title: string;
  slug: string;
  publicPriceCents: number;
  publicMerchant: string;
  publicUrl: string;
  quantity: number;
  floorCents: number;
  liquidationQuoteCents: number;
}

export const AUREL_A7: DemoProductFixture = {
  key: 'A7',
  channel3Id: 'demo-aurel-a7-midnight',
  title: 'Aurel A7 Wireless — Midnight',
  slug: 'aurel-a7',
  publicPriceCents: 27_900,
  publicMerchant: 'retailer.example',
  publicUrl: 'https://retailer.example/aurel-a7-midnight',
  quantity: 300,
  floorCents: 19_900,
  liquidationQuoteCents: 3_800,
};

export const AUREL_A5: DemoProductFixture = {
  key: 'A5',
  channel3Id: 'demo-aurel-a5-earbuds',
  title: 'Aurel A5 Wireless Earbuds',
  slug: 'aurel-a5',
  publicPriceCents: 12_900,
  publicMerchant: 'audio-outlet.example',
  publicUrl: 'https://audio-outlet.example/aurel-a5',
  quantity: 40,
  floorCents: 8_900,
  liquidationQuoteCents: 1_800,
};

/**
 * Demo beat 4 (B12, HF-042a): the replayed event drops the A7's public price to just under one
 * foreground bid (the Claude Desktop bid at $249). SIM bids above this level are seeded with
 * `release_if_cheaper = false`.
 */
export const PRICE_DROP_FIXTURE = {
  product: 'A7',
  toCents: 24_500,
  merchant: 'retailer.example',
  url: 'https://retailer.example/aurel-a7-midnight',
} as const;
