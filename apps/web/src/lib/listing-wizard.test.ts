import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Channel3FixtureClient,
  floorBelowPublic as serverFloorBelowPublic,
  matchAtCreation,
  normalizeGtin as serverNormalizeGtin,
  searchProducts,
} from '@holdfast/core';
import { createListingRequestSchema, type CreateListingRequest } from '@holdfast/shared';
import { ApiError, createApiClient, type ApiClient, type ApiRequest } from './api';
import {
  buildCreateRequest,
  duplicateListingId,
  emptyWizard,
  estimate,
  estimateLine,
  firstInvalidStep,
  floorBelowPublic,
  floorHelper,
  hitBlock,
  ListingSubmitter,
  needsIdentifier,
  normalizeGtin,
  parseQuantity,
  searchQuery,
  validatePricing,
  validateProduct,
  validateWindow,
  type ProductSearchHit,
  type WizardValues,
} from './listing-wizard';

const hit = (over: Partial<ProductSearchHit> = {}): ProductSearchHit => ({
  channel3Id: 'r4bivjG',
  variant: 'Color=Green',
  variantLabel: 'Green',
  title: 'JBL Tune 770NC',
  brandName: 'JBL',
  gtin: null,
  mpn: null,
  imageUrl: null,
  bestPublicPriceCents: 27900,
  offerCount: 4,
  condition: 'NEW',
  brandMatch: true,
  ...over,
});

const filled = (over: Partial<WizardValues> = {}): WizardValues => ({
  ...emptyWizard(),
  hit: hit(),
  mpn: 'JBLT770NCGRN',
  quantity: '300',
  floor: '199',
  liquidation: '80',
  windowHours: 48,
  ...over,
});

/** The Aurel A7 the ticket's manual test creates (D15: fictional, so never in Channel3). */
const aurelA7 = (over: Partial<WizardValues> = {}): WizardValues => ({
  ...emptyWizard(),
  manual: true,
  title: 'Aurel A7 Midnight',
  gtin: '0012345678905',
  quantity: '240',
  floor: '199',
  liquidation: '80',
  windowHours: 48,
  ...over,
});

describe('Step 1: search and product pick', () => {
  it('searches from 3 characters, trimmed', () => {
    expect(searchQuery('  ')).toBeNull();
    expect(searchQuery('jb')).toBeNull();
    expect(searchQuery(' jb ')).toBeNull();
    expect(searchQuery(' jbl ')).toBe('jbl');
  });

  it('only NEW products of the verified brand can be selected', () => {
    expect(hitBlock(hit())).toBeNull();
    expect(hitBlock(hit({ brandMatch: false }))).toBe('NOT_YOUR_BRAND');
    expect(hitBlock(hit({ brandMatch: null }))).toBe('NOT_YOUR_BRAND');
    expect(hitBlock(hit({ condition: 'USED' }))).toBe('NOT_NEW');
    expect(validateProduct(filled({ hit: hit({ brandMatch: false }) })).product).toMatch(
      /Not your brand/,
    );
  });

  it('wrong-brand hits from the real search proxy are blocked (recorded Channel3 fixtures)', async () => {
    const client = new Channel3FixtureClient();
    const q = 'wireless noise cancelling over-ear headphones';
    // Aurel is fictional (D15): nothing in the comparison search is the brand's own.
    const asAurel = await searchProducts(client, q, { brandName: 'Aurel Audio (demo)' });
    expect(asAurel.length).toBeGreaterThan(0);
    for (const r of asAurel) expect(hitBlock(r)).toBe('NOT_YOUR_BRAND');

    // A real brand sees its own products selectable and everyone else's blocked, and the
    // client's verdict agrees with the server's creation gate on every hit.
    const brand = asAurel.find((r) => r.brandName)!.brandName!;
    const asBrand = await searchProducts(client, q, { brandName: brand });
    expect(asBrand.some((r) => hitBlock(r) === null)).toBe(true);
    expect(asBrand.some((r) => hitBlock(r) === 'NOT_YOUR_BRAND')).toBe(true);
    for (const r of asBrand) {
      const product = await client.product(r.channel3Id);
      const server = matchAtCreation({ brandName: brand, product, entered: { mpn: 'X1' } });
      const serverBlocks = !server.ok && ['BRAND_MISMATCH', 'NOT_NEW'].includes(server.reason);
      expect(hitBlock(r) !== null, r.title).toBe(serverBlocks);
    }
  });

  it('asks for a GTIN or MPN when the catalogue has neither (Channel3 usually does not)', () => {
    expect(needsIdentifier(filled())).toBe(true);
    expect(needsIdentifier(filled({ hit: hit({ gtin: '0012345678905' }) }))).toBe(false);
    expect(validateProduct(filled({ mpn: '' })).gtin).toMatch(/GTIN or MPN/);
    expect(validateProduct(filled())).toEqual({});
    expect(validateProduct(filled({ mpn: '', hit: hit({ mpn: 'A1' }) }))).toEqual({});
  });

  it('a GTIN typed for an earlier pick is not sent with a hit the catalogue identifies', () => {
    // Typed in manual mode (here an invalid one), then the brand searches and picks a hit with a GTIN.
    const identified = hit({ channel3Id: 'Ft39C5h', variant: null, gtin: '0012345678905' });
    const fromManual = aurelA7({
      manual: false,
      hit: identified,
      gtin: '0012345678904',
      mpn: 'A7',
    });
    expect(validateProduct(fromManual)).toEqual({});
    const body = buildCreateRequest(fromManual)!;
    expect(body).toMatchObject({ channel3Id: 'Ft39C5h', variant: null });
    expect(body).not.toHaveProperty('gtin');
    expect(body).not.toHaveProperty('mpn');

    // Typed for a hit without identifiers, then the brand switches to one with an MPN.
    const switched = filled({
      hit: hit({ channel3Id: '29C6zIk', mpn: 'JBL-1' }),
      gtin: '96385074',
    });
    expect(buildCreateRequest(switched)).not.toHaveProperty('gtin');
    expect(buildCreateRequest(switched)).not.toHaveProperty('mpn');

    // Back to a hit without identifiers: the typed values count again.
    expect(buildCreateRequest({ ...switched, hit: hit() })).toMatchObject({
      gtin: '96385074',
      mpn: 'JBLT770NCGRN',
    });
  });

  it('manual entry needs a title and a valid identifier', () => {
    expect(validateProduct(aurelA7())).toEqual({});
    expect(validateProduct(aurelA7({ title: ' ' })).title).toBeDefined();
    expect(validateProduct(aurelA7({ gtin: '' })).gtin).toMatch(/GTIN or MPN/);
    expect(validateProduct(aurelA7({ gtin: '', mpn: 'A7-MID' }))).toEqual({});
    expect(validateProduct(aurelA7({ gtin: '0012345678904' })).gtin).toMatch(/check digit/);
  });

  it('GTIN check digit mirrors the server', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.stringMatching(/^\d{6,15}$/),
          fc.stringMatching(/^[\d -]{8,18}$/),
          fc.string({ maxLength: 16 }),
        ),
        (raw) => {
          expect(normalizeGtin(raw)).toBe(serverNormalizeGtin(raw));
        },
      ),
      { numRuns: 2000 },
    );
    // Valid GTINs of every length, checked both ways.
    for (const g of ['96385074', '036000291452', '0012345678905', '10012345678902']) {
      expect(normalizeGtin(g)).toBe(g);
      expect(serverNormalizeGtin(g)).toBe(g);
    }
  });
});

describe('Step 2: quantity and price', () => {
  it('blocks a floor at or above the public low', () => {
    expect(validatePricing(filled({ floor: '279' })).floor).toMatch(
      /No one will bid above a cheaper store/,
    );
    expect(validatePricing(filled({ floor: '300' })).floor).toBeDefined();
    expect(validatePricing(filled({ floor: '278.99' })).floor).toBeUndefined();
  });

  it('skips the floor check when the public price is unknown (price watch off)', () => {
    expect(
      validatePricing(filled({ floor: '5000', hit: hit({ bestPublicPriceCents: null }) })),
    ).toEqual({});
    expect(validatePricing(aurelA7({ floor: '5000' }))).toEqual({});
    expect(floorHelper(null)).toMatch(/price watch is off/);
    expect(floorHelper(27900)).toBe(
      'Cheapest public price $279. Floor is private; shoppers never see it.',
    );
  });

  it('floor rule mirrors the server', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.option(fc.integer({ min: 100, max: 1_000_000 })),
        (floor, low) => {
          expect(floorBelowPublic(floor, low)).toBe(serverFloorBelowPublic(floor, low));
        },
      ),
    );
  });

  it('quantity is a whole number of at least 1', () => {
    expect(parseQuantity('1,200')).toBe(1200);
    expect(parseQuantity('2.5')).toBeNull();
    expect(validatePricing(filled({ quantity: '0' })).quantity).toBeDefined();
    expect(validatePricing(filled({ quantity: '-3' })).quantity).toBeDefined();
    expect(validatePricing(filled({ quantity: '100001' })).quantity).toBeDefined();
    expect(validatePricing(filled({ quantity: '1' })).quantity).toBeUndefined();
  });

  it('floor must be a valid amount and the liquidation quote is required', () => {
    expect(validatePricing(filled({ floor: '' })).floor).toBeDefined();
    expect(validatePricing(filled({ floor: '0.50' })).floor).toMatch(/between/);
    expect(validatePricing(filled({ liquidation: '' })).liquidation).toBeDefined();
    expect(validatePricing(filled({ liquidation: '0' })).liquidation).toBeUndefined();
  });
});

describe('Step 3: window', () => {
  it('only 24 h or 48 h can be chosen, like the API', () => {
    expect(validateWindow(filled({ windowHours: 24 }))).toEqual({});
    expect(validateWindow(filled({ windowHours: 48 }))).toEqual({});
    for (const h of [0, 12, 36, 72, 96]) {
      const v = filled({ windowHours: h as 24 });
      expect(validateWindow(v).windowHours).toBeDefined();
      expect(buildCreateRequest(v)).toBeNull();
      expect(
        createListingRequestSchema.safeParse({ ...buildCreateRequest(filled()), windowHours: h })
          .success,
      ).toBe(false);
    }
  });
});

describe('Step 4: review and request', () => {
  it('estimate: 60% of quantity at the floor vs the liquidation quote', () => {
    const e = estimate(300, 19900, 8000);
    expect(e).toEqual({
      units: 180,
      holdfastCents: 3_582_000,
      liquidationCents: 1_440_000,
      upliftCents: 2_142_000,
    });
    expect(estimateLine(e)).toBe(
      'If 60% of quantity clears at the floor: $35,820 vs $14,400 liquidation.',
    );
    expect(estimate(1, 19900, 8000).units).toBe(0);
  });

  it('builds the API body for a picked product', () => {
    expect(buildCreateRequest(filled())).toEqual({
      channel3Id: 'r4bivjG',
      variant: 'Color=Green',
      mpn: 'JBLT770NCGRN',
      quantity: 300,
      floorCents: 19900,
      liquidationQuoteCents: 8000,
      windowHours: 48,
    });
  });

  it('builds a manual Aurel A7 body (no Channel3 id)', () => {
    expect(buildCreateRequest(aurelA7({ gtin: '0012-3456-78905' }))).toEqual({
      title: 'Aurel A7 Midnight',
      gtin: '0012345678905',
      quantity: 240,
      floorCents: 19900,
      liquidationQuoteCents: 8000,
      windowHours: 48,
    });
  });

  it('reports the first invalid step', () => {
    expect(firstInvalidStep(filled())).toBeNull();
    expect(firstInvalidStep(filled({ hit: null }))).toBe(0);
    expect(firstInvalidStep(filled({ floor: '400' }))).toBe(1);
  });

  it('whatever the client accepts, the server schema accepts', () => {
    const values = fc.record({
      manual: fc.boolean(),
      title: fc.oneof(fc.constant(''), fc.string({ maxLength: 220 })),
      gtin: fc.constantFrom('', '0012345678905', '0012345678904', '96385074', 'abc'),
      mpn: fc.oneof(fc.constant(''), fc.string({ maxLength: 80 })),
      quantity: fc.oneof(
        fc.integer({ min: -5, max: 200_000 }).map(String),
        fc.string({ maxLength: 6 }),
      ),
      floor: fc.oneof(
        fc.integer({ min: 0, max: 2_000_000 }).map((c) => (c / 100).toFixed(2)),
        fc.string({ maxLength: 6 }),
      ),
      liquidation: fc.oneof(
        fc.integer({ min: 0, max: 200_000_000 }).map((c) => (c / 100).toFixed(2)),
        fc.string({ maxLength: 6 }),
      ),
      windowHours: fc.constantFrom(12, 24, 48, 72),
      low: fc.option(fc.integer({ min: 100, max: 1_000_000 })),
      brandMatch: fc.constantFrom(true, false, null),
    });
    fc.assert(
      fc.property(values, ({ low, brandMatch, ...v }) => {
        const form = {
          ...emptyWizard(),
          ...v,
          windowHours: v.windowHours as 24,
          hit: v.manual ? null : hit({ bestPublicPriceCents: low, brandMatch }),
        };
        const body: CreateListingRequest | null = buildCreateRequest(form);
        if (!body) return;
        expect(createListingRequestSchema.safeParse(body).success).toBe(true);
        expect(serverFloorBelowPublic(body.floorCents, v.manual ? null : low)).toBe(true);
        expect(body.mpn?.trim() || body.gtin).toBeTruthy();
        if (body.gtin) expect(serverNormalizeGtin(body.gtin)).toBe(body.gtin);
      }),
      { numRuns: 1000 },
    );
  });
});

// --- Submit (Save draft / Publish) ---------------------------------------------------------------

interface Call {
  path: string;
  key: string | undefined;
  body: unknown;
}

/** In-memory API that mimics the idempotency layer: one draft per key, replayed on reuse. */
function fakeApi(opts: { failNext?: (path: string) => ApiError | null } = {}) {
  const calls: Call[] = [];
  const drafts = new Map<string, string>();
  let created = 0;
  const client: ApiClient = {
    async request<T>(req: ApiRequest, key?: string): Promise<T> {
      calls.push({ path: req.path, key, body: req.body });
      await new Promise((r) => setTimeout(r, 5));
      const err = opts.failNext?.(req.path);
      if (err) throw err;
      if (req.path === '/api/listings') {
        let id = drafts.get(key!);
        if (!id) drafts.set(key!, (id = `listing-${++created}`));
        return { listingId: id, status: 'DRAFT', slug: `aurel-a7-${id}` } as T;
      }
      const id = req.path.split('/')[3]!;
      return {
        listingId: id,
        status: 'OPEN',
        slug: `aurel-a7-${id}`,
        offerPath: `/o/aurel-a7-${id}`,
      } as T;
    },
  };
  return { client, calls, drafts: () => created };
}

let k = 0;
const mint = () => `key-${++k}`;

describe('ListingSubmitter', () => {
  const body = buildCreateRequest(aurelA7())!;

  it('double-click on Publish creates one listing and publishes once', async () => {
    const api = fakeApi();
    const s = new ListingSubmitter(api.client, mint);
    const [a, b] = await Promise.all([s.publish(body), s.publish(body)]);
    expect(a).toBe(b);
    expect(api.drafts()).toBe(1);
    expect(api.calls.map((c) => c.path)).toEqual([
      '/api/listings',
      `/api/listings/${a.draft.listingId}/publish`,
    ]);
  });

  it('a retry after a lost response reuses the session key, so the server replays the draft', async () => {
    let fail = true;
    const api = fakeApi({
      failNext: (p) => {
        if (p !== '/api/listings' || !fail) return null;
        fail = false;
        return new ApiError(503, 'HTTP_503', 'Unavailable');
      },
    });
    const s = new ListingSubmitter(api.client, mint);
    await expect(s.publish(body)).rejects.toThrow('Unavailable');
    const out = await s.publish(body);
    const creates = api.calls.filter((c) => c.path === '/api/listings');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.key).toBe(creates[1]!.key);
    expect(api.drafts()).toBe(1);
    expect(out.published.status).toBe('OPEN');
  });

  it('Save draft then Publish reuses the draft', async () => {
    const api = fakeApi();
    const s = new ListingSubmitter(api.client, mint);
    const draft = await s.saveDraft(body);
    const out = await s.publish(body);
    expect(out.draft).toEqual(draft);
    expect(api.calls.filter((c) => c.path === '/api/listings')).toHaveLength(1);
  });

  it('a refused publish (unverified brand) keeps the draft; publishing again does not re-create', async () => {
    let refuse = true;
    const api = fakeApi({
      failNext: (p) =>
        p.endsWith('/publish') && refuse
          ? ((refuse = false), new ApiError(403, 'BRAND_NOT_VERIFIED', 'Not verified'))
          : null,
    });
    const s = new ListingSubmitter(api.client, mint);
    await expect(s.publish(body)).rejects.toMatchObject({ code: 'BRAND_NOT_VERIFIED' });
    expect(s.currentDraft?.listingId).toBe('listing-1');
    await s.publish(body);
    expect(api.drafts()).toBe(1);
    const publishes = api.calls.filter((c) => c.path.endsWith('/publish'));
    // A terminal 4xx is stored under its key, so the next attempt is a new action with a new key.
    expect(publishes[0]!.key).not.toBe(publishes[1]!.key);
  });

  it('editing the listing after a draft exists creates a new draft under a new key', async () => {
    const api = fakeApi();
    const s = new ListingSubmitter(api.client, mint);
    await s.saveDraft(body);
    await s.saveDraft({ ...body, quantity: 250 });
    const creates = api.calls.filter((c) => c.path === '/api/listings');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.key).not.toBe(creates[1]!.key);
  });
});

describe('DUPLICATE → "Open the live listing"', () => {
  const existingListingId = '7d1f3c4e-2b8a-4e7f-9c11-0a5b6d7e8f90';
  const live = [
    { listingId: 'other-live', status: 'OPEN', product: { productId: 'p-2' } },
    { listingId: 'same-draft', status: 'DRAFT', product: { productId: 'p-1' } },
    { listingId: 'same-live', status: 'ROUNDS', product: { productId: 'p-1' } },
  ];

  it('uses existingListingId from the create 409, before any draft exists', async () => {
    // The body the API sends (`listingErrorResponse` → core `errorBody`): details are flattened.
    const client = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'DUPLICATE',
              message: 'This product already has a live listing.',
              existingListingId,
              existingSlug: 'aurel-a7-midnight-ca3a',
              link: `/brand/listings/${existingListingId}`,
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const s = new ListingSubmitter(client, mint);
    const err = await s.publish(buildCreateRequest(aurelA7())!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(s.currentDraft).toBeNull();
    expect(duplicateListingId(err as ApiError, [], s.currentDraft?.productId)).toBe(
      existingListingId,
    );
  });

  it('falls back to a live listing of the same product, then to null', () => {
    const dup = (details: Record<string, unknown>) =>
      new ApiError(409, 'DUPLICATE', 'dup', details);
    expect(duplicateListingId(dup({ existingListingId }), live, 'p-1')).toBe(existingListingId);
    expect(duplicateListingId(dup({ existingListingId: 42 }), live, 'p-1')).toBe('same-live');
    expect(duplicateListingId(dup({}), live, 'p-1')).toBe('same-live');
    expect(duplicateListingId(dup({}), live, null)).toBeNull();
    expect(duplicateListingId(dup({}), live, 'p-9')).toBeNull();
    expect(
      duplicateListingId(
        new ApiError(409, 'STATE_CONFLICT', 'x', { existingListingId }),
        live,
        'p-1',
      ),
    ).toBeNull();
  });
});
