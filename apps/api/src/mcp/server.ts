import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  mcpCancelBid,
  mcpGetBook,
  mcpMyBids,
  mcpPlaceBid,
  type McpCaller,
  type McpToolOutcome,
  type PlaceBidDeps,
} from '@holdfast/core';
import { MAX_AMOUNT_CENTS, MIN_AMOUNT_CENTS } from '@holdfast/shared';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { placeholderMcpHandler, type McpHandler } from './route.js';

/**
 * The Holdfast MCP server (HF-044a; features/07 §Logic 2–6, api.md §MCP server). `route.ts`
 * (HF-043) has already authenticated the bearer token, applied the 30/min limit and refused
 * money tools to `read`-only tokens before this handler runs.
 *
 * **Stateless** Streamable HTTP (`sessionIdGenerator: undefined`, JSON responses): every POST
 * gets a fresh `McpServer` + transport bound to the token's shopper, so a deploy or a second
 * instance never strands a Claude Desktop session. GET / DELETE (standalone SSE stream, session
 * teardown) have nothing to do and answer 405. Fastify hands the raw request and response to the
 * SDK through `reply.hijack()`; the body Fastify already parsed is passed along.
 *
 * Tools call `@holdfast/core`'s `mcp-tools` (same services as REST). Failures come back as
 * `isError: true` results with a plain `CODE: message` text, never JSON-RPC errors.
 */

export interface McpServerDeps {
  /** The bid service's deps (HF-014a): database, PayPal client, audit hook. */
  money: PlaceBidDeps;
  /** `APP_BASE_URL`, so the offer-page link `place_bid` returns is absolute. */
  appBaseUrl?: string;
}

const SERVER_INFO = { name: 'holdfast', version: '0.2.0' };

const INSTRUCTIONS =
  'Holdfast lets you bid on brand overstock with a real PayPal hold. Use get_book to read a ' +
  "listing's public book, place_bid to bid (amounts are integer US cents), my_bids to see your " +
  'bids and cancel_bid to release a hold. You hold one live bid per listing.';

/** Tool descriptions; `place_bid` carries the plain-money sentence from api.md verbatim. */
export const MCP_TOOL_DESCRIPTIONS = {
  get_book:
    "Shows a Holdfast listing's public book: the product, the best public price elsewhere, when " +
    'the bidding window closes, the phase, and anonymized demand bands ($10 price bands with at ' +
    "least 3 bids each). It never shows the brand's floor price or anything about other shoppers.",
  place_bid:
    "Places a real PayPal hold. If you win, you're charged exactly amountCents; otherwise it's " +
    'released. The hold goes on your saved payment method when you have an active agent mandate ' +
    'that covers the amount. Otherwise nothing is held and you get an offer-page link (offerUrl) ' +
    'to approve the hold yourself. One live bid per listing: a second place_bid fails with ' +
    'ALREADY_BID (use raise_bid, or cancel_bid and bid again to lower it).',
  cancel_bid:
    'Cancels your bid and releases its PayPal hold. Safe to repeat: a bid that is already ' +
    'released or releasing returns its current status.',
  my_bids:
    'Lists your Holdfast bids with their status and amounts. During live rounds each bid shows ' +
    'belowCutoff and cutoffCents (the price you need to beat); otherwise both are null.',
} as const;

const listingSlug = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The listing slug from its Holdfast link, e.g. "aurel-a7" in /o/aurel-a7.');

const amountCents = z
  .number()
  .int()
  .min(MIN_AMOUNT_CENTS)
  .max(MAX_AMOUNT_CENTS)
  .describe(
    `Bid amount in integer US cents, e.g. 21500 = $215.00 (from ${MIN_AMOUNT_CENTS} to ${MAX_AMOUNT_CENTS}).`,
  );

const idempotencyKey = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    'A unique key you choose for this bid, e.g. a UUID. Retrying with the same key never places ' +
      'a second hold; reusing it for a different bid fails with DUPLICATE.',
  );

/** A tool outcome as an MCP `CallToolResult`. */
export function toCallToolResult(outcome: McpToolOutcome): CallToolResult {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.result, null, 2) }],
      structuredContent: outcome.result,
    };
  }
  const error = { code: outcome.code, message: outcome.message, ...outcome.details };
  return {
    isError: true,
    content: [{ type: 'text', text: `${outcome.code}: ${outcome.message}` }],
    structuredContent: { error },
  };
}

/** The four HF-044a tools for one caller. `raise_bid` follows in HF-044b. */
export function createMcpServer(
  deps: McpServerDeps,
  caller: McpCaller,
  log?: FastifyBaseLogger,
): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
  });
  const run = (tool: string, fn: () => Promise<McpToolOutcome>) => async () => {
    try {
      return toCallToolResult(await fn());
    } catch (err) {
      // Never hand an internal error message (SQL, stack) to an outside agent.
      log?.error({ err, tool }, 'mcp tool failed');
      return toCallToolResult({
        ok: false,
        code: 'INTERNAL',
        message: 'Something went wrong on Holdfast. Nothing new was held. Try again in a moment.',
      });
    }
  };
  const pool = deps.money.db.pool;
  const placeDeps = { ...deps.money, appBaseUrl: deps.appBaseUrl ?? deps.money.appBaseUrl };

  server.registerTool(
    'get_book',
    {
      title: 'Get a listing book',
      description: MCP_TOOL_DESCRIPTIONS.get_book,
      inputSchema: { listingSlug },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run('get_book', () => mcpGetBook(pool, args))(),
  );
  server.registerTool(
    'place_bid',
    {
      title: 'Place a bid (real PayPal hold)',
      description: MCP_TOOL_DESCRIPTIONS.place_bid,
      inputSchema: { listingSlug, amountCents, idempotencyKey },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (args) => run('place_bid', () => mcpPlaceBid(placeDeps, caller, args))(),
  );
  server.registerTool(
    'cancel_bid',
    {
      title: 'Cancel a bid',
      description: MCP_TOOL_DESCRIPTIONS.cancel_bid,
      inputSchema: {
        bidId: z.string().trim().min(1).max(100).describe('The bidId from place_bid or my_bids.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (args) => run('cancel_bid', () => mcpCancelBid(deps.money, caller, args))(),
  );
  server.registerTool(
    'my_bids',
    {
      title: 'List my bids',
      description: MCP_TOOL_DESCRIPTIONS.my_bids,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run('my_bids', () => mcpMyBids(pool, caller))(),
  );
  return server;
}

/** The `/mcp` handler `route.ts` calls after auth and the scope gate. */
export function createMcpHandler(deps: McpServerDeps): McpHandler {
  return async (req, reply) => {
    // Stateless: no standalone SSE stream and no session to delete.
    if (req.method !== 'POST') return placeholderMcpHandler(req, reply);
    const principal = req.auth.mcp!;
    const caller: McpCaller = { clientId: principal.clientId, shopperId: principal.shopperId };
    const server = createMcpServer(deps, caller, req.log);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Headers set before the hijack (rate-limit counters) would otherwise be dropped.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal error' },
          }),
        );
      }
    }
  };
}
