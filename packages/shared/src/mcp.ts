import { z } from 'zod';

/**
 * MCP tokens contract (HF-043; features/07 §Logic 1–2, api.md §MCP server, data-model.md
 * §mcp_clients). A shopper creates a scoped token on W19; an outside agent sends it as
 * `Authorization: Bearer hf_mcp_…` to `/mcp`. The token is shown once and stored only as a hash.
 */

/** Every token starts with this, so it is recognisable (and redactable) in logs and configs. */
export const MCP_TOKEN_PREFIX = 'hf_mcp_';

/** `read`: look at books and your own bids. `bid`: place, cancel and raise bids (real holds). */
export const MCP_SCOPES = ['read', 'bid'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** The scope each MCP tool needs (features/07 §Acceptance: a `read`-only token can't move money). */
export const MCP_TOOL_SCOPES = {
  get_book: 'read',
  my_bids: 'read',
  place_bid: 'bid',
  cancel_bid: 'bid',
  raise_bid: 'bid',
} as const satisfies Record<string, McpScope>;
export type McpToolName = keyof typeof MCP_TOOL_SCOPES;

/**
 * The scope a tool call needs. Unknown tool names need `bid`: a tool added later is treated as
 * money-moving until it is listed above.
 */
export function mcpToolScope(tool: string): McpScope {
  return Object.hasOwn(MCP_TOOL_SCOPES, tool) ? MCP_TOOL_SCOPES[tool as McpToolName] : 'bid';
}

/**
 * Short tool notes for Docs and the W19 fallback; W19 itself reads the live list from
 * `GET /api/mcp/tools` (the server's own `tools/list`).
 */
export const MCP_TOOL_DOCS: readonly {
  name: McpToolName;
  scope: McpScope;
  input: string;
  description: string;
}[] = [
  {
    name: 'get_book',
    scope: 'read',
    input: '{ listingSlug }',
    description: 'Product, best public price, closing time and anonymized demand bands.',
  },
  {
    name: 'my_bids',
    scope: 'read',
    input: '{}',
    description: 'Your bids, with whether each is below the live-round cutoff.',
  },
  {
    name: 'place_bid',
    scope: 'bid',
    input: '{ listingSlug, amountCents, idempotencyKey }',
    description:
      "Places a real PayPal hold. If you win, you're charged exactly amountCents; otherwise it's released.",
  },
  {
    name: 'cancel_bid',
    scope: 'bid',
    input: '{ bidId }',
    description: 'Cancels your bid and releases its hold.',
  },
  {
    name: 'raise_bid',
    scope: 'bid',
    input: '{ bidId, amountCents, idempotencyKey }',
    description: 'Raises your bid within your mandate; the old hold is released.',
  },
];

/** One tool as the live server lists it (`GET /api/mcp/tools`, W19). */
export interface McpToolInfo {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  inputSchema: {
    type: 'object';
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

export interface McpToolListBody {
  tools: McpToolInfo[];
}

export const MCP_CLIENT_NAME_MAX = 60;

/**
 * `POST /api/mcp-clients`. Scopes are deduplicated; `bid` implies `read` (a bidding agent needs
 * to see the book and its own bids), so the stored scopes are `['read']` or `['read', 'bid']`.
 */
export const createMcpClientRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name the token, e.g. "Claude Desktop".')
    .max(MCP_CLIENT_NAME_MAX, `at most ${MCP_CLIENT_NAME_MAX} characters`),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1, 'Choose at least one scope.'),
});
export type CreateMcpClientRequest = z.infer<typeof createMcpClientRequestSchema>;

export function normalizeMcpScopes(scopes: readonly McpScope[]): McpScope[] {
  return scopes.includes('bid') ? ['read', 'bid'] : ['read'];
}

/** A token row as W19 lists it. Never the token or its hash; `tokenPrefix` is a display hint. */
export interface McpClientView {
  id: string;
  name: string;
  /** e.g. `hf_mcp_Q3x9`: enough to tell tokens apart, useless to an attacker. */
  tokenPrefix: string;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** `GET /api/mcp-clients` (newest first, revoked ones included). */
export interface McpClientListBody {
  clients: McpClientView[];
}

/** `POST /api/mcp-clients` → 201. The only response that ever contains `token`. */
export interface McpClientCreatedBody {
  client: McpClientView;
  token: string;
}

/** `DELETE /api/mcp-clients/:id` → 200 (already revoked: same answer). */
export interface McpClientRevokedBody {
  client: McpClientView;
}
