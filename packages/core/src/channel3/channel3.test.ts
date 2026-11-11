import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { loadConfig } from '../config.js';
import {
  Channel3FixtureClient,
  Channel3RestClient,
  createChannel3Client,
  type Channel3LogEntry,
} from './client.js';
import { Channel3Error } from './errors.js';
import { priceToCents, priceToCentsOrNull } from './money.js';
import {
  bestOffer,
  brandMatches,
  identifiersOf,
  normalizeGtin,
  parseVariantKey,
  sameVariant,
  variantKey,
  variantLabel,
} from './product.js';
import { searchProducts, toSearchResult } from './search.js';

describe('priceToCents', () => {
  it.each([
    [279.99, 27999],
    [0.1 + 0.2, 30],
    [0.07, 7],
    [1.15, 115],
    [4.35, 435],
    [19.99, 1999],
    [298, 29800],
    [0, 0],
    [1234567.89, 123456789],
  ])('%s → %i cents', (price, cents) => {
    expect(priceToCents(price)).toBe(cents);
  });

  it('every two-decimal price round-trips exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (cents) => {
        expect(priceToCents(cents / 100)).toBe(cents);
      }),
    );
  });

  it.each([NaN, Infinity, -0.01])('rejects %s', (bad) => {
    expect(() => priceToCents(bad)).toThrow(RangeError);
    expect(priceToCentsOrNull(bad)).toBeNull();
  });
  it('null for a missing price', () => expect(priceToCentsOrNull(undefined)).toBeNull());
});

describe('product helpers', () => {
  it('variant key is stable, sorted and reversible', () => {
    const key = variantKey([
      { name: 'Size', label: 'XL' },
      { name: 'Color', label: 'Black' },
    ]);
    expect(key).toBe('Color=Black;Size=XL');
    expect(parseVariantKey(key)).toEqual([
      { name: 'Color', label: 'Black' },
      { name: 'Size', label: 'XL' },
    ]);
    expect(variantLabel(key)).toBe('Black / XL');
    expect(variantKey([])).toBeNull();
    expect(sameVariant('Size=XL;Color=Black', 'color=black;size=xl')).toBe(true);
    expect(sameVariant(null, '')).toBe(true);
  });

  it('GTIN check digits', () => {
    expect(normalizeGtin('0012345678905')).toBe('0012345678905');
    expect(normalizeGtin('4006381333931')).toBe('4006381333931');
    expect(normalizeGtin('96385074')).toBe('96385074');
    expect(normalizeGtin('012345678905')).toBe('012345678905');
    expect(normalizeGtin('4006381333932')).toBeNull();
    expect(normalizeGtin('12345')).toBeNull();
  });

  it('identifiers from structured_attributes under several handle spellings', () => {
    expect(
      identifiersOf({ structured_attributes: { UPC: ['012345678905'], 'model-number': ['WH-1'] } }),
    ).toEqual({
      gtin: '012345678905',
      mpn: 'WH-1',
    });
    expect(
      identifiersOf({ structured_attributes: { 'headphone-style': ['Closed-back'] } }),
    ).toEqual({
      gtin: null,
      mpn: null,
    });
  });

  it('brand fuzzy match', () => {
    expect(brandMatches('Aurel Audio', 'aurel')).toBe(true);
    expect(brandMatches('Aurel Audio, Inc.', 'Aurel Audio')).toBe(true);
    expect(brandMatches('JBL', 'HARMAN')).toBe(false);
    expect(brandMatches('', 'Aurel')).toBe(false);
  });

  it('best offer: cheapest new, in-stock USD, optionally allowlisted', () => {
    const o = (domain: string, price: number, extra: object = {}) => ({
      url: `https://buy/${domain}`,
      domain,
      price: { price, currency: 'USD' },
      availability: 'InStock',
      condition: 'new',
      ...extra,
    });
    const offers = [
      o('a.com', 250),
      o('b.com', 199, { condition: 'used' }),
      o('c.com', 150, { availability: 'OutOfStock' }),
      o('d.com', 140, { price: { price: 140, currency: 'CAD' } }),
      o('e.com', 230),
    ];
    expect(bestOffer(offers)).toEqual({
      domain: 'e.com',
      priceCents: 23000,
      url: 'https://buy/e.com',
    });
    expect(bestOffer(offers, { domains: ['A.com'] })?.domain).toBe('a.com');
    expect(bestOffer(offers, { domains: [] })).toBeNull();
  });
});

describe('Channel3RestClient', () => {
  const KEY = 'c3_test_key_should_never_be_logged';
  function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const log: Channel3LogEntry[] = [];
    const calls: { url: string; init: RequestInit }[] = [];
    const c = new Channel3RestClient({
      apiKey: KEY,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond(url, init);
      }) as unknown as typeof fetch,
      logger: (e) => log.push(e),
      timeoutMs: 50,
    });
    return { c, log, calls };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('search posts the query with the key header and clamps the limit', async () => {
    const { c, calls, log } = client(() =>
      json({ products: [{ id: 'p1', title: 'T' }], next_page_token: null }),
    );
    const res = await c.search('anc headphones', { limit: 99 });
    expect(res.products).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.trychannel3.com/v1/search');
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: 'anc headphones',
      limit: 30,
    });
    expect(log).toEqual([expect.objectContaining({ call: 'search', http: 200 })]);
    expect(JSON.stringify(log)).not.toContain(KEY);
  });

  it.each([
    [500, 'OUTAGE'],
    [503, 'OUTAGE'],
    [429, 'OUTAGE'],
    [401, 'AUTH'],
    [402, 'AUTH'],
    [404, 'NOT_FOUND'],
    [422, 'REJECTED'],
  ])('HTTP %i → %s', async (status, kind) => {
    const { c, log } = client(() => json({ detail: 'x' }, status));
    await expect(c.product('p1')).rejects.toMatchObject({
      name: 'Channel3Error',
      kind,
      http: status,
    });
    expect(log[0]).toMatchObject({ call: 'product', http: status, error: kind });
  });

  it('network failure and timeout are outages', async () => {
    const down = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(down.c.search('x')).rejects.toMatchObject({ kind: 'OUTAGE', http: 0 });
    const slow = client(
      (_u, init) =>
        new Promise((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    await expect(slow.c.search('x')).rejects.toMatchObject({
      kind: 'OUTAGE',
      message: expect.stringMatching(/timed out/),
    });
  });

  it('a body without products is a bad response', async () => {
    const { c } = client(() => json({ nope: true }));
    await expect(c.search('x')).rejects.toMatchObject({ kind: 'BAD_RESPONSE' });
  });

  it('subscribe sends product, selection, domains and events; caps domains at 25', async () => {
    const { c, calls } = client(() =>
      json({ subscription_id: 'sub_1', product_id: 'p1', domains: ['a.com'], status: 'active' }),
    );
    const sub = await c.subscribe({
      productId: 'p1',
      selection: [{ name: 'Color', label: 'Green' }],
      domains: ['a.com'],
    });
    expect(sub).toEqual({
      subscriptionId: 'sub_1',
      productId: 'p1',
      domains: ['a.com'],
      status: 'active',
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      product_id: 'p1',
      events: ['offer.price.changed', 'offer.availability.changed'],
      domains: ['a.com'],
      selection: [{ name: 'Color', label: 'Green' }],
    });
    const many = Array.from({ length: 26 }, (_, i) => `d${i}.com`);
    await expect(c.subscribe({ productId: 'p1', selection: null, domains: many })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('createChannel3Client', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost/x',
    SESSION_SECRET: 's'.repeat(40),
    PAYPAL_CLIENT_ID: 'id',
    PAYPAL_CLIENT_SECRET: 'secret',
    PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  };
  it('fixtures mode reads the recorded files', () => {
    expect(createChannel3Client(loadConfig({ ...base, CHANNEL3_MODE: 'fixtures' })).mode).toBe(
      'fixtures',
    );
  });
  it('live mode with a key is the REST client', () => {
    expect(createChannel3Client(loadConfig({ ...base, CHANNEL3_API_KEY: 'k' }))).toBeInstanceOf(
      Channel3RestClient,
    );
  });
  it('live mode without a key boots, and every call fails as UNCONFIGURED', async () => {
    const c = createChannel3Client(loadConfig(base));
    await expect(c.search('x')).rejects.toMatchObject({ kind: 'UNCONFIGURED' });
  });
});

describe('Channel3FixtureClient (recorded fixtures)', () => {
  const c = new Channel3FixtureClient();

  it('replays the three recorded searches', async () => {
    for (const q of [
      'wireless noise cancelling over-ear headphones',
      'portable bluetooth speaker waterproof',
      'true wireless noise cancelling earbuds',
    ]) {
      const res = await c.search(q);
      expect(res.products.length).toBeGreaterThan(0);
    }
  });

  it('every search hit has a recorded detail', async () => {
    const res = await c.search('wireless noise cancelling over-ear headphones');
    for (const p of res.products) expect((await c.product(p.id)).id).toBe(p.id);
  });

  it('other queries match recorded titles and brands by word; unknown words find nothing', async () => {
    expect((await c.search('JBL speaker')).products.length).toBeGreaterThan(0);
    expect((await c.search('aurel a7')).products).toEqual([]);
  });

  it('unknown ids are NOT_FOUND; path tricks are refused', async () => {
    await expect(c.product('nope')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    await expect(c.product('../search/anc-earbuds')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('subscriptions get a deterministic fake id', async () => {
    const req = {
      productId: 'r4bivjG',
      selection: [{ name: 'Color', label: 'Green' }],
      domains: ['jbl.com'],
    };
    const a = await c.subscribe(req);
    expect(a.subscriptionId).toMatch(/^sub_fixture_/);
    expect((await c.subscribe(req)).subscriptionId).toBe(a.subscriptionId);
  });

  it('injected outage', async () => {
    const f = new Channel3FixtureClient();
    f.failures.push(new Channel3Error('OUTAGE', 'down', 503));
    await expect(f.search('x')).rejects.toMatchObject({ kind: 'OUTAGE' });
    expect((await f.search('JBL')).products.length).toBeGreaterThan(0);
  });

  it('search results map to the api.md shape', async () => {
    const results = await searchProducts(c, 'wireless noise cancelling over-ear headphones', {
      brandName: 'JBL',
    });
    expect(results[0]).toEqual({
      channel3Id: expect.any(String),
      variant: expect.toSatisfy((v: unknown) => v === null || typeof v === 'string'),
      variantLabel: expect.toSatisfy((v: unknown) => v === null || typeof v === 'string'),
      title: expect.any(String),
      brandName: expect.any(String),
      gtin: null,
      mpn: null,
      imageUrl: expect.stringMatching(/^https:\/\//),
      bestPublicPriceCents: expect.any(Number),
      offerCount: expect.any(Number),
      condition: 'NEW',
      brandMatch: expect.any(Boolean),
    });
    expect(results.some((r) => r.brandMatch)).toBe(true);
    expect(results.every((r) => Number.isInteger(r.bestPublicPriceCents))).toBe(true);
  });

  it('a recorded variant product maps its selection to the variant key', async () => {
    const r = toSearchResult(await c.product('r4bivjG'));
    expect(r).toMatchObject({ variant: 'Color=Green', variantLabel: 'Green', brandMatch: null });
  });
});
