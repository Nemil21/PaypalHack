/**
 * HF-044a `/mcp`: the four tools through the MCP client SDK (Streamable HTTP) against the real
 * server (HF-043 token guard + scope gate, real `mcp_clients` tokens) on Postgres with the
 * `FakePayPal` stub. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/mcp/server.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditHook,
  createMcpClient,
  FakePayPal,
  LISTING_EVENTS_CHANNEL,
  loadConfig,
  orderRequestId,
  SANDBOX_TEST_CARD,
  type PayPalClient,
} from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: 'm'.repeat(40),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  PAYPAL_MODE: 'stub',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  APP_BASE_URL: 'https://holdfast.example',
};

type Result = CallToolResult & { structuredContent?: Record<string, unknown> };

describe.skipIf(!TEST_DATABASE_URL)('HF-044a MCP server', () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let app: ReturnType<typeof buildServer>;
  let baseUrl: URL;
  const clients: Client[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      // Generous MCP limit: these tests make many calls per token.
      limiter: new RateLimiter({ mcp: 1_000, rest: 1_000, agent: 10, magicLink: 10 }),
      bids: {
        money: { db: tdb.db, paypal: client, audit: auditHook, voidBackoffMs: [0, 0, 0] },
      },
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = new URL('/mcp', address);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await app?.close();
    await tdb?.close();
  });
  beforeEach(() => {
    fake.latencyMs = 0;
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    tdb.db.pool.query(sql, params).then((r) => r.rows as T[]);

  async function listing(cols: Parameters<Fixtures['listing']>[0] = {}) {
    const l = await fx.listing(cols);
    const slug = `aurel-a7-${randomUUID().slice(0, 8)}`;
    await q(`UPDATE listings SET slug = $2 WHERE id = $1`, [l.id, slug]);
    await q(
      `UPDATE products SET best_public_price_cents = 26_900, best_public_merchant = 'Best Buy',
              image_url = 'https://img.example/a7.png'
        WHERE id = (SELECT product_id FROM listings WHERE id = $1)`,
      [l.id],
    );
    return { id: l.id, slug };
  }

  /** A shopper with a FakePayPal card vault (as HF-014b's card fields would leave it). */
  async function vaultedShopper(): Promise<string> {
    const s = await fx.shopper();
    const r = await client.createAuthOrder({
      requestId: orderRequestId(randomUUID()),
      amountCents: 100,
      paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD, vault: true },
    });
    if (r.kind !== 'held' || !r.vault?.id) throw new Error('no vault');
    await q(`UPDATE shoppers SET paypal_vault_id = $2 WHERE id = $1`, [s.id, r.vault.id]);
    return s.id;
  }

  /** W19 readiness green: saved card + a covering ACTIVE mandate. */
  async function readyShopper(mandate: { maxPriceCents?: number; capCents?: number } = {}) {
    const shopperId = await vaultedShopper();
    await fx.mandate(shopperId, mandate);
    return shopperId;
  }

  async function connect(shopperId: string, scopes: Array<'read' | 'bid'> = ['read', 'bid']) {
    const { token, client: row } = await createMcpClient(tdb.db, {
      shopperId,
      name: 'Claude Desktop',
      scopes,
    });
    const c = new Client({ name: 'hf-044a-test', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(baseUrl, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(c);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      c.callTool({ name, arguments: args }) as Promise<Result>;
    return { c, call, clientId: row.id };
  }

  const text = (r: Result) => (r.content[0] as { text: string }).text;
  // Tool results are free-form JSON; assertions narrow them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (r: Result) => r.structuredContent as Record<string, any>;
  const createCalls = () => fake.calls.filter((x) => x.op === 'order_create').length;

  // -------------------------------------------------------------------------------------------

  it('lists the four tools with plain-money descriptions and cents schemas', async () => {
    const s = await fx.shopper();
    const { c } = await connect(s.id);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_bid',
      'get_book',
      'my_bids',
      'place_bid',
    ]);
    const place = tools.find((t) => t.name === 'place_bid')!;
    expect(place.description).toContain(
      "Places a real PayPal hold. If you win, you're charged exactly amountCents; otherwise it's released.",
    );
    const amount = (place.inputSchema.properties as Record<string, Record<string, unknown>>)
      .amountCents!;
    expect(amount.description).toContain('integer US cents, e.g. 21500 = $215.00');
    expect(amount).toMatchObject({ type: 'integer', minimum: 100, maximum: 1_000_000 });
    expect(place.inputSchema.required).toEqual(
      expect.arrayContaining(['listingSlug', 'amountCents', 'idempotencyKey']),
    );
  });

  it('GET /mcp is 405 (stateless: no standalone stream)', async () => {
    const s = await fx.shopper();
    const { token } = await createMcpClient(tdb.db, {
      shopperId: s.id,
      name: 'x',
      scopes: ['read'],
    });
    const res = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
  });

  describe('get_book', () => {
    it('product, price, window, phase and merged bands; floor and shoppers never appear', async () => {
      const l = await listing();
      // 3 bids in $210s, 2 in $230s and 1 in $250s: the thin top buckets merge into one band.
      const amounts = [21_000, 21_500, 21_900, 23_000, 23_500, 25_000];
      const shoppers: string[] = [];
      for (const a of amounts) {
        const s = await fx.shopper();
        shoppers.push(s.id);
        await fx.heldBid(l.id, s.id, { amountCents: a });
      }
      // Not eligible (D8): pending and voided bids don't count.
      await fx.pendingBid(l.id, (await fx.shopper()).id, { amountCents: 40_000 });

      const viewer = await fx.shopper();
      const { call } = await connect(viewer.id, ['read']);
      const first = await call('get_book', { listingSlug: l.slug });
      expect(first.isError).toBeFalsy();
      expect(data(first)).toMatchObject({
        listingSlug: l.slug,
        product: { title: 'Aurel One', imageUrl: 'https://img.example/a7.png' },
        bestPublicPriceCents: 26_900,
        bestPublicPriceFormatted: '$269',
        status: 'OPEN',
        phase: 'BIDDING',
        biddable: true,
      });
      expect(data(first).windowClosesAt).toEqual(expect.any(String));
      expect(data(first).demandBands).toEqual([
        { fromCents: 23_000, toCents: 26_000, bids: 3, rangeFormatted: '$230–$260' },
        { fromCents: 21_000, toCents: 22_000, bids: 3, rangeFormatted: '$210–$220' },
      ]);

      const raw = text(first);
      expect(raw).not.toMatch(/floor/i);
      expect(raw).not.toContain('10000');
      for (const id of shoppers) expect(raw).not.toContain(id);
      // Exact amounts never appear (band edges are whole $10 steps).
      for (const a of [21_500, 21_900, 23_500]) expect(raw).not.toContain(String(a));

      // Changing the floor never changes the response.
      await q(`UPDATE listings SET floor_cents = 24_000 WHERE id = $1`, [l.id]);
      const second = await call('get_book', { listingSlug: l.slug });
      expect(text(second)).toBe(raw);
    });

    it('a book with fewer than 3 eligible bids shows no bands', async () => {
      const l = await listing();
      await fx.heldBid(l.id, (await fx.shopper()).id, { amountCents: 21_500 });
      const { call } = await connect((await fx.shopper()).id, ['read']);
      expect(data(await call('get_book', { listingSlug: l.slug })).demandBands).toEqual([]);
    });

    it('DRAFT and unknown slugs → NOT_FOUND tool error', async () => {
      const l = await listing({ status: 'DRAFT' });
      const { call } = await connect((await fx.shopper()).id, ['read']);
      for (const slug of [l.slug, 'no-such-listing']) {
        const r = await call('get_book', { listingSlug: slug });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/^NOT_FOUND: /);
      }
    });
  });

  describe('place_bid', () => {
    it('ready shopper → HELD VAULT hold, source MCP, audit MCP_CLIENT, bid.held notified < 2 s', async () => {
      const l = await listing();
      const shopperId = await readyShopper();
      const { call, clientId } = await connect(shopperId);

      const listener = new pg.Client({ connectionString: tdb.url });
      await listener.connect();
      await listener.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
      const notified = new Promise<number>((resolve) => {
        listener.on('notification', (n) => {
          const p = JSON.parse(n.payload ?? '{}') as { listingId?: string; type?: string };
          if (p.listingId === l.id && p.type === 'bid.held') resolve(Date.now());
        });
      });

      try {
        const started = Date.now();
        const r = await call('place_bid', {
          listingSlug: l.slug,
          amountCents: 21_500,
          idempotencyKey: 'k-1',
        });
        expect(r.isError).toBeFalsy();
        expect(data(r)).toMatchObject({
          status: 'HELD',
          amountCents: 21_500,
          amountFormatted: '$215',
          listingSlug: l.slug,
        });
        expect(text(r)).toContain("you're charged exactly $215");
        expect((await notified) - started).toBeLessThan(2_000);

        const bid = await fx.bid(data(r).bidId);
        expect(bid).toMatchObject({
          status: 'HELD',
          source: 'MCP',
          payment_method: 'VAULT',
          shopper_id: shopperId,
        });
        expect(bid.mandate_id).toEqual(expect.any(String));
        expect(fake.authorization(bid.paypal_authorization_id as string)?.status).toBe('CREATED');
        const audits = await q<{ actor_type: string; actor_id: string }>(
          `SELECT actor_type, actor_id FROM audit_events WHERE entity_id = $1`,
          [bid.id],
        );
        expect(audits.length).toBeGreaterThan(0);
        for (const a of audits) expect(a).toEqual({ actor_type: 'MCP_CLIENT', actor_id: clientId });
      } finally {
        await listener.end();
      }
    });

    it('no saved card → our offer-page link, no bid, no PayPal call', async () => {
      const l = await listing();
      const s = await fx.shopper();
      await fx.mandate(s.id);
      const { call } = await connect(s.id);
      const before = createCalls();
      const r = await call('place_bid', {
        listingSlug: l.slug,
        amountCents: 21_500,
        idempotencyKey: 'k-link',
      });
      expect(r.isError).toBeFalsy();
      expect(data(r)).toMatchObject({
        bidId: null,
        status: 'NEEDS_APPROVAL',
        amountCents: 21_500,
        amountFormatted: '$215',
        reason: 'NO_SAVED_PAYMENT_METHOD',
        offerUrl: `https://holdfast.example/o/${l.slug}?amount=21500&src=mcp`,
      });
      expect(data(r).message).toContain('Open this link to approve the PayPal hold.');
      expect(createCalls()).toBe(before);
      expect(await q(`SELECT 1 FROM bids WHERE shopper_id = $1`, [s.id])).toHaveLength(0);
    });

    it('saved card but no covering mandate (none, above max, over cap, paused) → link, no hold', async () => {
      const l = await listing();
      const cases: Array<[string, (s: string) => Promise<unknown>]> = [
        ['NO_ACTIVE_MANDATE', async () => undefined],
        ['ABOVE_MANDATE_MAX', (s) => fx.mandate(s, { maxPriceCents: 20_000 })],
        ['MANDATE_EXCEEDED', (s) => fx.mandate(s, { capCents: 21_000 })],
        ['NO_ACTIVE_MANDATE', (s) => fx.mandate(s, { status: 'PAUSED' })],
      ];
      for (const [reason, setup] of cases) {
        const s = await vaultedShopper();
        await setup(s);
        const { call } = await connect(s);
        const before = createCalls();
        const r = await call('place_bid', {
          listingSlug: l.slug,
          amountCents: 21_500,
          idempotencyKey: randomUUID(),
        });
        expect(data(r)).toMatchObject({ status: 'NEEDS_APPROVAL', reason, bidId: null });
        expect(createCalls()).toBe(before);
        expect(await q(`SELECT 1 FROM bids WHERE shopper_id = $1`, [s])).toHaveLength(0);
      }
    });

    it('the offer-link answer is not stored: the same key holds once the shopper is ready', async () => {
      const l = await listing();
      const s = await vaultedShopper();
      const { call } = await connect(s);
      const args = { listingSlug: l.slug, amountCents: 21_500, idempotencyKey: 'k-later' };
      expect(data(await call('place_bid', args)).status).toBe('NEEDS_APPROVAL');
      await fx.mandate(s);
      expect(data(await call('place_bid', args)).status).toBe('HELD');
    });

    it('a second place_bid on the same listing → ALREADY_BID {bidId, amountCents} "Use raise_bid"', async () => {
      const l = await listing();
      const { call } = await connect(await readyShopper());
      const first = await call('place_bid', {
        listingSlug: l.slug,
        amountCents: 21_500,
        idempotencyKey: 'a',
      });
      const before = createCalls();
      const second = await call('place_bid', {
        listingSlug: l.slug,
        amountCents: 23_000,
        idempotencyKey: 'b',
      });
      expect(second.isError).toBe(true);
      expect(text(second)).toMatch(/^ALREADY_BID: .*Use raise_bid/);
      expect(data(second).error).toMatchObject({
        code: 'ALREADY_BID',
        bidId: data(first).bidId,
        amountCents: 21_500,
      });
      expect(createCalls()).toBe(before);
    });

    it('same key + same body replays one hold; same key + different amount → DUPLICATE', async () => {
      const l = await listing();
      const { call } = await connect(await readyShopper());
      const args = { listingSlug: l.slug, amountCents: 21_500, idempotencyKey: 'dup' };
      const first = await call('place_bid', args);
      const before = createCalls();
      const again = await call('place_bid', args);
      expect(again.isError).toBeFalsy();
      expect(data(again).bidId).toBe(data(first).bidId);

      const diff = await call('place_bid', { ...args, amountCents: 30_000 });
      expect(diff.isError).toBe(true);
      expect(text(diff)).toBe(
        'DUPLICATE: This idempotencyKey was used for a $215 bid. Use a new key for a new bid.',
      );
      expect(createCalls()).toBe(before);
    });

    it('two shoppers using the same idempotencyKey get independent bids', async () => {
      const l = await listing();
      const a = await connect(await readyShopper());
      const b = await connect(await readyShopper());
      const ra = await a.call('place_bid', {
        listingSlug: l.slug,
        amountCents: 21_500,
        idempotencyKey: 'shared-key',
      });
      const rb = await b.call('place_bid', {
        listingSlug: l.slug,
        amountCents: 22_000,
        idempotencyKey: 'shared-key',
      });
      expect(data(ra)).toMatchObject({ status: 'HELD', amountCents: 21_500 });
      expect(data(rb)).toMatchObject({ status: 'HELD', amountCents: 22_000 });
      expect(data(ra).bidId).not.toBe(data(rb).bidId);
    });

    it('race: the same key fired 5× at once makes exactly one PayPal order and one bid', async () => {
      const l = await listing();
      const shopperId = await readyShopper();
      const { call } = await connect(shopperId);
      fake.latencyMs = 150;
      const before = createCalls();
      const args = { listingSlug: l.slug, amountCents: 21_500, idempotencyKey: 'race-same' };
      const results = await Promise.all(Array.from({ length: 5 }, () => call('place_bid', args)));
      fake.latencyMs = 0;

      expect(createCalls() - before).toBe(1);
      const bids = await q<{ id: string; status: string }>(
        `SELECT id, status FROM bids WHERE shopper_id = $1 AND listing_id = $2`,
        [shopperId, l.id],
      );
      expect(bids).toEqual([{ id: expect.any(String), status: 'HELD' }]);
      for (const r of results) {
        if (r.isError) expect(text(r)).toMatch(/^IN_PROGRESS: /);
        else expect(data(r).bidId).toBe(bids[0]!.id);
      }
      expect(results.filter((r) => !r.isError).length).toBeGreaterThanOrEqual(1);
    });

    it('race: different keys on one listing at once → one live bid, the rest ALREADY_BID', async () => {
      const l = await listing();
      const shopperId = await readyShopper();
      const { call } = await connect(shopperId);
      fake.latencyMs = 100;
      const results = await Promise.all(
        [21_500, 22_000, 22_500, 23_000].map((amountCents, i) =>
          call('place_bid', { listingSlug: l.slug, amountCents, idempotencyKey: `race-${i}` }),
        ),
      );
      fake.latencyMs = 0;
      const live = await q(
        `SELECT 1 FROM bids WHERE shopper_id = $1 AND listing_id = $2
            AND status IN ('PENDING_APPROVAL', 'HELD')`,
        [shopperId, l.id],
      );
      expect(live).toHaveLength(1);
      expect(results.filter((r) => !r.isError)).toHaveLength(1);
      for (const r of results.filter((x) => x.isError)) expect(text(r)).toMatch(/^ALREADY_BID: /);
    });

    it('race: the mandate cap holds across listings placed at once', async () => {
      const [l1, l2, l3] = [await listing(), await listing(), await listing()];
      // Each bid fits the cap alone; only two fit together.
      const shopperId = await readyShopper({ capCents: 45_000 });
      const { call } = await connect(shopperId);
      fake.latencyMs = 100;
      const results = await Promise.all(
        [l1, l2, l3].map((l, i) =>
          call('place_bid', {
            listingSlug: l.slug,
            amountCents: 20_000,
            idempotencyKey: `cap-${i}`,
          }),
        ),
      );
      fake.latencyMs = 0;
      const held = await q<{ total: string }>(
        `SELECT coalesce(sum(amount_cents), 0) AS total FROM bids
          WHERE shopper_id = $1 AND status = 'HELD'`,
        [shopperId],
      );
      expect(Number(held[0]!.total)).toBeLessThanOrEqual(45_000);
      expect(results.filter((r) => !r.isError && data(r).status === 'HELD')).toHaveLength(2);
    });

    it('closed window → WINDOW_CLOSED; bad amount → tool error; read-only token → FORBIDDEN', async () => {
      const closed = await listing({ closesInHours: -1 });
      const open = await listing();
      const shopperId = await readyShopper();
      const { call } = await connect(shopperId);
      const before = createCalls();

      const wc = await call('place_bid', {
        listingSlug: closed.slug,
        amountCents: 21_500,
        idempotencyKey: 'wc',
      });
      expect(wc.isError).toBe(true);
      expect(text(wc)).toMatch(/^WINDOW_CLOSED: /);

      for (const amountCents of [215.5, 50, 2_000_000]) {
        const bad = await call('place_bid', {
          listingSlug: open.slug,
          amountCents,
          idempotencyKey: `bad-${amountCents}`,
        });
        expect(bad.isError).toBe(true);
      }

      const ro = await connect(shopperId, ['read']);
      const forbidden = await ro.call('place_bid', {
        listingSlug: open.slug,
        amountCents: 21_500,
        idempotencyKey: 'ro',
      });
      expect(forbidden.isError).toBe(true);
      expect(text(forbidden)).toMatch(/^FORBIDDEN: /);
      expect(createCalls()).toBe(before);
    });
  });

  describe('cancel_bid', () => {
    it('releases the hold; repeating returns the status with no second void', async () => {
      const l = await listing();
      const { call } = await connect(await readyShopper());
      const placed = await call('place_bid', {
        listingSlug: l.slug,
        amountCents: 21_500,
        idempotencyKey: 'c',
      });
      const bidId = data(placed).bidId as string;

      const first = await call('cancel_bid', { bidId });
      expect(first.isError).toBeFalsy();
      expect(data(first)).toMatchObject({
        bidId,
        status: 'VOIDED',
        amountCents: 21_500,
        amountFormatted: '$215',
      });
      const voids = () => fake.calls.filter((x) => x.op === 'void').length;
      const before = voids();
      const again = await call('cancel_bid', { bidId });
      expect(data(again)).toMatchObject({ bidId, status: 'VOIDED' });
      expect(voids()).toBe(before);
    });

    it("another shopper's bid and junk ids → NOT_FOUND", async () => {
      const l = await listing();
      const owner = await fx.shopper();
      const bid = await fx.heldBid(l.id, owner.id);
      const { call } = await connect((await fx.shopper()).id);
      for (const bidId of [bid.id, randomUUID(), 'not-a-uuid']) {
        const r = await call('cancel_bid', { bidId });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/^NOT_FOUND: /);
      }
      expect((await fx.bid(bid.id)).status).toBe('HELD');
    });
  });

  describe('my_bids', () => {
    it('own bids only; belowCutoff/cutoffCents null outside ROUNDS, real values in ROUNDS', async () => {
      const open = await listing();
      const rounds = await listing({ status: 'ROUNDS', roundsEndInHours: 1 });
      await q(`UPDATE listings SET current_round = 1 WHERE id = $1`, [rounds.id]);
      const s = await fx.shopper();
      const other = await fx.shopper();
      const a = await fx.heldBid(open.id, s.id, { amountCents: 21_500 });
      const b = await fx.heldBid(rounds.id, s.id, { amountCents: 22_000 });
      await fx.heldBid(open.id, other.id, { amountCents: 30_000 });
      await q(
        `INSERT INTO nudges (listing_id, round, shopper_id, bid_id, cutoff_cents, target_cents,
                             your_bid_cents, sent_at)
         VALUES ($1, 1, $2, $3, 24_000, 24_500, 22_000, now())`,
        [rounds.id, s.id, b.id],
      );

      const { call } = await connect(s.id, ['read']);
      const r = await call('my_bids');
      expect(r.isError).toBeFalsy();
      const bids = data(r).bids as Array<Record<string, unknown>>;
      expect(bids.map((x) => x.bidId).sort()).toEqual([a.id, b.id].sort());
      expect(bids.find((x) => x.bidId === a.id)).toMatchObject({
        listingSlug: open.slug,
        amountCents: 21_500,
        amountFormatted: '$215',
        status: 'HELD',
        belowCutoff: null,
        cutoffCents: null,
      });
      expect(bids.find((x) => x.bidId === b.id)).toMatchObject({
        listingSlug: rounds.slug,
        amountCents: 22_000,
        belowCutoff: true,
        cutoffCents: 24_000,
        cutoffFormatted: '$240',
      });
    });
  });
});
