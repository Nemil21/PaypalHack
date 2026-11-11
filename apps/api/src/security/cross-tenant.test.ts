/**
 * HF-047 cross-tenant matrix (features/16 §Multi-tenancy rules): every brand endpoint called as
 * another brand → 404, every shopper endpoint called as another shopper → 404, an MCP token of
 * shopper A can't touch shopper B's bids, and `/mcp` ignores session cookies. Runs through the
 * real server (guards, CSRF, Idempotency-Key store) on Postgres with the `FakePayPal` stub.
 * A 404 must not leak existence: the owner gets a non-404 on the same reads, and nothing the
 * foreign calls touched changes state. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/security
 */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook, createMcpClient, FakePayPal, loadConfig } from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { ListingEventBus } from '../events/bus.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 't'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  PAYPAL_MODE: 'stub',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  APP_BASE_URL: 'https://holdfast.example',
};

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
interface Call {
  name: string;
  method: Method;
  url: string;
  payload?: object;
  /** The owner's read must succeed, so the foreign 404 is tenancy, not a missing row or route. */
  ownerOk?: boolean;
}
type Result = CallToolResult & { structuredContent?: Record<string, unknown> };

describe.skipIf(!TEST_DATABASE_URL)('HF-047 cross-tenant matrix', () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let fake: FakePayPal;
  let bus: ListingEventBus;
  let app: ReturnType<typeof buildServer>;
  let mcpUrl: URL;
  const mcpClients: Client[] = [];

  // Brand A owns listing A (OPEN, one HELD bid from shopper A); brand B is the intruder.
  let brandA: { brandId: string; userId: string };
  let brandB: { brandId: string; userId: string };
  let listingA: { id: string; slug: string };
  let shopperA: string;
  let shopperB: string;
  let bidA: { id: string; paypal_authorization_id: string };
  let mandateA: string;
  let conversationA: string;
  let actionA: string;
  let mcpClientA: string;
  let tokenA: string;
  let tokenB: string;
  let shopperNoteA: string;
  let brandNoteA: string;
  // HF-056 team settings: a VIEWER on brand A's team and a pending brand A invite.
  let viewerA: string;
  let inviteA: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;

  async function brandWithOwner(name: string) {
    const brandId = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email, verification_status, verified_at)
         VALUES ($1, 'p@brand.example', 'VERIFIED', now())
         RETURNING id`,
        [name],
      )
    ).id;
    const userId = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
        [brandId, `${randomUUID()}@brand.example`],
      )
    ).id;
    return { brandId, userId };
  }

  const brandCookie = (userId: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 600_000 })}`;
  const shopperCookie = (shopperId: string) =>
    `${SHOPPER_COOKIE}=${signToken(SECRET, 'shopper-session', { sub: shopperId, exp: Date.now() + 600_000 })}`;

  const send = (cookie: string, c: Call) =>
    app.inject({
      method: c.method,
      url: c.url,
      headers: {
        cookie,
        ...(c.method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      },
      ...(c.payload ? { payload: c.payload } : {}),
    });

  function expectNotFound(c: Call, res: LightMyRequestResponse) {
    expect({ call: c.name, status: res.statusCode }).toEqual({ call: c.name, status: 404 });
    expect(res.json().error.code).toBe('NOT_FOUND');
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    fake = new FakePayPal();
    const paypal = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    const money = {
      db: tdb.db,
      paypal,
      audit: auditHook,
      voidBackoffMs: [0, 0, 0],
      allowTestCard: true,
    };
    // Never started: the foreign 404s answer before a stream would subscribe.
    bus = new ListingEventBus({ connectionString: tdb.url });
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter({ mcp: 1_000, rest: 10_000, agent: 100, magicLink: 10 }),
      bids: { money },
      clear: { money },
      listings: { money },
      events: bus,
    });
    mcpUrl = new URL('/mcp', await app.listen({ host: '127.0.0.1', port: 0 }));

    brandA = await brandWithOwner('Aurel Audio');
    brandB = await brandWithOwner('Rival Audio');
    const product = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    const slug = `aurel-one-${randomUUID().slice(0, 8)}`;
    listingA = {
      slug,
      id: (
        await one<{ id: string }>(
          `INSERT INTO listings (brand_id, product_id, slug, status, quantity, floor_cents,
                                 window_opens_at, window_closes_at)
           VALUES ($1, $2, $3, 'OPEN', 10, 10000, now() - interval '1 hour', now() + interval '1 day')
           RETURNING id`,
          [brandA.brandId, product.id, slug],
        )
      ).id,
    };

    viewerA = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'VIEWER') RETURNING id`,
        [brandA.brandId, `${randomUUID()}@brand.example`],
      )
    ).id;
    inviteA = (
      await one<{ id: string }>(
        `INSERT INTO brand_invites (brand_id, role, token_hash, created_by_user_id, expires_at)
         VALUES ($1, 'MANAGER', $2, $3, now() + interval '1 day') RETURNING id`,
        [brandA.brandId, randomUUID(), brandA.userId],
      )
    ).id;

    shopperA = (await fx.shopper()).id;
    shopperB = (await fx.shopper()).id;
    mandateA = (await fx.mandate(shopperA)).id;
    bidA = await fx.heldBid(listingA.id, shopperA, { amountCents: 22_000 });
    // Shopper B has a bid of their own, so "B sees only B" is checked on a non-empty list.
    await fx.heldBid(listingA.id, shopperB, { amountCents: 21_000 });
    conversationA = (
      await one<{ id: string }>(
        `INSERT INTO agent_conversations (shopper_id, title) VALUES ($1, 'Headphones') RETURNING id`,
        [shopperA],
      )
    ).id;
    await one(
      `INSERT INTO agent_messages (conversation_id, shopper_id, seq, role, content)
       VALUES ($1, $2, 1, 'user', '[{"type":"text","text":"find me headphones"}]')`,
      [conversationA, shopperA],
    );
    actionA = (
      await one<{ id: string }>(
        `INSERT INTO agent_pending_actions (conversation_id, shopper_id, tool, args, expires_at)
         VALUES ($1, $2, 'cancel_bid', $3, now() + interval '1 hour') RETURNING id`,
        [conversationA, shopperA, JSON.stringify({ bidId: bidA.id })],
      )
    ).id;
    const issuedA = await createMcpClient(tdb.db, {
      shopperId: shopperA,
      name: 'Claude Desktop',
      scopes: ['read', 'bid'],
    });
    mcpClientA = issuedA.client.id;
    tokenA = issuedA.token;
    tokenB = (
      await createMcpClient(tdb.db, {
        shopperId: shopperB,
        name: 'Cursor',
        scopes: ['read', 'bid'],
      })
    ).token;
    shopperNoteA = (
      await one<{ id: string }>(
        `INSERT INTO notifications (recipient_type, recipient_id, template)
         VALUES ('SHOPPER', $1, 'bid_held') RETURNING id`,
        [shopperA],
      )
    ).id;
    brandNoteA = (
      await one<{ id: string }>(
        `INSERT INTO notifications (recipient_type, recipient_id, template)
         VALUES ('BRAND', $1, 'listing_published') RETURNING id`,
        [brandA.brandId],
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(mcpClients.map((c) => c.close().catch(() => undefined)));
    await app?.close();
    await bus?.close();
    await tdb?.close();
  });

  async function stateSnapshot() {
    return one(
      `SELECT (SELECT status FROM listings WHERE id = $1) AS listing,
              (SELECT quantity FROM listings WHERE id = $1) AS quantity,
              (SELECT rounds_end_at FROM listings WHERE id = $1) AS rounds,
              (SELECT status FROM bids WHERE id = $2) AS bid,
              (SELECT amount_cents FROM bids WHERE id = $2) AS amount,
              (SELECT release_if_cheaper FROM bids WHERE id = $2) AS release_if_cheaper,
              (SELECT row_to_json(m)::text FROM mandates m WHERE id = $3) AS mandate,
              (SELECT status FROM agent_pending_actions WHERE id = $4) AS action,
              (SELECT revoked_at FROM mcp_clients WHERE id = $5) AS mcp_revoked,
              (SELECT array_agg(read_at) FROM notifications WHERE id IN ($6, $7)) AS reads,
              (SELECT role FROM brand_users WHERE id = $8) AS viewer_role,
              (SELECT revoked_at FROM brand_invites WHERE id = $9) AS invite_revoked`,
      [
        listingA.id,
        bidA.id,
        mandateA,
        actionA,
        mcpClientA,
        shopperNoteA,
        brandNoteA,
        viewerA,
        inviteA,
      ],
    );
  }

  describe('brand endpoints as another brand → 404', () => {
    const brandCalls = (): Call[] => {
      const l = `/api/listings/${listingA.id}`;
      return [
        { name: 'book', method: 'GET', url: `${l}/book`, ownerOk: true },
        { name: 'simulate', method: 'GET', url: `${l}/simulate?quantity=1`, ownerOk: true },
        { name: 'settlement', method: 'GET', url: `${l}/settlement`, ownerOk: true },
        { name: 'brand bid view', method: 'GET', url: `${l}/bids/${bidA.id}`, ownerOk: true },
        { name: 'share', method: 'GET', url: `${l}/share`, ownerOk: true },
        { name: 'rounds activity', method: 'GET', url: `${l}/rounds/activity`, ownerOk: true },
        { name: 'events (SSE)', method: 'GET', url: `${l}/events` },
        { name: 'publish', method: 'POST', url: `${l}/publish` },
        { name: 'patch quantity', method: 'PATCH', url: l, payload: { quantity: 20 } },
        {
          name: 'clear',
          method: 'POST',
          url: `${l}/clear`,
          payload: { quantity: 1, expectedGrossCents: 22_000 },
        },
        { name: 'cancel', method: 'POST', url: `${l}/cancel` },
        {
          name: 'rounds start',
          method: 'POST',
          url: `${l}/rounds/start`,
          payload: { targetQuantity: 1 },
        },
        { name: 'rounds next', method: 'POST', url: `${l}/rounds/next`, payload: {} },
        { name: 'rounds stop', method: 'POST', url: `${l}/rounds/stop` },
        {
          name: 'rounds target',
          method: 'PATCH',
          url: `${l}/rounds`,
          payload: { targetQuantity: 2 },
        },
        {
          name: 'team role change',
          method: 'PATCH',
          url: `/api/brands/me/team/${viewerA}`,
          payload: { role: 'MANAGER' },
        },
        { name: 'team remove', method: 'DELETE', url: `/api/brands/me/team/${viewerA}` },
        { name: 'invite revoke', method: 'DELETE', url: `/api/brands/me/invites/${inviteA}` },
        {
          name: 'brand notification read',
          method: 'POST',
          url: `/api/notifications/${brandNoteA}/read?as=brand`,
        },
      ];
    };

    it('every listing-scoped route answers 404 and changes nothing', async () => {
      const before = await stateSnapshot();
      const voidsBefore = fake.calls.length;
      for (const c of brandCalls()) expectNotFound(c, await send(brandCookie(brandB.userId), c));
      expect(await stateSnapshot()).toEqual(before);
      expect(fake.calls.length).toBe(voidsBefore);
    });

    it("the owner's reads succeed (the 404 is tenancy, not a missing row)", async () => {
      for (const c of brandCalls().filter((x) => x.ownerOk)) {
        const res = await send(brandCookie(brandA.userId), c);
        expect({ call: c.name, status: res.statusCode }).toEqual({ call: c.name, status: 200 });
      }
    });

    it("lists, overview and notifications never include the other brand's rows", async () => {
      const cookie = brandCookie(brandB.userId);
      const get = (url: string) => send(cookie, { name: url, method: 'GET', url });
      for (const url of [
        '/api/listings',
        '/api/brands/me/overview',
        '/api/notifications?as=brand',
        '/api/brands/me/settings',
      ]) {
        const res = await get(url);
        expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
        expect(res.body).not.toContain(listingA.id);
        expect(res.body).not.toContain(brandNoteA);
        expect(res.body).not.toContain(bidA.id);
        expect(res.body).not.toContain(viewerA);
        expect(res.body).not.toContain(inviteA);
      }
      const own = await send(brandCookie(brandA.userId), {
        name: 'own listings',
        method: 'GET',
        url: '/api/listings',
      });
      expect(own.body).toContain(listingA.id);
      const ownSettings = await send(brandCookie(brandA.userId), {
        name: 'own settings',
        method: 'GET',
        url: '/api/brands/me/settings',
      });
      expect(ownSettings.body).toContain(viewerA);
      expect(ownSettings.body).toContain(inviteA);
    });
  });

  describe('shopper endpoints as another shopper → 404', () => {
    const shopperCalls = (): Call[] => [
      { name: 'bid detail', method: 'GET', url: `/api/bids/${bidA.id}`, ownerOk: true },
      { name: 'bid events (SSE)', method: 'GET', url: `/api/bids/${bidA.id}/events` },
      { name: 'bid cancel', method: 'POST', url: `/api/bids/${bidA.id}/cancel` },
      {
        name: 'bid raise',
        method: 'POST',
        url: `/api/bids/${bidA.id}/raise`,
        payload: { amountCents: 25_000 },
      },
      { name: 'bid authorize', method: 'POST', url: `/api/bids/${bidA.id}/authorize` },
      {
        name: 'bid release-if-cheaper',
        method: 'PATCH',
        url: `/api/bids/${bidA.id}`,
        payload: { releaseIfCheaper: true },
      },
      { name: 'mandate detail', method: 'GET', url: `/api/mandates/${mandateA}`, ownerOk: true },
      {
        name: 'mandate update',
        method: 'PATCH',
        url: `/api/mandates/${mandateA}`,
        payload: { status: 'PAUSED' },
      },
      {
        name: 'agent conversation',
        method: 'GET',
        url: `/api/agent/conversations/${conversationA}`,
        ownerOk: true,
      },
      {
        name: 'pending action confirm',
        method: 'POST',
        url: `/api/agent/actions/${actionA}/confirm`,
      },
      { name: 'mcp client revoke', method: 'DELETE', url: `/api/mcp-clients/${mcpClientA}` },
      { name: 'notification read', method: 'POST', url: `/api/notifications/${shopperNoteA}/read` },
    ];

    it('every id-scoped route answers 404 and changes nothing', async () => {
      const before = await stateSnapshot();
      const callsBefore = fake.calls.length;
      for (const c of shopperCalls()) expectNotFound(c, await send(shopperCookie(shopperB), c));
      expect(await stateSnapshot()).toEqual(before);
      expect(fake.calls.length).toBe(callsBefore);
    });

    it("the owner's reads succeed", async () => {
      for (const c of shopperCalls().filter((x) => x.ownerOk)) {
        const res = await send(shopperCookie(shopperA), c);
        expect({ call: c.name, status: res.statusCode }).toEqual({ call: c.name, status: 200 });
      }
    });

    it("lists never include the other shopper's rows", async () => {
      for (const url of [
        '/api/bids/mine',
        '/api/mandates',
        '/api/mcp-clients',
        '/api/notifications',
      ]) {
        const res = await send(shopperCookie(shopperB), { name: url, method: 'GET', url });
        expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
        for (const id of [bidA.id, mandateA, mcpClientA, shopperNoteA]) {
          expect(res.body).not.toContain(id);
        }
      }
    });

    it("a brand session can't read a shopper's bid", async () => {
      const res = await send(brandCookie(brandA.userId), {
        name: 'bid as brand',
        method: 'GET',
        url: `/api/bids/${bidA.id}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('MCP', () => {
    async function connect(token: string) {
      const c = new Client({ name: 'hf-047-test', version: '0.0.0' });
      await c.connect(
        new StreamableHTTPClientTransport(mcpUrl, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      mcpClients.push(c);
      return (name: string, args: Record<string, unknown> = {}) =>
        c.callTool({ name, arguments: args }) as Promise<Result>;
    }
    const text = (r: Result) => (r.content[0] as { text: string }).text;

    it("shopper B's token can't cancel, raise or list shopper A's bids", async () => {
      const before = await stateSnapshot();
      const callsBefore = fake.calls.length;
      const call = await connect(tokenB);

      const cancel = await call('cancel_bid', { bidId: bidA.id });
      expect(cancel.isError).toBe(true);
      expect(text(cancel)).toMatch(/^NOT_FOUND: /);

      // raise_bid lands in HF-044b; when present it must refuse the same way.
      const raise = await call('raise_bid', {
        bidId: bidA.id,
        amountCents: 25_000,
        idempotencyKey: randomUUID(),
      });
      expect(raise.isError).toBe(true);
      expect(text(raise)).toMatch(/NOT_FOUND|not found/i);

      const mine = await call('my_bids');
      expect(mine.isError).toBeFalsy();
      expect(JSON.stringify(mine)).not.toContain(bidA.id);

      expect(await stateSnapshot()).toEqual(before);
      expect(fake.calls.length).toBe(callsBefore);
    });

    it("shopper A's own token sees the bid (the refusal is tenancy)", async () => {
      const call = await connect(tokenA);
      expect(JSON.stringify(await call('my_bids'))).toContain(bidA.id);
    });

    it('ignores session cookies: cookie alone → 401; cookie + bearer acts as the bearer', async () => {
      const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      for (const cookie of [shopperCookie(shopperA), brandCookie(brandA.userId)]) {
        const res = await fetch(mcpUrl, {
          method: 'POST',
          headers: { ...headers, cookie },
          body: JSON.stringify(rpc),
        });
        expect(res.status).toBe(401);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
          'UNAUTHENTICATED',
        );
      }

      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { ...headers, cookie: shopperCookie(shopperA), authorization: `Bearer ${tokenB}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'my_bids', arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(bidA.id);
    });
  });
});
