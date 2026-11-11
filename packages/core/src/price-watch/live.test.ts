/**
 * HF-042b tests: the Channel3-outage banner (`probeChannel3` / `syncPriceWatchPause`) and the
 * nightly poll (`pollPublicPrices`), on real Postgres with the `FakePayPal` stub. The live webhook
 * route is covered in apps/api/src/routes/channel3-webhook.test.ts. The DB part needs
 * TEST_DATABASE_URL; it is skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/price-watch
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { placeBid } from '../bids.js';
import { Channel3FixtureClient } from '../channel3/client.js';
import { Channel3Error } from '../channel3/errors.js';
import type { Channel3Product } from '../channel3/types.js';
import type { Db } from '../db.js';
import { loadBook } from '../listings/book.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { voidKey } from '../money/void.js';
import { loadOffer } from '../offers/offer.js';
import { FakePayPal } from '../paypal/fake.js';
import type { PayPalClient } from '../paypal/types.js';
import {
  isChannel3Down,
  probeChannel3,
  readChannel3Health,
  recordChannel3Event,
  syncPriceWatchPause,
  type Channel3Health,
} from './health.js';
import { pollPublicPrices } from './poll.js';
import { reprocessPriceEvents, type PriceWatchDeps } from './process.js';

// ---------------------------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------------------------

describe('HF-042b outage rule', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const h = (cols: Partial<Channel3Health>): Channel3Health => ({
    lastOkAt: null,
    lastEventAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastError: null,
    outageSince: null,
    now,
    ...cols,
  });
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);

  it('three failures in a row → down; two → up', () => {
    expect(isChannel3Down(h({ consecutiveFailures: 3, lastOkAt: ago(1) }))).toBe(true);
    expect(isChannel3Down(h({ consecutiveFailures: 2, lastOkAt: ago(1) }))).toBe(false);
  });
  it('no contact (call or delivery) for the window → down', () => {
    expect(isChannel3Down(h({ lastOkAt: ago(31) }))).toBe(true);
    expect(isChannel3Down(h({ lastOkAt: ago(31), lastEventAt: ago(2) }))).toBe(false);
    expect(isChannel3Down(h({ lastOkAt: ago(29) }))).toBe(false);
  });
  it('never in contact (fresh database) is not an outage by itself', () => {
    expect(isChannel3Down(h({}))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Integration (FakePayPal)
// ---------------------------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)(
  'HF-042b outage banner and nightly poll (FakePayPal)',
  { timeout: 60_000 },
  () => {
    let t: TestDatabase;
    let db: Db;
    let fake: FakePayPal;
    let client: PayPalClient;
    let mark = 0;

    const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await db.pool.query(sql, params)).rows[0] as T;

    /** Per-id product details; anything else → the recorded fixtures, else NOT_FOUND. */
    const details = new Map<string, Channel3Product>();
    const fixtures = new Channel3FixtureClient();
    let outage = false;
    let calls = 0;
    const channel3 = {
      product: async (id: string): Promise<Channel3Product> => {
        calls++;
        if (outage) throw new Channel3Error('OUTAGE', 'Channel3 product is unreachable');
        const d = details.get(id);
        if (d) return d;
        return fixtures.product(id);
      },
    };
    const deps = (extra: Partial<PriceWatchDeps> = {}): PriceWatchDeps => ({
      db,
      paypal: client,
      voidBackoffMs: [0, 0, 0],
      audit: auditHook,
      channel3,
      ...extra,
    });

    const voidsFor = (bidId: string) =>
      fake.calls.slice(mark).filter((c) => c.op === 'void' && c.requestId === voidKey(bidId));

    async function market(cols: {
      channel3Id: string;
      variant?: string | null;
      domains: string[];
      best: { cents: number; merchant: string } | null;
    }) {
      const brand = await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email, authorized_domains, verification_status)
         VALUES ('Aurel Audio (demo)', 'payouts@aurel.example', $1, 'VERIFIED') RETURNING id`,
        [cols.domains],
      );
      const product = await one<{ id: string }>(
        `INSERT INTO products (title, channel3_id, channel3_variant, channel3_subscription_id,
                               condition, best_public_price_cents, best_public_merchant,
                               best_public_offer_url, price_updated_at)
         VALUES ('Watched', $1, $2, 'sub_test', 'NEW', $3, $4, $5, now()) RETURNING id`,
        [
          cols.channel3Id,
          cols.variant ?? null,
          cols.best?.cents ?? null,
          cols.best?.merchant ?? null,
          cols.best ? `https://${cols.best.merchant}/p` : null,
        ],
      );
      const listing = await one<{ id: string; slug: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, published_at,
                               window_opens_at, window_closes_at, slug)
         VALUES ($1, $2, 'OPEN', 300, 9900, now(), now() - interval '1 hour',
                 now() + interval '4 hours', $3)
         RETURNING id, slug`,
        [brand.id, product.id, `w-${randomUUID().slice(0, 8)}`],
      );
      return {
        brandId: brand.id,
        productId: product.id,
        listingId: listing.id,
        slug: listing.slug,
      };
    }

    async function held(listingId: string, amountCents: number, ppap: number | null) {
      const shopper = await one<{ id: string }>(
        `INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`,
      );
      const r = await placeBid(
        { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook, allowTestCard: true },
        {
          shopperId: shopper.id,
          listingId,
          amountCents,
          paymentMethod: 'TEST_CARD',
          source: 'OFFER_PAGE',
          idempotencyKey: randomUUID(),
        },
      );
      if (!r.ok) throw new Error(`hold failed: ${JSON.stringify(r.error)}`);
      await db.pool.query(
        `UPDATE bids SET release_if_cheaper = true, public_price_at_placement = $2 WHERE id = $1`,
        [r.bid.id, ppap],
      );
      return r.bid.id;
    }

    const bidStatus = async (id: string) =>
      (
        await one<{ status: string; void_reason: string | null }>(
          `SELECT status, void_reason FROM bids WHERE id = $1`,
          [id],
        )
      ).status;

    const detail = (
      id: string,
      offers: Array<[string, number, string?]>,
      selected: Array<{ name: string; label: string }> | null = null,
    ): Channel3Product => ({
      id,
      title: 'Watched',
      offers: offers.map(([domain, price, availability]) => ({
        url: `https://buy.trychannel3.com/${id}-${domain}`,
        domain,
        price: { price, currency: 'USD' },
        availability: availability ?? 'InStock',
        condition: 'new',
      })),
      variants: selected ? { options: [], selected } : null,
    });

    beforeAll(async () => {
      t = await createTestDatabase();
      db = t.db;
      fake = new FakePayPal();
      client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    }, 60_000);
    afterAll(async () => {
      await t?.close();
    });
    beforeEach(async () => {
      outage = false;
      calls = 0;
      mark = fake.calls.length;
      await db.pool.query(
        `UPDATE channel3_health SET last_ok_at = NULL, last_event_at = NULL, last_failure_at = NULL,
                consecutive_failures = 0, last_error = NULL, outage_since = NULL,
                last_poll_at = NULL`,
      );
      // Earlier tests' listings stay out of the way of this one.
      await db.pool.query(`UPDATE listings SET status = 'EXPIRED' WHERE status = 'OPEN'`);
    });

    // -- Outage banner ---------------------------------------------------------------------------

    it('the banner appears when Channel3 is unreachable and clears when it recovers', async () => {
      const m = await market({
        channel3Id: `c3-${randomUUID().slice(0, 8)}`,
        domains: ['bestbuy.com'],
        best: { cents: 27_900, merchant: 'bestbuy.com' },
      });
      details.set(
        (
          await one<{ channel3_id: string }>(`SELECT channel3_id FROM products WHERE id = $1`, [
            m.productId,
          ])
        ).channel3_id,
        detail('x', [['bestbuy.com', 279]]),
      );
      const paused = async () => ({
        offer: (await loadOffer(db.pool, m.slug, null))!.priceWatchPaused,
        book: (await loadBook(db, m.brandId, m.listingId)).listing.priceWatch.pausedAt,
      });

      // Healthy probe: nothing paused.
      let r = await probeChannel3(deps());
      expect(r).toMatchObject({ ok: true, paused: [], resumed: [] });
      expect(await paused()).toEqual({ offer: false, book: null });

      // Two failures: still up. The third pauses this listing.
      outage = true;
      expect((await probeChannel3(deps())).paused).toEqual([]);
      expect((await probeChannel3(deps())).paused).toEqual([]);
      r = await probeChannel3(deps());
      expect(r).toMatchObject({ ok: false, paused: [m.listingId] });
      const p = await paused();
      expect(p.offer).toBe(true);
      expect(p.book).toEqual(expect.any(String));
      const health = await readChannel3Health(db.pool);
      expect(health.consecutiveFailures).toBe(3);
      expect(health.outageSince).not.toBeNull();
      const a = await one<{ actor_type: string; data: { reason: string } }>(
        `SELECT actor_type, data FROM audit_events
          WHERE listing_id = $1 AND action = 'PRICE_WATCH_PAUSED'`,
        [m.listingId],
      );
      expect(a).toMatchObject({ actor_type: 'WATCHER', data: { reason: 'CHANNEL3_UNREACHABLE' } });

      // Still down: no re-pause, no duplicate audit.
      expect((await probeChannel3(deps())).paused).toEqual([]);

      // A webhook delivery alone does not clear it (our calls still fail).
      await recordChannel3Event(db.pool);
      expect((await probeChannel3(deps())).resumed).toEqual([]);

      // Recovery: one good call clears the flag.
      outage = false;
      r = await probeChannel3(deps());
      expect(r).toMatchObject({ ok: true, resumed: [m.listingId] });
      expect(await paused()).toEqual({ offer: false, book: null });
      expect((await readChannel3Health(db.pool)).outageSince).toBeNull();
      const resumed = await one<{ n: string }>(
        `SELECT count(*) AS n FROM audit_events
          WHERE listing_id = $1 AND action = 'PRICE_WATCH_RESUMED'`,
        [m.listingId],
      );
      expect(Number(resumed.n)).toBe(1);
    });

    it('no contact within the window pauses too; a NOT_FOUND answer counts as reachable', async () => {
      const m = await market({
        channel3Id: `demo-${randomUUID().slice(0, 8)}`, // unknown to Channel3 → NOT_FOUND
        domains: ['bestbuy.com'],
        best: null,
      });
      await db.pool.query(
        `UPDATE channel3_health SET last_ok_at = now() - interval '45 minutes' WHERE id`,
      );
      // Probing an unknown product is an answer: reachable, nothing paused.
      expect(await probeChannel3(deps())).toMatchObject({ ok: true, paused: [] });

      // Stale contact with the probe skipped (simulated by syncing directly) → paused.
      await db.pool.query(
        `UPDATE channel3_health SET last_ok_at = now() - interval '45 minutes' WHERE id`,
      );
      expect((await syncPriceWatchPause({ db })).paused).toEqual([m.listingId]);
    });

    // -- Nightly poll ----------------------------------------------------------------------------

    it('the poll detects a price change no webhook delivered and processes it once', async () => {
      const channel3Id = `c3-${randomUUID().slice(0, 8)}`;
      const m = await market({
        channel3Id,
        domains: ['bestbuy.com', 'target.com'],
        best: { cents: 27_900, merchant: 'bestbuy.com' },
      });
      const released = await held(m.listingId, 24_900, 27_900);
      const kept = await held(m.listingId, 23_000, 27_900);
      // target.com dropped to $245; walmart.com (not allowlisted) is cheaper but ignored.
      details.set(
        channel3Id,
        detail(channel3Id, [
          ['bestbuy.com', 279],
          ['target.com', 245],
          ['walmart.com', 199],
        ]),
      );

      const first = await pollPublicPrices(deps());
      expect(first).toMatchObject({ ran: true, events: 1, released: 1, failed: 0 });
      expect(await bidStatus(released)).toBe('VOIDED');
      expect(await bidStatus(kept)).toBe('HELD');
      expect(voidsFor(released)).toHaveLength(1);

      const ev = await one<{
        id: string;
        processed_at: Date | null;
        payload: { data: { source: string } };
      }>(
        `SELECT id, processed_at, payload FROM webhook_events
          WHERE provider = 'CHANNEL3' AND payload->'data'->>'source' = 'poll'
            AND payload->'data'->'subject'->>'product_id' = $1`,
        [channel3Id],
      );
      expect(ev.processed_at).not.toBeNull();
      expect(ev.id).toMatch(/^poll_/);
      const audit = await one<{ data: Record<string, unknown> }>(
        `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'BID_VOID_REQUESTED'`,
        [released],
      );
      expect(audit.data).toMatchObject({
        source: 'poll',
        newPriceCents: 24_500,
        merchant: 'target.com',
        replayed: false,
      });
      expect(
        (
          await one<{ c: number }>(
            `SELECT best_public_price_cents AS c FROM products WHERE id = $1`,
            [m.productId],
          )
        ).c,
      ).toBe(24_500);

      // Within 23 h the cron is a no-op; a forced re-poll the same day changes nothing.
      expect((await pollPublicPrices(deps())).ran).toBe(false);
      const again = await pollPublicPrices(deps(), { force: true });
      expect(again).toMatchObject({ ran: true, events: 0, released: 0 });
      expect(voidsFor(released)).toHaveLength(1);
      const n = await one<{ n: string }>(
        `SELECT count(*) AS n FROM webhook_events
          WHERE payload->'data'->'subject'->>'product_id' = $1`,
        [channel3Id],
      );
      expect(Number(n.n)).toBe(1);
    });

    it('a drop already written by the offer-page refresh (no void) is still caught', async () => {
      const channel3Id = `c3-${randomUUID().slice(0, 8)}`;
      // The stored best already shows $245 (refreshPublicOffer) but the bid is still HELD.
      const m = await market({
        channel3Id,
        domains: ['target.com'],
        best: { cents: 24_500, merchant: 'target.com' },
      });
      const bid = await held(m.listingId, 24_900, 27_900);
      details.set(channel3Id, detail(channel3Id, [['target.com', 245]]));
      const r = await pollPublicPrices(deps(), { force: true });
      expect(r).toMatchObject({ events: 1, released: 1 });
      expect(await bidStatus(bid)).toBe('VOIDED');

      // Nothing changed and nothing qualifies: no event at all.
      const quiet = await pollPublicPrices(deps(), { force: true });
      expect(quiet).toMatchObject({ events: 0, duplicates: 0 });
    });

    it('poll with the recorded detail fixture (r4bivjG, jcpenney.com $139)', async () => {
      const m = await market({
        channel3Id: 'r4bivjG',
        variant: 'Color=Green',
        domains: ['jcpenney.com', 'jbl.com'],
        best: { cents: 24_995, merchant: 'jbl.com' },
      });
      const bid = await held(m.listingId, 19_900, 24_995);
      const below = await held(m.listingId, 12_900, 24_995);
      const r = await pollPublicPrices(deps(), { force: true });
      expect(r).toMatchObject({ events: 1, released: 1, failed: 0 });
      expect(await bidStatus(bid)).toBe('VOIDED');
      expect(await bidStatus(below)).toBe('HELD');
    });

    it('a Channel3 outage during the poll counts as a failure and leaves bids alone', async () => {
      const channel3Id = `c3-${randomUUID().slice(0, 8)}`;
      const m = await market({
        channel3Id,
        domains: ['target.com'],
        best: { cents: 27_900, merchant: 'target.com' },
      });
      const bid = await held(m.listingId, 24_900, 27_900);
      details.set(channel3Id, detail(channel3Id, [['target.com', 245]]));
      outage = true;
      const r = await pollPublicPrices(deps(), { force: true });
      expect(r).toMatchObject({ ran: true, failed: 1, events: 0 });
      expect(await bidStatus(bid)).toBe('HELD');
      expect((await readChannel3Health(db.pool)).consecutiveFailures).toBe(1);
      expect(calls).toBe(1);
    });

    it('a poll event whose processing crashed is recovered by the reprocess loop', async () => {
      const channel3Id = `c3-${randomUUID().slice(0, 8)}`;
      const m = await market({
        channel3Id,
        domains: ['target.com'],
        best: { cents: 27_900, merchant: 'target.com' },
      });
      const bid = await held(m.listingId, 24_900, 27_900);
      details.set(channel3Id, detail(channel3Id, [['target.com', 245]]));
      const r = await pollPublicPrices(
        deps({
          afterSelect: async () => {
            throw new Error('crash mid-run');
          },
        }),
        { force: true },
      );
      expect(r).toMatchObject({ failed: 1, events: 0 });
      expect(await bidStatus(bid)).toBe('HELD');
      const out = await reprocessPriceEvents(deps(), { olderThanMs: 0 });
      expect(out.released).toBe(1);
      expect(await bidStatus(bid)).toBe('VOIDED');
      expect(voidsFor(bid)).toHaveLength(1);
    });
  },
);
