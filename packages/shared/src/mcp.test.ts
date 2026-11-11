import { describe, expect, it } from 'vitest';
import {
  createMcpClientRequestSchema,
  MCP_TOOL_DOCS,
  MCP_TOOL_SCOPES,
  mcpToolScope,
  normalizeMcpScopes,
} from './mcp.js';

describe('MCP scopes (HF-043)', () => {
  it('money tools need bid; read tools need read; unknown tools need bid', () => {
    expect(mcpToolScope('get_book')).toBe('read');
    expect(mcpToolScope('my_bids')).toBe('read');
    for (const t of ['place_bid', 'cancel_bid', 'raise_bid']) expect(mcpToolScope(t)).toBe('bid');
    expect(mcpToolScope('toString')).toBe('bid');
    expect(mcpToolScope('')).toBe('bid');
  });

  it('bid implies read', () => {
    expect(normalizeMcpScopes(['bid'])).toEqual(['read', 'bid']);
    expect(normalizeMcpScopes(['read', 'read'])).toEqual(['read']);
  });

  it('the W19 tool list matches the scope map', () => {
    expect(MCP_TOOL_DOCS.map((t) => [t.name, t.scope])).toEqual(Object.entries(MCP_TOOL_SCOPES));
  });

  it('validates name and scopes', () => {
    expect(
      createMcpClientRequestSchema.safeParse({ name: ' A ', scopes: ['read'] }).data?.name,
    ).toBe('A');
    expect(createMcpClientRequestSchema.safeParse({ name: 'A', scopes: [] }).success).toBe(false);
    expect(createMcpClientRequestSchema.safeParse({ name: '', scopes: ['bid'] }).success).toBe(
      false,
    );
    expect(createMcpClientRequestSchema.safeParse({ name: 'A', scopes: ['admin'] }).success).toBe(
      false,
    );
  });
});
