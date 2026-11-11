/**
 * HF-043 MCP tokens through the real server (guards, CSRF, Idempotency-Key header) on Postgres:
 * create → use → revoke, the one-time reveal, the scope matrix on `/mcp`, cookie-only requests,
 * the 30/min limit per token, tenancy, and a revoke racing a burst of calls.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/mcp-clients.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashMcpToken, loadConfig } from '@holdfast/core';
import { MCP_TOKEN_PREFIX } from '@holdfast/shared';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RATE_LIMITS, RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'm'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  PAYPAL_MODE: 'stub',
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
};

const TOOLS = ['get_book', 'my_bids', 'place_bid', 'cancel_bid', 'raise_bid'] as const;

describe.skipIf(!TEST_DATABASE_URL)('HF-043 MCP tokens', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter({ ...RATE_LIMITS, rest: 10_000 }),
    });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const cookie = (shopperId: string) =>
    `${SHOPPER_COOKIE}=${signToken(SECRET, 'shopper-session', { sub: shopperId, exp: Date.now() + 60_000 })}`;

  async function shopper(email: string | null = `${randomUUID()}@example.com`): Promise<string> {
    const r = await tdb.db.pool.query(`INSERT INTO shoppers (email) VALUES ($1) RETURNING id`, [
      email,
    ]);
    return (r.rows[0] as { id: string }).id;
  }

  const create = (shopperId: string | null, body: object, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/mcp-clients',
      headers: { ...(shopperId ? { cookie: cookie(shopperId) } : {}), 'idempotency-key': key },
      payload: body,
    });
  const list = (shopperId: string) =>
    app.inject({ method: 'GET', url: '/api/mcp-clients', headers: { cookie: cookie(shopperId) } });
  const revoke = (shopperId: string, id: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/mcp-clients/${id}`,
      headers: { cookie: cookie(shopperId), 'idempotency-key': randomUUID() },
    });

  async function token(shopperId: string, scopes: string[] = ['read', 'bid']) {
    const res = await create(shopperId, { name: 'Claude Desktop', scopes });
    expect(res.statusCode).toBe(201);
    return res.json() as { client: { id: string; scopes: string[] }; token: string };
  }

  const rpc = (method: string, params: object = {}, id = 1) => ({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
  const mcp = (headers: Record<string, string>, payload: object = rpc('ping')) =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream', ...headers },
      payload,
    });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const callTool = (t: string, name: string) =>
    mcp(bearer(t), rpc('tools/call', { name, arguments: {} }));

  it('create → use → revoke: the token works until revoked, then 401 immediately', async () => {
    const s = await shopper();
    const { client, token: t } = await token(s);
    expect(t.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    // 32 random bytes → 43 base64url characters after the prefix.
    expect(t.length).toBe(MCP_TOKEN_PREFIX.length + 43);
    expect(client.scopes).toEqual(['read', 'bid']);

    const init = await mcp(bearer(t), rpc('initialize', { protocolVersion: '2025-06-18' }));
    expect(init.statusCode).toBe(200);
    expect(init.json().result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'holdfast' },
    });
    expect((await mcp(bearer(t), rpc('tools/list'))).json().result).toEqual({ tools: [] });

    const used = (await list(s)).json().clients[0];
    expect(used.lastUsedAt).not.toBeNull();

    const rv = await revoke(s, client.id);
    expect(rv.statusCode).toBe(200);
    expect(rv.json().client.revokedAt).not.toBeNull();
    const after = await mcp(bearer(t));
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('UNAUTHENTICATED');

    // Revoke is idempotent and keeps the first revoked_at.
    const again = await revoke(s, client.id);
    expect(again.statusCode).toBe(200);
    expect(again.json().client.revokedAt).toBe(rv.json().client.revokedAt);
    expect((await list(s)).json().clients[0].revokedAt).toBe(rv.json().client.revokedAt);
  });

  it('a token is never retrievable after creation', async () => {
    const s = await shopper();
    const key = randomUUID();
    const first = await create(s, { name: 'Agent', scopes: ['read'] }, key);
    const t = first.json().token as string;
    expect(first.headers['cache-control']).toBe('no-store');

    // The list shows a prefix only.
    const listed = (await list(s)).body;
    expect(listed).not.toContain(t);
    expect(listed).not.toContain(hashMcpToken(t));
    expect(JSON.parse(listed).clients[0].tokenPrefix).toBe(t.slice(0, MCP_TOKEN_PREFIX.length + 4));

    // Repeating the Idempotency-Key does not replay the token: it mints another one.
    const replay = await create(s, { name: 'Agent', scopes: ['read'] }, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().token).not.toBe(t);

    // Stored as SHA-256 only; the plaintext is nowhere in the database rows we write.
    const row = await tdb.db.pool.query(
      `SELECT to_jsonb(m)::text AS j, token_hash FROM mcp_clients m WHERE id = $1`,
      [first.json().client.id],
    );
    const r = row.rows[0] as { j: string; token_hash: string };
    expect(r.token_hash).toBe(hashMcpToken(t));
    expect(r.j).not.toContain(t);
    const leaks = await tdb.db.pool.query(
      `SELECT count(*)::int AS n FROM idempotency_keys WHERE response::text LIKE $1`,
      [`%${t}%`],
    );
    expect((leaks.rows[0] as { n: number }).n).toBe(0);
    const audits = await tdb.db.pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE data::text LIKE $1`,
      [`%${t}%`],
    );
    expect((audits.rows[0] as { n: number }).n).toBe(0);
  });

  it('scope matrix: read-only tokens get FORBIDDEN on money tools; bid tokens pass the gate', async () => {
    const s = await shopper();
    const read = (await token(s, ['read'])).token;
    const bid = (await token(s, ['bid'])).token;

    for (const tool of TOOLS) {
      const r = await callTool(read, tool);
      expect(r.statusCode).toBe(200);
      const text = r.json().result.content[0].text as string;
      if (tool === 'get_book' || tool === 'my_bids') {
        expect(text).not.toMatch(/^FORBIDDEN/);
      } else {
        expect(r.json().result.isError).toBe(true);
        expect(text).toMatch(/^FORBIDDEN: /);
      }
      // `bid` implies `read`: every tool passes the scope gate (the placeholder answers UNAVAILABLE
      // until HF-044a mounts the tools).
      const b = (await callTool(bid, tool)).json().result.content[0].text as string;
      expect(b).not.toMatch(/^FORBIDDEN/);
    }
    // An unknown tool is treated as money-moving.
    expect((await callTool(read, 'drain_wallet')).json().result.content[0].text).toMatch(
      /^FORBIDDEN/,
    );
  });

  it('a request to /mcp with only a session cookie → 401', async () => {
    const s = await shopper();
    await token(s);
    const res = await mcp({ cookie: cookie(s) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    // A cookie never rescues a bad bearer either.
    expect(
      (await mcp({ cookie: cookie(s), ...bearer(`${MCP_TOKEN_PREFIX}nope`) })).statusCode,
    ).toBe(401);
    // Nor does a cookie-authenticated GET or DELETE.
    expect(
      (await app.inject({ method: 'GET', url: '/mcp', headers: { cookie: cookie(s) } })).statusCode,
    ).toBe(401);
  });

  it('the 31st call in a minute → RATE_LIMITED; another token is unaffected', async () => {
    const s = await shopper();
    const a = (await token(s)).token;
    const b = (await token(s)).token;
    for (let i = 0; i < 30; i++) expect((await mcp(bearer(a))).statusCode).toBe(200);
    const res = await mcp(bearer(a));
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await mcp(bearer(b))).statusCode).toBe(200);
  });

  it('honours a lower per-token rate_limit_per_min', async () => {
    const s = await shopper();
    const { client, token: t } = await token(s);
    await tdb.db.pool.query(`UPDATE mcp_clients SET rate_limit_per_min = 2 WHERE id = $1`, [
      client.id,
    ]);
    expect((await mcp(bearer(t))).statusCode).toBe(200);
    expect((await mcp(bearer(t))).statusCode).toBe(200);
    expect((await mcp(bearer(t))).statusCode).toBe(429);
  });

  it('tenancy: list and revoke are owner-scoped; another shopper gets 404', async () => {
    const owner = await shopper();
    const other = await shopper();
    const { client, token: t } = await token(owner);
    expect((await list(other)).json().clients).toEqual([]);
    expect((await revoke(other, client.id)).statusCode).toBe(404);
    expect((await revoke(other, 'not-a-uuid')).statusCode).toBe(404);
    expect((await mcp(bearer(t))).statusCode).toBe(200);
  });

  it('creation needs a signed-in shopper, a name and a scope', async () => {
    expect((await create(null, { name: 'x', scopes: ['read'] })).statusCode).toBe(401);
    const provisional = await shopper(null);
    const p = await create(provisional, { name: 'x', scopes: ['read'] });
    expect(p.statusCode).toBe(401);
    const s = await shopper();
    expect((await create(s, { name: 'x', scopes: [] })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await create(s, { name: ' ', scopes: ['read'] })).statusCode).toBe(400);
    expect((await create(s, { name: 'x', scopes: ['admin'] })).statusCode).toBe(400);
    // Missing Idempotency-Key is refused like any other mutating call.
    const noKey = await app.inject({
      method: 'POST',
      url: '/api/mcp-clients',
      headers: { cookie: cookie(s) },
      payload: { name: 'x', scopes: ['read'] },
    });
    expect(noKey.statusCode).toBe(400);
  });

  it('race: a revoke during a burst of calls; every call after the revoke returns 401', async () => {
    const s = await shopper();
    const { client, token: t } = await token(s);
    const burst = Array.from({ length: 10 }, () => mcp(bearer(t)));
    const rv = revoke(s, client.id);
    const results = await Promise.all([...burst, rv]);
    // Each racing call either finished before the revoke (200) or saw it (401); nothing else.
    for (const r of results.slice(0, -1)) expect([200, 401]).toContain(r.statusCode);
    expect(results.at(-1)!.statusCode).toBe(200);
    const after = await Promise.all(Array.from({ length: 5 }, () => mcp(bearer(t))));
    for (const r of after) expect(r.statusCode).toBe(401);
  });

  it('race: concurrent creates mint distinct tokens and rows', async () => {
    const s = await shopper();
    const made = await Promise.all(Array.from({ length: 8 }, () => token(s)));
    expect(new Set(made.map((m) => m.token)).size).toBe(8);
    expect((await list(s)).json().clients).toHaveLength(8);
  });
});
