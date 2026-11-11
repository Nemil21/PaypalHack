/**
 * HF-009 `products` repository against a real, freshly migrated Postgres, with the recorded
 * Channel3 fixtures. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/channel3
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../money/test-harness.js';
import { Channel3FixtureClient } from './client.js';
import { Channel3Error } from './errors.js';
import {
  ensureProduct,
  ensureProductSubscription,
  findProduct,
  getProduct,
  identityOf,
  refreshPublicOffer,
  upsertProduct,
} from './products.js';
import { searchProducts } from './search.js';
import type { Channel3Subscription, Channel3SubscriptionRequest } from './types.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-009 products (Postgres)', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await tdb?.close();
  });
  const c3 = new Channel3FixtureClient();

  it('upsert is keyed by id + variant and only fills null identity columns', async () => {
    const p = await c3.product('r4bivjG');
    const first = await upsertProduct(tdb.db.pool, { ...identityOf(p), mpn: null });
    expect(first).toMatchObject({
      channel3Id: 'r4bivjG',
      channel3Variant: 'Color=Green',
      condition: 'NEW',
    });
    const again = await upsertProduct(tdb.db.pool, {
      ...identityOf(p),
      title: 'Changed',
      mpn: 'M-1',
    });
    expect(again.id).toBe(first.id);
    expect(again.title).toBe(p.title);
    expect(again.mpn).toBe('M-1');
    const otherVariant = await upsertProduct(tdb.db.pool, identityOf(p, 'Color=Blue'));
    expect(otherVariant.id).not.toBe(first.id);
    const noVariant = await upsertProduct(tdb.db.pool, identityOf(p, null));
    expect((await upsertProduct(tdb.db.pool, identityOf(p, null))).id).toBe(noVariant.id);
  });

  it('search caches identity but never a price', async () => {
    const results = await searchProducts(c3, 'portable bluetooth speaker waterproof', {
      db: tdb.db.pool,
    });
    const row = await findProduct(tdb.db.pool, results[0]!.channel3Id, results[0]!.variant);
    expect(row).toMatchObject({
      title: results[0]!.title,
      bestPublicPriceCents: null,
      priceUpdatedAt: null,
    });
  });

  it('ensureProduct uses the cache, else the free detail endpoint', async () => {
    const fresh = await ensureProduct(tdb.db.pool, c3, '5jesTFu');
    const flaky = new Channel3FixtureClient();
    flaky.failures.push(new Channel3Error('OUTAGE', 'down'));
    // Cached: no Channel3 call (the injected outage is not consumed).
    expect((await ensureProduct(tdb.db.pool, flaky, '5jesTFu', fresh.channel3Variant)).id).toBe(
      fresh.id,
    );
    expect(flaky.failures).toHaveLength(1);
    await expect(ensureProduct(tdb.db.pool, flaky, 'c17VkZV', null)).rejects.toMatchObject({
      kind: 'OUTAGE',
    });
  });

  it('publicOffer: refreshed when older than 10 min, allowlisted, stale on outage', async () => {
    // 5jesTFu has new offers on worldwidestereo.com ($298) and beachcamera.com, one out of stock.
    let row = (await ensureProduct(tdb.db.pool, c3, '5jesTFu'))!;
    const t0 = new Date('2026-11-11T12:00:00Z');
    const r1 = await refreshPublicOffer(tdb.db.pool, c3, row, ['worldwidestereo.com'], { now: t0 });
    expect(r1).toMatchObject({
      refreshed: true,
      stale: false,
      publicOffer: { domain: 'worldwidestereo.com', priceCents: 29800 },
    });
    row = (await getProduct(tdb.db.pool, row.id))!;
    expect(row).toMatchObject({
      bestPublicPriceCents: 29800,
      bestPublicMerchant: 'worldwidestereo.com',
    });

    const fiveMin = new Date(t0.getTime() + 5 * 60_000);
    expect(
      await refreshPublicOffer(tdb.db.pool, c3, row, ['worldwidestereo.com'], { now: fiveMin }),
    ).toMatchObject({
      refreshed: false,
      publicOffer: { priceCents: 29800 },
    });

    const down = new Channel3FixtureClient();
    down.failures.push(new Channel3Error('OUTAGE', 'down', 503));
    const later = new Date(t0.getTime() + 11 * 60_000);
    expect(
      await refreshPublicOffer(tdb.db.pool, down, row, ['worldwidestereo.com'], { now: later }),
    ).toMatchObject({
      refreshed: false,
      stale: true,
      publicOffer: { priceCents: 29800 },
    });

    // No allowlisted offer any more: the anchor goes null (not min(old, new)).
    expect(
      await refreshPublicOffer(tdb.db.pool, c3, row, ['nowhere.example'], { now: later }),
    ).toMatchObject({
      refreshed: true,
      publicOffer: null,
    });
    expect(await getProduct(tdb.db.pool, row.id)).toMatchObject({
      bestPublicPriceCents: null,
      priceUpdatedAt: later,
    });

    // An older concurrent refresh never overwrites a newer one.
    await refreshPublicOffer(tdb.db.pool, c3, row, ['worldwidestereo.com'], {
      now: new Date(later.getTime() - 1000),
    });
    expect(await getProduct(tdb.db.pool, row.id)).toMatchObject({ bestPublicPriceCents: null });
  });

  it('subscription: one per product + variant, reused, first writer wins under a race', async () => {
    const row = await ensureProduct(tdb.db.pool, c3, 'r4bivjG');
    const seen: Channel3SubscriptionRequest[] = [];
    let n = 0;
    const racing = Object.assign(new Channel3FixtureClient(), {
      async subscribe(req: Channel3SubscriptionRequest): Promise<Channel3Subscription> {
        seen.push(req);
        await new Promise((r) => setTimeout(r, 20));
        return {
          subscriptionId: `sub_${++n}`,
          productId: req.productId,
          domains: [...req.domains],
          status: 'active',
        };
      },
    });
    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureProductSubscription(tdb.db.pool, racing, row, ['jbl.com']),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    expect(seen[0]).toEqual({
      productId: 'r4bivjG',
      selection: [{ name: 'Color', label: 'Green' }],
      domains: ['jbl.com'],
    });
    const stored = (await getProduct(tdb.db.pool, row.id))!;
    expect(stored.channel3SubscriptionId).toBe(ids[0]);
    // Reused afterwards: no new Channel3 call.
    const before = seen.length;
    expect(await ensureProductSubscription(tdb.db.pool, racing, stored, ['jbl.com'])).toBe(ids[0]);
    expect(seen.length).toBe(before);
  });
});
