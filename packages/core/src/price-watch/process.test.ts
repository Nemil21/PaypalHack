/**
 * HF-042a tests: the price watcher's shared path (`processPriceEvent`), the labelled replay and the
 * `processed_at IS NULL` reprocess, on real Postgres with the `FakePayPal` stub (HF-004), including
 * the race tests from old HF-047 (replay ∥ Clear, a raise landing mid-run).
 * The DB part needs TEST_DATABASE_URL; it is skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/price-watch
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AFFILIATE_DISCLOSURE } from '@holdfast/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { listMyBids, getBidDetail } from '../bid-views.js';
import { raiseBid } from '../bid-raise.js';
import { placeBid, type PlaceBidDeps } from '../bids.js';
import { Channel3FixtureClient, defaultFixturesDir } from '../channel3/client.js';
import { Channel3Error } from '../channel3/errors.js';
import { bestOffer } from '../channel3/product.js';
import type { Channel3Product } from '../channel3/types.js';
import type { Db } from '../db.js';
import { clearListing } from '../listings/clear-listing.js';
import { simulateListing } from '../listings/book.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { voidKey } from '../money/void.js';
import { FakePayPal } from '../paypal/fake.js';
import type { PayPalClient } from '../paypal/types.js';
import { recordWebhookEvent } from '../webhooks.js';
import {
  parsePriceEvent,
  processPriceWebhookRow,
  qualifiesForRelease,
  reprocessPriceEvents,
  type PriceWatchDeps,
} from './process.js';
import { buildReplayEvent, replayPriceDrop, replayPriceEvent } from './replay.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------------------------

describe('HF-042a selection predicate', () => {
  const bid = (
    cols: Partial<{ status: string; on: boolean; amount: number; ppap: number | null }>,
  ) => ({
    status: (cols.status ?? 'HELD') as 'HELD',
    release_if_cheaper: cols.on ?? true,
    amount_cents: cols.amount ?? 24_900,
    public_price_at_placement: cols.ppap === undefined ? 27_900 : cols.ppap,
  });
  const cases: Array<[string, ReturnType<typeof bid>, string, number, boolean]> = [
    ['below the bid and the placement price', bid({}), 'OPEN', 24_500, true],
    ['in ROUNDS too', bid({}), 'ROUNDS', 24_500, true],
    ['equal to the bid is not cheaper', bid({}), 'OPEN', 24_900, false],
    ['above the bid', bid({}), 'OPEN', 25_000, false],
    ['release-if-cheaper off', bid({ on: false }), 'OPEN', 20_000, false],
    ['knowingly placed above the public price', bid({ ppap: 24_000 }), 'OPEN', 24_500, false],
    ['equal to the placement price', bid({ ppap: 24_500 }), 'OPEN', 24_500, false],
    ['no public price known at placement', bid({ ppap: null }), 'OPEN', 24_500, true],
    ['WON during CLEARING', bid({ status: 'WON' }), 'CLEARING', 1_000, false],
    ['HELD on a CLEARING listing', bid({}), 'CLEARING', 1_000, false],
    ['VOIDING already', bid({ status: 'VOIDING' }), 'OPEN', 1_000, false],
  ];
  for (const [name, b, listing, price, expected] of cases) {
    it(`${name} → ${expected ? 'released' : 'kept'}`, () => {
      expect(qualifiesForRelease(b, listing, price)).toBe(expected);
    });
  }
});

describe('HF-042a parsePriceEvent', () => {
  const fixture = JSON.parse(
    readFileSync(join(defaultFixturesDir(), 'webhooks', 'offer.price.changed.json'), 'utf8'),
  ) as { body: Record<string, unknown> };

  it('reads the recorded offer.price.changed body; live events never carry a detail', () => {
    const e = parsePriceEvent({ ...fixture.body, detail: { id: 'x', title: 't' } })!;
    expect(e).toMatchObject({
      id: 'evt_fixture_r4bivjG_jcpenney_1',
      replayed: false,
      detail: null,
    });
    expect(e.priceChanged?.data.current.price).toBe(119.99);
  });

  it('a replay keeps its detail snapshot', () => {
    const e = parsePriceEvent({
      ...fixture.body,
      replayed: true,
      detail: { id: 'r4bivjG', title: 't' },
    })!;
    expect(e.replayed).toBe(true);
    expect(e.detail?.id).toBe('r4bivjG');
  });

  it('other event types parse without a price change; junk is null', () => {
    expect(
      parsePriceEvent({ id: 'e', type: 'offer.availability.changed', data: {} })?.priceChanged,
    ).toBeNull();
    expect(parsePriceEvent({ nope: true })).toBeNull();
  });
});

describe('HF-042a best-price recompute input (fixtures)', () => {
  it('cheapest new, in-stock, allowlisted USD offer of the recorded detail', async () => {
    const c3 = new Channel3FixtureClient();
    const p = await c3.product('r4bivjG');
    const all = bestOffer(p.offers);
    const jcp = bestOffer(p.offers, { domains: ['jcpenney.com'] });
    expect(jcp?.domain).toBe('jcpenney.com');
    expect(bestOffer(p.offers, { domains: ['not-a-store.example'] })).toBeNull();
    if (all) expect(all.priceCents).toBeLessThanOrEqual(jcp!.priceCents);
  });
});

// ---------------------------------------------------------------------------------------------
// Integration (FakePayPal)
// ---------------------------------------------------------------------------------------------

interface Market {
  listingId: string;
  brandId: string;
  productId: string;
  channel3Id: string;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'HF-042a price watcher (FakePayPal)',
  { timeout: 60_000 },
  () => {
    let t: TestDatabase;
    let db: Db;
    let fake: FakePayPal;
    let client: PayPalClient;
    let mark = 0;

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await db.pool.query(sql, params)).rows as T[];
    const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await q<T>(sql, params))[0]!;

    const notFound = {
      product: async (): Promise<Channel3Product> => {
        throw new Channel3Error('NOT_FOUND', 'No such Channel3 product', 404);
      },
    };

    const deps = (extra: Partial<PriceWatchDeps> = {}): PriceWatchDeps => ({
      db,
      paypal: client,
      voidBackoffMs: [0, 0, 0],
      audit: auditHook,
      channel3: notFound,
      ...extra,
    });
    const bidDeps = (): PlaceBidDeps => ({
      db,
      paypal: client,
      voidBackoffMs: [0, 0, 0],
      audit: auditHook,
      allowTestCard: true,
    });

    const voidCalls = () => fake.calls.slice(mark).filter((c) => c.op === 'void');
    const voidsFor = (bidId: string) => voidCalls().filter((c) => c.requestId === voidKey(bidId));

    /** The fictional demo product (D15): brand allowlist, a public anchor at bestbuy.com $279. */
    async function market(
      cols: { domains?: string[]; channel3Id?: string; variant?: string | null } = {},
    ): Promise<Market> {
      const brand = await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email, authorized_domains, verification_status)
       VALUES ('Aurel Audio (demo)', 'payouts@aurel.example', $1, 'VERIFIED') RETURNING id`,
        [cols.domains ?? ['bestbuy.com', 'target.com']],
      );
      const channel3Id = cols.channel3Id ?? `aurel-a7-${randomUUID().slice(0, 8)}`;
      const product = await one<{ id: string }>(
        `INSERT INTO products (title, channel3_id, channel3_variant, condition, best_public_price_cents,
                             best_public_merchant, best_public_offer_url, price_updated_at)
       VALUES ('Aurel A7', $1, $2, 'NEW', 27900, 'bestbuy.com',
               'https://buy.trychannel3.com/aurel-a7-bestbuy', now())
       RETURNING id`,
        [channel3Id, cols.variant === undefined ? 'Color=Black' : cols.variant],
      );
      const listing = await one<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, published_at,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, 'OPEN', 300, 19900, now(), now() - interval '1 hour', now() + interval '4 hours')
       RETURNING id`,
        [brand.id, product.id],
      );
      return { listingId: listing.id, brandId: brand.id, productId: product.id, channel3Id };
    }

    async function shopper(): Promise<string> {
      return (
        await one<{ id: string }>(`INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`)
      ).id;
    }

    /** A real FakePayPal hold; then the watch setting and the public price seen at placement. */
    async function held(
      m: Market,
      amountCents: number,
      cols: { watch?: boolean; ppap?: number | null; shopperId?: string } = {},
    ) {
      const shopperId = cols.shopperId ?? (await shopper());
      const r = await placeBid(bidDeps(), {
        shopperId,
        listingId: m.listingId,
        amountCents,
        paymentMethod: 'TEST_CARD',
        source: 'OFFER_PAGE',
        idempotencyKey: randomUUID(),
      });
      if (!r.ok) throw new Error(`hold failed: ${JSON.stringify(r.error)}`);
      await db.pool.query(
        `UPDATE bids SET release_if_cheaper = $2,
              public_price_at_placement = CASE WHEN $4 THEN $3::int ELSE public_price_at_placement END
        WHERE id = $1`,
        [r.bid.id, cols.watch ?? true, cols.ppap ?? null, cols.ppap !== undefined],
      );
      return { id: r.bid.id, shopperId, amountCents };
    }

    const status = async (bidId: string) =>
      await one<{ status: string; void_reason: string | null }>(
        `SELECT status, void_reason FROM bids WHERE id = $1`,
        [bidId],
      );

    beforeAll(async () => {
      t = await createTestDatabase();
      db = t.db;
      fake = new FakePayPal();
      client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    }, 60_000);
    afterAll(async () => {
      await t?.close();
    });
    beforeEach(() => {
      fake.latencyMs = 0;
      fake.clearFaults();
      mark = fake.calls.length;
    });

    it('a replayed drop voids exactly the bids that meet the rule, within 60 s, labelled and audited', async () => {
      const m = await market();
      const released = await held(m, 24_900); // $249 foreground bid, public $279 at placement
      const noPpap = await held(m, 25_500, { ppap: null });
      const off = await held(m, 26_000, { watch: false }); // SIM above the drop, release off
      const knowingly = await held(m, 25_000, { ppap: 24_000 }); // placed above a $240 public price
      const below = await held(m, 24_000);

      const started = Date.now();
      const out = await replayPriceDrop(deps(), { listingId: m.listingId, priceCents: 24_500 });
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(out.ok && !out.duplicate).toBe(true);
      if (!out.ok || out.duplicate) return;
      const r = out.result;
      expect(r).toMatchObject({
        outcome: 'MATCHED',
        replayed: true,
        cheaper: {
          priceCents: 24_500,
          merchant: 'bestbuy.com',
          url: 'https://buy.trychannel3.com/aurel-a7-bestbuy',
        },
        bestPublicPriceCents: 24_500,
      });
      expect(r.released.map((b) => b.bidId).sort()).toEqual([released.id, noPpap.id].sort());
      expect(r.released.every((b) => b.status === 'VOIDED')).toBe(true);

      for (const b of [released, noPpap]) {
        expect(await status(b.id)).toEqual({ status: 'VOIDED', void_reason: 'PRICE_DROP' });
        expect(voidsFor(b.id)).toHaveLength(1);
      }
      for (const b of [off, knowingly, below]) {
        expect((await status(b.id)).status).toBe('HELD');
        expect(voidsFor(b.id)).toHaveLength(0);
      }

      // Audit: WATCHER, cheaper offer, affiliate link + disclosure, replay label.
      const a = await one<{
        actor_type: string;
        request_id: string;
        data: Record<string, unknown>;
      }>(
        `SELECT actor_type, request_id, data FROM audit_events
        WHERE entity_id = $1 AND action = 'BID_VOID_REQUESTED'`,
        [released.id],
      );
      expect(a.actor_type).toBe('WATCHER');
      expect(a.request_id).toBe(voidKey(released.id));
      expect(a.data).toMatchObject({
        reason: 'PRICE_DROP',
        newPriceCents: 24_500,
        merchant: 'bestbuy.com',
        url: 'https://buy.trychannel3.com/aurel-a7-bestbuy',
        disclosure: AFFILIATE_DISCLOSURE,
        replayed: true,
        label: 'replayed event (demo)',
      });
      const summary = await one<{ data: { count: number } }>(
        `SELECT data FROM audit_events WHERE listing_id = $1 AND action = 'PRICE_WATCH_RELEASED'`,
        [m.listingId],
      );
      expect(summary.data.count).toBe(2);

      // webhook_events: replayed, processed.
      const ev = await one<{
        provider: string;
        processed_at: Date | null;
        payload: { replayed: boolean };
      }>(`SELECT provider, processed_at, payload FROM webhook_events WHERE id = $1`, [r.eventId]);
      expect(ev).toMatchObject({ provider: 'CHANNEL3', payload: { replayed: true } });
      expect(ev.processed_at).not.toBeNull();

      // Shopper surfaces: my bids (MCP my_bids) and the bid detail (W15 / W21 / M06).
      const mine = (await listMyBids(db.pool, released.shopperId)).bids[0]!;
      expect(mine.priceDrop).toEqual({
        newCents: 24_500,
        merchant: 'bestbuy.com',
        url: 'https://buy.trychannel3.com/aurel-a7-bestbuy',
        disclosure: AFFILIATE_DISCLOSURE,
        replayed: true,
      });
      expect((await listMyBids(db.pool, off.shopperId)).bids[0]!.priceDrop).toBeNull();
      const detail = await getBidDetail(db.pool, released.shopperId, released.id);
      expect(detail?.priceDrop).toMatchObject({ newCents: 24_500, released: true, replayed: true });

      // Post-drop book: the two released bids are gone from simulate.
      const sim = await simulateListing(db, m.brandId, m.listingId, 240);
      expect(sim.winners).toBe(3);
    });

    it('replaying the same event id again is a duplicate and voids nothing more', async () => {
      const m = await market();
      await held(m, 24_900);
      const eventId = `replay_${randomUUID()}`;
      const first = await replayPriceDrop(deps(), {
        listingId: m.listingId,
        priceCents: 24_500,
        eventId,
      });
      expect(first.ok && !first.duplicate && first.result.released.length).toBe(1);
      mark = fake.calls.length;
      const again = await replayPriceDrop(deps(), {
        listingId: m.listingId,
        priceCents: 24_500,
        eventId,
      });
      expect(again).toEqual({ ok: true, duplicate: true, eventId });
      expect(voidCalls()).toHaveLength(0);
    });

    describe('non-matching offers are ignored and audited with a reason', () => {
      async function ignoredReasons(m: Market) {
        return (
          await q<{ data: { reason: string } }>(
            `SELECT data FROM audit_events WHERE listing_id = $1 AND action = 'PRICE_IGNORED'`,
            [m.listingId],
          )
        ).map((a) => a.data.reason);
      }

      it('a store off the allowlist → DOMAIN_NOT_ALLOWED; nothing voided, price untouched', async () => {
        const m = await market();
        const b = await held(m, 24_900);
        const built = await buildReplayEvent(deps(), {
          listingId: m.listingId,
          priceCents: 24_500,
        });
        if (!built.ok) throw new Error('build failed');
        const body = structuredClone(built.payload);
        body.data.subject.domain = 'greymarket.example';
        for (const o of (body.detail as Channel3Product).offers!) o.domain = 'greymarket.example';
        const out = await replayPriceEvent(deps(), body);
        expect(out.ok && !out.duplicate && out.result).toMatchObject({
          outcome: 'IGNORED',
          ignored: [{ listingId: m.listingId, reason: 'DOMAIN_NOT_ALLOWED' }],
          released: [],
        });
        expect(await ignoredReasons(m)).toEqual(['DOMAIN_NOT_ALLOWED']);
        expect((await status(b.id)).status).toBe('HELD');
        expect(
          (
            await one<{ c: number }>(
              `SELECT best_public_price_cents c FROM products WHERE id = $1`,
              [m.productId],
            )
          ).c,
        ).toBe(27_900);
      });

      it('a used / refurbished offer → NOT_NEW', async () => {
        const m = await market();
        const b = await held(m, 24_900);
        const built = await buildReplayEvent(deps(), {
          listingId: m.listingId,
          priceCents: 24_500,
        });
        if (!built.ok) throw new Error('build failed');
        const body = structuredClone(built.payload);
        for (const o of (body.detail as Channel3Product).offers!) o.condition = 'used';
        await replayPriceEvent(deps(), body);
        expect(await ignoredReasons(m)).toEqual(['NOT_NEW']);
        expect((await status(b.id)).status).toBe('HELD');
      });

      it('another variant → VARIANT_MISMATCH; a non-USD price → NOT_USD', async () => {
        const m = await market();
        await held(m, 24_900);
        const built = await buildReplayEvent(deps(), {
          listingId: m.listingId,
          priceCents: 24_500,
        });
        if (!built.ok) throw new Error('build failed');
        const variant = structuredClone(built.payload);
        variant.data.subject.selection = [{ name: 'Color', label: 'Pink' }];
        await replayPriceEvent(deps(), { ...variant, id: undefined });
        const cad = structuredClone(built.payload);
        cad.data.current.currency = 'CAD';
        await replayPriceEvent(deps(), { ...cad, id: undefined });
        expect((await ignoredReasons(m)).sort()).toEqual(['NOT_USD', 'VARIANT_MISMATCH']);
      });
    });

    it('the recorded Channel3 fixture event: gate hydrates condition from the detail; best price recomputed from it', async () => {
      const c3 = new Channel3FixtureClient();
      const m = await market({
        channel3Id: 'r4bivjG',
        variant: 'Color=Green',
        domains: ['jcpenney.com'],
      });
      const b = await held(m, 15_000); // above $119.99
      const fixture = JSON.parse(
        readFileSync(join(defaultFixturesDir(), 'webhooks', 'offer.price.changed.json'), 'utf8'),
      ) as { body: Record<string, unknown> };
      const rec = await recordWebhookEvent(db.pool, {
        id: `${fixture.body.id as string}-${randomUUID()}`,
        provider: 'CHANNEL3',
        eventType: 'offer.price.changed',
        payload: { ...fixture.body, id: undefined },
      });
      const r = await processPriceWebhookRow(deps({ channel3: c3 }), {
        id: rec.event.id,
        payload: { ...fixture.body, id: rec.event.id },
      });
      const detail = await c3.product('r4bivjG');
      const expected = bestOffer(detail.offers, { domains: ['jcpenney.com'] });
      expect(r.outcome).toBe('MATCHED');
      expect(r.cheaper).toMatchObject({ priceCents: 11_999, merchant: 'jcpenney.com' });
      // Recomputed from the detail endpoint (M13), not min(old, new).
      expect(r.bestPublicPriceCents).toBe(expected?.priceCents ?? null);
      expect(await status(b.id)).toEqual({ status: 'VOIDED', void_reason: 'PRICE_DROP' });
    });

    it('a price rise recomputes the best price upward and releases nothing', async () => {
      const m = await market();
      const b = await held(m, 24_900);
      const out = await replayPriceDrop(deps(), { listingId: m.listingId, priceCents: 29_900 });
      expect(out.ok && !out.duplicate && out.result).toMatchObject({
        outcome: 'MATCHED',
        bestPublicPriceCents: 29_900,
        released: [],
      });
      expect((await status(b.id)).status).toBe('HELD');
    });

    describe('crash recovery (processed_at IS NULL)', () => {
      it('a crash after dedupe but before processing is recovered by the reprocess loop', async () => {
        const m = await market();
        const b = await held(m, 24_900);
        const built = await buildReplayEvent(deps(), {
          listingId: m.listingId,
          priceCents: 24_500,
        });
        if (!built.ok) throw new Error('build failed');
        // Recorded (deduped), then the process died: nothing processed.
        await recordWebhookEvent(db.pool, {
          id: built.payload.id,
          provider: 'CHANNEL3',
          eventType: 'offer.price.changed',
          payload: { ...built.payload, replayed: true },
        });
        expect((await status(b.id)).status).toBe('HELD');

        const run = await reprocessPriceEvents(deps(), { olderThanMs: 0 });
        expect(run).toMatchObject({ processed: 1, failed: 0, released: 1 });
        expect(await status(b.id)).toEqual({ status: 'VOIDED', void_reason: 'PRICE_DROP' });
        const ev = await one<{ processed_at: Date | null }>(
          `SELECT processed_at FROM webhook_events WHERE id = $1`,
          [built.payload.id],
        );
        expect(ev.processed_at).not.toBeNull();
        expect(await reprocessPriceEvents(deps(), { olderThanMs: 0 })).toMatchObject({
          processed: 0,
        });
      });

      it('a Channel3 outage while hydrating leaves the row unprocessed with last_error; the next run finishes it', async () => {
        // The recorded product id is unique per variant: retire the earlier test's row.
        await db.pool.query(`UPDATE products SET channel3_id = NULL WHERE channel3_id = 'r4bivjG'`);
        const m = await market({
          channel3Id: 'r4bivjG',
          variant: 'Color=Green',
          domains: ['jcpenney.com'],
        });
        const b = await held(m, 15_000);
        const fixture = JSON.parse(
          readFileSync(join(defaultFixturesDir(), 'webhooks', 'offer.price.changed.json'), 'utf8'),
        ) as { body: Record<string, unknown> };
        const id = `evt_outage_${randomUUID()}`;
        const rec = await recordWebhookEvent(db.pool, {
          id,
          provider: 'CHANNEL3',
          eventType: 'offer.price.changed',
          payload: { ...fixture.body, id },
        });
        const down = new Channel3FixtureClient();
        down.failures.push(new Channel3Error('OUTAGE', 'Channel3 product is unreachable'));
        await expect(processPriceWebhookRow(deps({ channel3: down }), rec.event)).rejects.toThrow(
          /unreachable/,
        );
        const row = await one<{ processed_at: Date | null; last_error: string | null }>(
          `SELECT processed_at, last_error FROM webhook_events WHERE id = $1`,
          [id],
        );
        expect(row.processed_at).toBeNull();
        expect(row.last_error).toMatch(/unreachable/);
        expect((await status(b.id)).status).toBe('HELD');

        const run = await reprocessPriceEvents(deps({ channel3: new Channel3FixtureClient() }), {
          olderThanMs: 0,
        });
        expect(run.failed).toBe(0);
        expect(await status(b.id)).toEqual({ status: 'VOIDED', void_reason: 'PRICE_DROP' });
      });
    });

    describe('races (FakePayPal stub)', () => {
      const BRAND_USER = { type: 'BRAND_USER', id: 'brand-user-1' };

      async function clearInput(m: Market, quantity: number) {
        const sim = await simulateListing(db, m.brandId, m.listingId, quantity);
        return {
          listingId: m.listingId,
          brandId: m.brandId,
          quantity,
          expectedGrossCents: sim.grossCents,
          actor: BRAND_USER,
          idempotencyKey: randomUUID(),
        };
      }

      /** No bid is both WON and released; WON / LOST bids were never voided by the watcher. */
      async function expectInvariants(m: Market) {
        const bids = await q<{ id: string; status: string; void_reason: string | null }>(
          `SELECT id, status, void_reason FROM bids WHERE listing_id = $1`,
          [m.listingId],
        );
        const watcherVoids = new Set(
          (
            await q<{ entity_id: string }>(
              `SELECT entity_id FROM audit_events
              WHERE listing_id = $1 AND action = 'BID_VOID_REQUESTED' AND actor_type = 'WATCHER'`,
              [m.listingId],
            )
          ).map((a) => a.entity_id),
        );
        for (const b of bids) {
          if (b.status === 'WON' || b.status === 'LOST') {
            expect(watcherVoids.has(b.id)).toBe(false);
            expect(b.void_reason).not.toBe('PRICE_DROP');
            expect(voidsFor(b.id)).toHaveLength(0);
          }
          if (b.void_reason === 'PRICE_DROP') expect(['VOIDING', 'VOIDED']).toContain(b.status);
        }
        const captured = await q<{ bid_id: string }>(
          `SELECT bid_id FROM settlements WHERE listing_id = $1 AND action = 'CAPTURE'`,
          [m.listingId],
        );
        for (const c of captured) expect(watcherVoids.has(c.bid_id)).toBe(false);
      }

      it('Clear first: the replay waits on the listing lock, sees CLEARING and voids nothing', async () => {
        const m = await market();
        const bids = [await held(m, 24_900), await held(m, 25_500), await held(m, 21_000)];
        let replayP!: ReturnType<typeof replayPriceDrop>;
        const out = await clearListing(
          {
            db,
            paypal: client,
            voidBackoffMs: [0, 0, 0],
            audit: auditHook,
            afterLocks: async () => {
              replayP = replayPriceDrop(deps(), { listingId: m.listingId, priceCents: 24_500 });
              await sleep(200);
            },
          },
          await clearInput(m, 2),
        );
        expect(out.ok).toBe(true);
        const r = await replayP;
        expect(r.ok && !r.duplicate && r.result.released).toEqual([]);
        const statuses = await Promise.all(bids.map((b) => status(b.id)));
        expect(statuses.map((s) => s.status)).toEqual(['WON', 'WON', 'LOST']);
        await expectInvariants(m);
      });

      it('replay first: released bids drop out of the book, so Clear answers BOOK_CHANGED', async () => {
        const m = await market();
        await held(m, 24_900);
        await held(m, 21_000);
        const input = await clearInput(m, 2);
        const r = await replayPriceDrop(deps(), { listingId: m.listingId, priceCents: 24_500 });
        expect(r.ok && !r.duplicate && r.result.released).toHaveLength(1);
        const out = await clearListing(
          { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook },
          input,
        );
        expect(out).toMatchObject({ ok: false, error: { reason: 'BOOK_CHANGED' } });
        await expectInvariants(m);
      });

      it('replay ∥ Clear, 10 runs: no bid is both WON and VOIDED; WON/LOST bids are never voided', async () => {
        fake.jitterMs = 5;
        try {
          for (let i = 0; i < 10; i++) {
            const m = await market();
            await held(m, 24_900);
            await held(m, 25_500);
            await held(m, 26_000, { watch: false });
            await held(m, 21_000);
            const input = await clearInput(m, 2);
            const [out] = await Promise.all([
              sleep(i % 3).then(() =>
                clearListing(
                  { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook },
                  input,
                ),
              ),
              sleep((i + 1) % 3).then(() =>
                replayPriceDrop(deps(), { listingId: m.listingId, priceCents: 24_500 }),
              ),
            ]);
            if (!out.ok) expect(out.error).toMatchObject({ reason: 'BOOK_CHANGED' });
            await expectInvariants(m);
          }
        } finally {
          fake.jitterMs = 0;
        }
      });

      it('a raise landing during processing is caught by the re-run selection', async () => {
        const m = await market();
        const first = await held(m, 24_900);
        const raised = await held(m, 24_000); // below the drop: not selected in round 1
        // The raise passed its public-price guard before the event (public $279), and its PayPal
        // hold is slow, so it lands while the watcher is mid-run.
        fake.latencyMs = 150;
        const raiseP = raiseBid(bidDeps(), {
          bidId: raised.id,
          amountCents: 26_000,
          shopperId: raised.shopperId,
          idempotencyKey: randomUUID(),
        });
        await sleep(50);
        const rounds: string[][] = [];
        const out = await replayPriceDrop(
          deps({
            afterSelect: async (round, ids) => {
              rounds.push([...ids]);
              if (round === 1) {
                const r = await raiseP;
                if (!r.ok) throw new Error(`raise failed: ${JSON.stringify(r.error)}`);
              }
            },
          }),
          { listingId: m.listingId, priceCents: 24_500 },
        );
        fake.latencyMs = 0;
        expect(out.ok && !out.duplicate).toBe(true);
        if (!out.ok || out.duplicate) return;
        const newBid = await one<{ id: string; status: string; void_reason: string }>(
          `SELECT id, status, void_reason FROM bids WHERE replaces_bid_id = $1`,
          [raised.id],
        );
        expect(rounds[0]).toEqual([first.id]);
        expect(rounds[1]).toEqual([newBid.id]);
        expect(rounds.at(-1)).toEqual([]);
        expect(out.result.released.map((b) => b.bidId).sort()).toEqual(
          [first.id, newBid.id].sort(),
        );
        expect(newBid).toMatchObject({ status: 'VOIDED', void_reason: 'PRICE_DROP' });
        expect(await status(raised.id)).toMatchObject({
          status: 'VOIDED',
          void_reason: 'REPLACED',
        });
      });

      it('a shopper switching the release off mid-run keeps the bid (conditional flip repeats the rule)', async () => {
        const m = await market();
        const b = await held(m, 24_900);
        const out = await replayPriceDrop(
          deps({
            afterSelect: async (round) => {
              if (round === 1) {
                await db.pool.query(`UPDATE bids SET release_if_cheaper = false WHERE id = $1`, [
                  b.id,
                ]);
              }
            },
          }),
          { listingId: m.listingId, priceCents: 24_500 },
        );
        expect(out.ok && !out.duplicate && out.result.released).toEqual([]);
        expect((await status(b.id)).status).toBe('HELD');
        expect(voidsFor(b.id)).toHaveLength(0);
      });
    });
  },
);
