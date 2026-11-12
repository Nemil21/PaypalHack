/**
 * W19 (v4 plan §4.1): `GET /api/mcp/tools` is the MCP server's own `tools/list`, not a static
 * copy. No database: the list never runs a tool handler.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_SCOPES } from '@holdfast/shared';
import { registerMcpToolsRoute } from './route.js';
import { listMcpTools, MCP_TOOL_DESCRIPTIONS } from './server.js';

describe('W19 live MCP tool list', () => {
  it('lists every registered tool with the scope route.ts enforces', async () => {
    const tools = await listMcpTools();
    expect(Object.fromEntries(tools.map((t) => [t.name, t.scope]))).toEqual(MCP_TOOL_SCOPES);
    const place = tools.find((t) => t.name === 'place_bid')!;
    expect(place.description).toBe(MCP_TOOL_DESCRIPTIONS.place_bid);
    expect(place.readOnly).toBe(false);
    expect(place.params.map((p) => [p.name, p.required])).toEqual([
      ['listingSlug', true],
      ['amountCents', true],
      ['idempotencyKey', true],
    ]);
    expect(tools.find((t) => t.name === 'my_bids')).toMatchObject({ readOnly: true, params: [] });
  });

  it('serves the list publicly with a short cache', async () => {
    const app = Fastify();
    registerMcpToolsRoute(app, listMcpTools);
    const res = await app.inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json().tools).toHaveLength(Object.keys(MCP_TOOL_SCOPES).length);
  });
});
