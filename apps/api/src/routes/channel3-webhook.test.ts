/**
 * HF-042b `POST /api/webhooks/channel3` over HTTP on real Postgres with `FakePayPal`: a signed
 * fixture delivery is verified, recorded, answered 200 at once and processed after the response
 * (voids on the stub); a duplicate delivery (sequential or concurrent) is a no-op; a bad, missing
 * or stale signature → 401 with nothing stored. Watcher logic is covered in
 * packages/core/src/price-watch. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/channel3-webhook
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditHook,
  Channel3FixtureClient,
  channel3WebhookHeaders,
  defaultFixturesDir,
  loadConfig,
  placeBid,
  type Channel3Product,
  type PriceEventResult,
} from '@holdfast/core';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { FakePayPal } from '../../../../packages/core/src/paypal/fake.js';
import { voidKey } from '../../../../packages/core/src/money/void.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';
import { CHANNEL3_WEBHOOK_PATH } from './channel3-webhook.js';

const WHSEC = `whsec_${Buffer.from('holdfast-test-channel3-secret').toString('base64')}`;
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: 'w'.repeat(40),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  CHANNEL3_WEBHOOK_SECRET: WHSEC,
};

/** The recorded fixture body (r4bivjG Color=Green, jcpenney.com $139 → $119.99). */
const fixture = JSON.parse(
  readFileSync(join(defaultFixturesDir(), 'webhooks', 'offer.price.changed.json'), 'utf8'),
) as { body: Record<string, unknown> };

describe.skipIf(!TEST_DATABASE_URL)(
  'HF-042b POST /api/webhooks/channel3',
  { timeout: 60_000 },
  () => {
    let tdb: TestDatabase;
    const fake = new FakePayPal();
    const paypal = fake.client();
    let pending: Array<() => Promise<void>>;
    let processed: Array<{ id: string; result: PriceEventResult }>;
    let app: FastifyInstance;
    let listingId: string;
    let mark = 0;

    const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await tdb.db.pool.query(sql, params)).rows[0] as T;
    const drain = async () => {
      while (pending.length) await pending.shift()!();
    };
    const fixtures = new Channel3FixtureClient();

    function server(secret: string | undefined = WHSEC): FastifyInstance {
      return buildServer(loadConfig({ ...ENV, CHANNEL3_WEBHOOK_SECRET: secret }), {
        webDistDir: null,
        sql: tdb.db,
        db: tdb.db.pool,
        limiter: new RateLimiter(),
        priceWatch: {
          db: tdb.db,
          paypal,
          audit: auditHook,
          voidBackoffMs: [0, 0, 0],
          channel3: { product: (id: string): Promise<Channel3Product> => fixtures.product(id) },
        },
        channel3Webhook: {
          schedule: (run) => pending.push(run),
          onProcessed: (id, result) => processed.push({ id, result }),
        },
      });
    }

    const event = (id = `evt_${randomUUID()}`, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ ...fixture.body, id, ...extra });
    const post = (raw: string, headers: Record<string, string>, target = app) =>
      target.inject({
        method: 'POST',
        url: CHANNEL3_WEBHOOK_PATH,
        headers: { 'content-type': 'application/json', ...headers },
        payload: raw,
      });
    const stored = async (id: string) =>
      Number(
        (await one<{ n: string }>(`SELECT count(*) AS n FROM webhook_events WHERE id = $1`, [id]))
          .n,
      );

    async function heldBid(amountCents: number): Promise<string> {
      const shopper = await one<{ id: string }>(
        `INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`,
      );
      const r = await placeBid(
        { db: tdb.db, paypal, voidBackoffMs: [0, 0, 0], audit: auditHook, allowTestCard: true },
        {
          shopperId: shopper.id,
          listingId,
          amountCents,
          paymentMethod: 'TEST_CARD',
          source: 'OFFER_PAGE',
          idempotencyKey: randomUUID(),
        },
      );
      if (!r.ok) throw new Error('hold failed');
      await tdb.db.pool.query(
        `UPDATE bids SET release_if_cheaper = true, public_price_at_placement = 13900 WHERE id = $1`,
        [r.bid.id],
      );
      return r.bid.id;
    }
    const bidStatus = async (id: string) =>
      (await one<{ status: string }>(`SELECT status FROM bids WHERE id = $1`, [id])).status;
    const voidsFor = (bidId: string) =>
      fake.calls.slice(mark).filter((c) => c.op === 'void' && c.requestId === voidKey(bidId));

    beforeAll(async () => {
      tdb = await createTestDatabase();
      const brand = await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email, authorized_domains, verification_status)
       VALUES ('Aurel Audio (demo)', 'payouts@aurel.example', '{jcpenney.com}', 'VERIFIED')
       RETURNING id`,
      );
      const product = await one<{ id: string }>(
        `INSERT INTO products (title, channel3_id, channel3_variant, channel3_subscription_id,
                             condition, best_public_price_cents, best_public_merchant,
                             best_public_offer_url, price_updated_at)
       VALUES ('JBL', 'r4bivjG', 'Color=Green', 'sub_fixture_r4bivjG_green', 'NEW', 13900,
               'jcpenney.com', 'https://buy.trychannel3.com/r4', now()) RETURNING id`,
      );
      listingId = (
        await one<{ id: string }>(
          `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, published_at,
                               window_opens_at, window_closes_at)
         VALUES ($1, $2, 'OPEN', 300, 9900, now(), now() - interval '1 hour', now() + interval '4 hours')
         RETURNING id`,
          [brand.id, product.id],
        )
      ).id;
    }, 60_000);
    beforeEach(() => {
      pending = [];
      processed = [];
      mark = fake.calls.length;
      app = server();
    });
    afterEach(async () => {
      await app?.close();
    });
    afterAll(async () => {
      await tdb?.close();
    });

    it('a signed fixture delivery → 200 at once, processed after the response, voids on the stub', async () => {
      const above = await heldBid(12_900); // $129 > $119.99 and placed when public was $139
      const below = await heldBid(11_000);
      const id = `evt_${randomUUID()}`;
      const raw = event(id);
      const res = await post(raw, channel3WebhookHeaders(WHSEC, raw, { messageId: `msg_${id}` }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
      // Recorded, not yet processed: the response did not wait for PayPal.
      const row = await one<{ provider: string; processed_at: Date | null }>(
        `SELECT provider, processed_at FROM webhook_events WHERE id = $1`,
        [id],
      );
      expect(row).toEqual({ provider: 'CHANNEL3', processed_at: null });
      expect(await bidStatus(above)).toBe('HELD');

      await drain();
      expect(processed).toHaveLength(1);
      expect(processed[0]!.result).toMatchObject({
        outcome: 'MATCHED',
        replayed: false,
        cheaper: { priceCents: 11_999, merchant: 'jcpenney.com' },
      });
      expect(await bidStatus(above)).toBe('VOIDED');
      expect(await bidStatus(below)).toBe('HELD');
      expect(voidsFor(above)).toHaveLength(1);
      expect(
        (
          await one<{ processed_at: Date | null }>(
            `SELECT processed_at FROM webhook_events WHERE id = $1`,
            [id],
          )
        ).processed_at,
      ).not.toBeNull();
      const a = await one<{ data: Record<string, unknown> }>(
        `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'BID_VOID_REQUESTED'`,
        [above],
      );
      expect(a.data).toMatchObject({ source: 'webhook', replayed: false, eventId: id });
      // The delivery is the heartbeat for the outage banner.
      const h = await one<{ last_event_at: Date | null }>(
        `SELECT last_event_at FROM channel3_health WHERE id`,
      );
      expect(h.last_event_at).not.toBeNull();

      // Channel3 retries the same event (new attempt, new timestamp): acknowledged, nothing else.
      const again = await post(raw, channel3WebhookHeaders(WHSEC, raw, { messageId: `msg_${id}` }));
      expect(again.statusCode).toBe(200);
      expect(pending).toHaveLength(0);
      expect(voidsFor(above)).toHaveLength(1);
    });

    it('two concurrent deliveries of one event release each bid once', async () => {
      const bid = await heldBid(12_500);
      const id = `evt_${randomUUID()}`;
      const raw = event(id);
      const [r1, r2] = await Promise.all([
        post(raw, channel3WebhookHeaders(WHSEC, raw)),
        post(raw, channel3WebhookHeaders(WHSEC, raw)),
      ]);
      expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
      // Both may be scheduled (neither saw processed_at yet); processing is idempotent.
      await Promise.all(pending.splice(0).map((run) => run()));
      expect(await bidStatus(bid)).toBe('VOIDED');
      expect(voidsFor(bid)).toHaveLength(1);
      expect(await stored(id)).toBe(1);
    });

    it('a bad, missing or stale signature → 401 and nothing stored', async () => {
      const id = `evt_${randomUUID()}`;
      const raw = event(id);
      const other = `whsec_${Buffer.from('someone-else').toString('base64')}`;
      const cases: Array<Record<string, string>> = [
        {},
        channel3WebhookHeaders(other, raw),
        // Signed for a different body (a captured signature replayed onto a forged price).
        channel3WebhookHeaders(WHSEC, event(id, { type: 'offer.deleted' })),
        channel3WebhookHeaders(WHSEC, raw, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
        { 'svix-id': 'm', 'svix-timestamp': String(Math.floor(Date.now() / 1000)) },
      ];
      for (const headers of cases) {
        const res = await post(raw, headers);
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('UNAUTHENTICATED');
      }
      expect(await stored(id)).toBe(0);
      expect(pending).toHaveLength(0);
    });

    it('no secret configured → 502 so Channel3 retries later; nothing stored', async () => {
      const id = `evt_${randomUUID()}`;
      const raw = event(id);
      const unconfigured = server('');
      const res = await post(raw, channel3WebhookHeaders(WHSEC, raw), unconfigured);
      await unconfigured.close();
      expect(res.statusCode).toBe(502);
      expect(await stored(id)).toBe(0);
    });

    it('a live body cannot pose as a replay or carry its own product detail', async () => {
      const id = `evt_${randomUUID()}`;
      const raw = event(id, {
        replayed: true,
        label: 'replayed event (demo)',
        detail: { id: 'r4bivjG', title: 'forged', offers: [] },
        data: { ...(fixture.body.data as object), source: 'poll' },
      });
      const res = await post(raw, channel3WebhookHeaders(WHSEC, raw));
      expect(res.statusCode).toBe(200);
      const row = await one<{
        payload: Record<string, unknown> & { data: Record<string, unknown> };
      }>(`SELECT payload FROM webhook_events WHERE id = $1`, [id]);
      expect(row.payload.replayed).toBeUndefined();
      expect(row.payload.detail).toBeUndefined();
      expect(row.payload.data.source).toBeUndefined();
    });

    it('a non-event JSON body → 400; not JSON → 400', async () => {
      const raw = JSON.stringify({ hello: 'world' });
      expect((await post(raw, channel3WebhookHeaders(WHSEC, raw))).statusCode).toBe(400);
      const junk = 'not json';
      expect((await post(junk, channel3WebhookHeaders(WHSEC, junk))).statusCode).toBe(400);
    });
  },
);
