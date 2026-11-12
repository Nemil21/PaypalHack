/**
 * W19 live tool list (v4 §4.1): `GET /api/mcp/tools` answers from the real MCP server's
 * `tools/list`, with no token and no database.
 */
import Fastify from 'fastify';
import { MCP_TOOL_DOCS, type McpToolListBody } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_DESCRIPTIONS } from './server.js';
import { listMcpTools, registerMcpToolsRoute } from './tools-list.js';

describe('GET /api/mcp/tools (W19)', () => {
  it('lists the five tools the server registers, with scopes and cents schemas', async () => {
    const app = Fastify();
    registerMcpToolsRoute(app);
    const res = await app.inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const { tools } = res.json<McpToolListBody>();
    expect(tools.map((t) => t.name).sort()).toEqual(
      MCP_TOOL_DOCS.map((t) => t.name as string).sort(),
    );
    const place = tools.find((t) => t.name === 'place_bid')!;
    expect(place.scope).toBe('bid');
    expect(place.title).toBe('Place a bid (real PayPal hold)');
    expect(place.description).toBe(MCP_TOOL_DESCRIPTIONS.place_bid);
    expect(place.inputSchema.required).toEqual(
      expect.arrayContaining(['listingSlug', 'amountCents', 'idempotencyKey']),
    );
    expect(place.inputSchema.properties?.amountCents?.type).toBe('integer');
    expect(tools.find((t) => t.name === 'get_book')!.scope).toBe('read');
    expect(tools.find((t) => t.name === 'my_bids')!.scope).toBe('read');
    await app.close();
  });

  it('a failed listing is a 500 and is not cached: the next request lists again', async () => {
    let calls = 0;
    const app = Fastify();
    registerMcpToolsRoute(app, async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return [];
    });
    expect((await app.inject({ method: 'GET', url: '/api/mcp/tools' })).statusCode).toBe(500);
    const ok = await app.inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tools: [] });
    await app.inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(calls).toBe(2);
    await app.close();
  });

  it('is repeatable (each call builds and closes its own in-memory server)', async () => {
    const [a, b] = await Promise.all([listMcpTools(), listMcpTools()]);
    expect(a).toEqual(b);
  });
});
