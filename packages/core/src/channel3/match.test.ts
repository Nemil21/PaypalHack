import { describe, expect, it } from 'vitest';
import {
  matchAtCreation,
  matchOffer,
  observeDetailOffer,
  observePriceChangedEvent,
  type CreationMatchInput,
  type ListingMatchTarget,
  type OfferObservation,
} from './match.js';
import { Channel3FixtureClient } from './client.js';
import type { Channel3PriceChangedEvent, Channel3Product } from './types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- Stage 1: listing creation -------------------------------------------------------------------

const AUREL: CreationMatchInput['product'] = {
  brands: [{ id: 'b1', name: 'Aurel Audio' }],
  offers: [
    {
      url: 'https://buy.example/a',
      domain: 'retailer.example',
      price: { price: 279.99, currency: 'USD' },
      availability: 'InStock',
      condition: 'new',
    },
  ],
  structured_attributes: { gtin: ['0012345678905'], 'manufacturer-part-number': ['A7-MID'] },
};
const NO_IDS = { ...AUREL, structured_attributes: { 'headphone-style': ['Closed-back'] } };

describe('matchAtCreation (stage 1)', () => {
  const cases: { name: string; input: CreationMatchInput; expected: unknown }[] = [
    {
      name: 'GTIN from structured_attributes',
      input: { brandName: 'Aurel Audio', product: AUREL },
      expected: {
        ok: true,
        identity: { method: 'GTIN', gtin: '0012345678905', mpn: 'A7-MID', source: 'CHANNEL3' },
      },
    },
    {
      name: 'entered GTIN equal as GTIN-14 (leading zeros)',
      input: { brandName: 'Aurel Audio', product: AUREL, entered: { gtin: '00012345678905' } },
      expected: { ok: true, identity: { method: 'GTIN', gtin: '0012345678905' } },
    },
    {
      name: 'GTIN mismatch at creation',
      input: { brandName: 'Aurel Audio', product: AUREL, entered: { gtin: '4006381333931' } },
      expected: { ok: false, reason: 'GTIN_MISMATCH' },
    },
    {
      name: 'entered GTIN with a bad check digit',
      input: { brandName: 'Aurel Audio', product: NO_IDS, entered: { gtin: '0012345678906' } },
      expected: { ok: false, reason: 'INVALID_GTIN' },
    },
    {
      name: 'MPN + brand fallback when Channel3 has no GTIN',
      input: { brandName: 'Aurel Audio', product: NO_IDS, entered: { mpn: 'A7-MID' } },
      expected: {
        ok: true,
        identity: {
          method: 'MPN_BRAND',
          gtin: null,
          mpn: 'A7-MID',
          brandName: 'Aurel Audio',
          source: 'MANUAL',
        },
      },
    },
    {
      name: 'MPN mismatch',
      input: { brandName: 'Aurel Audio', product: AUREL, entered: { mpn: 'A7-WHT' } },
      expected: { ok: false, reason: 'MPN_MISMATCH' },
    },
    {
      name: 'MPN compare ignores case and punctuation',
      input: { brandName: 'Aurel Audio', product: AUREL, entered: { mpn: 'a7 mid' } },
      expected: { ok: true, identity: { method: 'GTIN' } },
    },
    {
      name: 'neither GTIN nor MPN blocks',
      input: { brandName: 'Aurel Audio', product: NO_IDS },
      expected: { ok: false, reason: 'NO_IDENTIFIER' },
    },
    {
      name: 'wrong brand ("Not your brand")',
      input: { brandName: 'Holdfast Demo Co', product: AUREL },
      expected: { ok: false, reason: 'BRAND_MISMATCH' },
    },
    {
      name: 'brand matches fuzzily (case, suffix)',
      input: { brandName: 'AUREL Inc.', product: AUREL },
      expected: { ok: true, identity: { brandName: 'Aurel Audio' } },
    },
    {
      name: 'used-only product',
      input: {
        brandName: 'Aurel Audio',
        product: { ...AUREL, offers: AUREL!.offers!.map((o) => ({ ...o, condition: 'used' })) },
      },
      expected: { ok: false, reason: 'NOT_NEW' },
    },
    {
      name: 'Channel3 down: manual GTIN entry',
      input: { brandName: 'Aurel Audio', product: null, entered: { gtin: '0012345678905' } },
      expected: {
        ok: true,
        identity: { method: 'GTIN', source: 'MANUAL', brandName: 'Aurel Audio' },
      },
    },
    {
      name: 'Channel3 down: manual MPN + brand',
      input: { brandName: 'Aurel Audio', product: null, entered: { mpn: 'A7-MID' } },
      expected: { ok: true, identity: { method: 'MPN_BRAND', source: 'MANUAL' } },
    },
  ];
  it.each(cases)('$name', ({ input, expected }) => {
    expect(matchAtCreation(input)).toMatchObject(expected as object);
  });
});

// --- Stage 2: per offer / webhook ----------------------------------------------------------------

const TARGET: ListingMatchTarget = {
  channel3Id: 'r4bivjG',
  channel3Variant: 'Color=Green',
  authorizedDomains: ['jcpenney.com', 'JBL.com'],
};
const OFFER: OfferObservation = {
  productId: 'r4bivjG',
  selection: [{ name: 'Color', label: 'Green' }],
  domain: 'jcpenney.com',
  price: 119.99,
  currency: 'USD',
  condition: 'new',
  availability: 'InStock',
  url: 'https://buy.trychannel3.com/x',
};

describe('matchOffer (stage 2)', () => {
  const cases: {
    name: string;
    offer: Partial<OfferObservation>;
    target?: Partial<ListingMatchTarget>;
    expected: unknown;
  }[] = [
    {
      name: 'exact match',
      offer: {},
      expected: { match: true, priceCents: 11999, domain: 'jcpenney.com' },
    },
    {
      name: 'wrong product id',
      offer: { productId: 'qAGqtIS' },
      expected: { ignored: true, reason: 'PRODUCT_MISMATCH' },
    },
    {
      name: 'wrong variant',
      offer: { selection: [{ name: 'Color', label: 'Blue' }] },
      expected: { ignored: true, reason: 'VARIANT_MISMATCH' },
    },
    {
      name: 'variant missing on the offer',
      offer: { selection: null },
      expected: { ignored: true, reason: 'VARIANT_MISMATCH' },
    },
    {
      name: 'variant key, case-insensitive',
      offer: { selection: 'color=green' },
      expected: { match: true },
    },
    {
      name: 'no-variant product matches no-variant listing',
      offer: { selection: null },
      target: { channel3Variant: null },
      expected: { match: true },
    },
    {
      name: 'used offer',
      offer: { condition: 'used' },
      expected: { ignored: true, reason: 'NOT_NEW' },
    },
    {
      name: 'refurbished offer',
      offer: { condition: 'refurbished' },
      expected: { ignored: true, reason: 'NOT_NEW' },
    },
    {
      name: 'unknown condition',
      offer: { condition: null },
      expected: { ignored: true, reason: 'CONDITION_UNKNOWN' },
    },
    {
      name: 'domain not allowlisted',
      offer: { domain: 'ebay.com' },
      expected: { ignored: true, reason: 'DOMAIN_NOT_ALLOWED' },
    },
    {
      name: 'allowlist normalises case and www.',
      offer: { domain: 'www.jbl.com' },
      expected: { match: true, domain: 'jbl.com' },
    },
    {
      name: 'empty allowlist ignores everything',
      offer: {},
      target: { authorizedDomains: [] },
      expected: { ignored: true, reason: 'DOMAIN_NOT_ALLOWED' },
    },
    { name: 'non-USD', offer: { currency: 'CAD' }, expected: { ignored: true, reason: 'NOT_USD' } },
    {
      name: 'out of stock',
      offer: { availability: 'OutOfStock' },
      expected: { ignored: true, reason: 'OUT_OF_STOCK' },
    },
    {
      name: 'negative price',
      offer: { price: -1 },
      expected: { ignored: true, reason: 'INVALID_PRICE' },
    },
    {
      name: 'cents converted exactly',
      offer: { price: 279.99 },
      expected: { match: true, priceCents: 27999 },
    },
  ];
  it.each(cases)('$name', ({ offer, target, expected }) => {
    expect(matchOffer({ ...TARGET, ...target }, { ...OFFER, ...offer })).toMatchObject(
      expected as object,
    );
  });
});

// --- Gate inputs from recorded fixtures ----------------------------------------------------------

const client = new Channel3FixtureClient();
const event = (
  JSON.parse(readFileSync(join(client.dir, 'webhooks', 'offer.price.changed.json'), 'utf8')) as {
    body: Channel3PriceChangedEvent;
  }
).body;

describe('gate inputs from fixtures', () => {
  it('webhook + detail: hydrates condition from the same-domain offer and matches', async () => {
    const detail = await client.product('r4bivjG');
    const obs = observePriceChangedEvent(event, detail);
    expect(obs.condition).toBe('new');
    expect(matchOffer(TARGET, obs)).toMatchObject({ match: true, priceCents: 11999 });
  });

  it('webhook without detail is ignored (condition unknown), never voids blindly', () => {
    expect(matchOffer(TARGET, observePriceChangedEvent(event))).toMatchObject({
      ignored: true,
      reason: 'CONDITION_UNKNOWN',
    });
  });

  it('webhook with a detail for another product does not borrow its condition', async () => {
    const other = await client.product('5jesTFu');
    expect(observePriceChangedEvent(event, other).condition).toBeUndefined();
  });

  it('detail offers: used, unknown-condition and out-of-stock offers are ignored', async () => {
    const p: Channel3Product = await client.product('qE1D14e');
    const target = {
      channel3Id: p.id,
      channel3Variant: 'Color=Black',
      authorizedDomains: p.offers!.map((o) => o.domain),
    };
    const reasons = p.offers!.map((o) => {
      const m = matchOffer(target, observeDetailOffer(p, o));
      return m.match ? 'MATCH' : m.reason;
    });
    expect(reasons).toContain('MATCH');
    expect(reasons).toContain('NOT_NEW');
    expect(reasons).toContain('CONDITION_UNKNOWN');
    expect(reasons).toContain('OUT_OF_STOCK');
  });
});
