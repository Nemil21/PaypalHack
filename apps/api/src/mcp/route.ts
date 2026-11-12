import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mcpToolScope, type McpToolInfo } from '@holdfast/shared';
import { ApiError } from '../http/errors.js';

/**
 * `/mcp` (HF-043 side; features/07 §Logic 2, api.md §MCP server). This file owns who may call:
 *
 *   onRequest  `requireMcpToken()`: bearer token only (session cookies are ignored), token →
 *              shopper + scopes, `last_used_at`, 30 calls/min per `mcp_clients.id` → 429
 *              `RATE_LIMITED`; unknown or revoked → 401 at once.
 *   handler    scope gate: a `tools/call` for a tool the token's scopes don't cover (`place_bid`,
 *              `cancel_bid`, `raise_bid` need `bid`) answers a `FORBIDDEN` tool error and never
 *              reaches the tools; everything else goes to `deps.handler`.
 *
 * HF-044a's stateless `StreamableHTTPServerTransport` (`server.ts`) is the `handler` whenever the
 * bid service is wired (the principal is `req.auth.mcp`). Without it the placeholder speaks just
 * enough MCP (initialize, ping, an empty tools/list) for a client to connect with a W19 token.
 */

export type McpHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface McpRouteDeps {
  /** The MCP server (HF-044a). Default: the placeholder below. */
  handler?: McpHandler;
}

/** A tool error as an MCP `CallToolResult` (HF-044a convention: `isError`, plain message). */
export function mcpToolError(code: string, message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: `${code}: ${message}` }] };
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: { name?: unknown; protocolVersion?: unknown };
}

function isMessage(x: unknown): x is JsonRpcMessage {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** The first `tools/call` in the body the scopes don't allow, with the scope it needs. */
export function forbiddenToolCall(
  body: unknown,
  scopes: readonly string[],
): { message: JsonRpcMessage; tool: string; needs: string } | null {
  for (const m of Array.isArray(body) ? body : [body]) {
    if (!isMessage(m) || m.method !== 'tools/call') continue;
    const tool = typeof m.params?.name === 'string' ? m.params.name : '';
    const needs = mcpToolScope(tool);
    if (!scopes.includes(needs)) return { message: m, tool, needs };
  }
  return null;
}

/**
 * `GET /api/mcp/tools` (W19, v4 plan §4.1): the live `tools/list`, public like the docs it
 * replaces. No token needed: it names the tools and their inputs, never a shopper's data.
 */
export function registerMcpToolsRoute(
  app: FastifyInstance,
  list: () => Promise<McpToolInfo[]>,
): void {
  app.get('/api/mcp/tools', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return { tools: await list() };
  });
}

export function registerMcpRoute(app: FastifyInstance, deps: McpRouteDeps = {}): void {
  const handler = deps.handler ?? placeholderMcpHandler;
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    onRequest: app.guards.requireMcpToken(),
    handler: async (req, reply) => {
      if (req.method === 'POST') {
        const denied = forbiddenToolCall(req.body, req.auth.mcp!.scopes);
        if (denied) {
          const message = `This token can't call ${denied.tool || 'that tool'}: it needs the "${denied.needs}" scope. Create a token with that scope on the Holdfast Developer page.`;
          // JSON-RPC batches are gone from current MCP; refuse a mixed batch as a whole.
          if (Array.isArray(req.body)) throw new ApiError('FORBIDDEN', message);
          return reply.send({
            jsonrpc: '2.0',
            id: denied.message.id ?? null,
            result: mcpToolError('FORBIDDEN', message),
          });
        }
      }
      return handler(req, reply);
    },
  });
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Stateless placeholder until HF-044a: connects, lists no tools, refuses tool calls. */
export const placeholderMcpHandler: McpHandler = async (req, reply) => {
  if (req.method !== 'POST') {
    // Stateless server: no standalone SSE stream and no session to delete.
    return reply
      .code(405)
      .header('Allow', 'POST')
      .send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed.' },
      });
  }
  const m = req.body;
  if (!isMessage(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    return reply
      .code(400)
      .send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  // Notifications (no id) are accepted with no body.
  if (m.id === undefined || m.id === null) return reply.code(202).send();
  const ok = (result: unknown) => reply.send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      return ok({
        protocolVersion:
          typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'holdfast', version: '0.1.0' },
        instructions:
          'Holdfast lets you bid on brand overstock with a real PayPal hold. Bidding tools are coming online.',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: [] });
    case 'tools/call':
      return ok(mcpToolError('UNAVAILABLE', 'Holdfast MCP tools are not live yet.'));
    default:
      return reply.send({
        jsonrpc: '2.0',
        id: m.id,
        error: { code: -32601, message: 'Method not found' },
      });
  }
};
