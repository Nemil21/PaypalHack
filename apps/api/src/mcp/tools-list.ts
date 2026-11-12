import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PlaceBidDeps } from '@holdfast/core';
import { mcpToolScope, type McpToolInfo, type McpToolListBody } from '@holdfast/shared';
import type { FastifyInstance } from 'fastify';
import { createMcpServer } from './server.js';

/**
 * W19 tool list from the server itself (v4 plan §4.1 W19): the real `createMcpServer` answers
 * `tools/list` over an in-memory transport, so the Developer page and Docs show exactly what an
 * agent sees (names, titles, descriptions, input schemas), never a hand-kept copy. The server is
 * built with inert deps: listing never runs a tool, touches the database or needs a token.
 */
export async function listMcpTools(): Promise<McpToolInfo[]> {
  const inert = { db: { pool: null } } as unknown as PlaceBidDeps;
  const server = createMcpServer({ money: inert }, { clientId: 'tools-list', shopperId: 'none' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'holdfast-tools-list', version: '1.0.0' });
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      title: t.title ?? t.annotations?.title ?? t.name,
      description: t.description ?? '',
      scope: mcpToolScope(t.name),
      inputSchema: t.inputSchema as McpToolInfo['inputSchema'],
    }));
  } finally {
    await client.close();
    await server.close();
  }
}

/** `GET /api/mcp/tools`: public and read-only; the list is fixed per deploy, so it is cached. */
export function registerMcpToolsRoute(
  app: FastifyInstance,
  list: () => Promise<McpToolInfo[]> = listMcpTools,
): void {
  let cached: Promise<McpToolInfo[]> | null = null;
  app.get('/api/mcp/tools', async (_req, reply) => {
    // A failed listing is not cached: the next request tries again.
    cached ??= list().catch((err: unknown) => {
      cached = null;
      throw err;
    });
    const body: McpToolListBody = { tools: await cached };
    void reply.header('cache-control', 'public, max-age=300');
    return body;
  });
}
