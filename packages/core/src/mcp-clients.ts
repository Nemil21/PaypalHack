import { createHash, randomBytes } from 'node:crypto';
import {
  MCP_TOKEN_PREFIX,
  normalizeMcpScopes,
  type McpClientView,
  type McpScope,
} from '@holdfast/shared';
import { audit } from './audit.js';
import type { Db, Queryable } from './db.js';

/**
 * MCP tokens (HF-043; features/07 §Logic 1–2, data-model.md §mcp_clients). One row per token,
 * scoped to one shopper (the token holder's own PayPal pays).
 *
 * - The token is `hf_mcp_` + 32 random bytes (base64url). It is returned once by
 *   `createMcpClient` and never stored: the row keeps its SHA-256 (`token_hash`, unique) and a
 *   short display prefix. Lookups go by hash, so there is nothing to compare in constant time.
 * - `verifyMcpToken` is one `UPDATE … WHERE token_hash = $1 AND revoked_at IS NULL RETURNING`:
 *   it stamps `last_used_at` and reads the scopes atomically, so a revoke that has committed is
 *   seen by the very next call (immediate 401), and a call racing the revoke either finishes
 *   before it or fails.
 */

/** Random bytes per token (≥ 32, features/07). */
export const MCP_TOKEN_BYTES = 32;
/** Characters of the random part kept for display (`hf_mcp_Q3x9`). */
const DISPLAY_CHARS = 4;

export function generateMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(MCP_TOKEN_BYTES).toString('base64url');
}

/** Hex SHA-256 of the whole token: what `mcp_clients.token_hash` stores and lookups use. */
export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function mcpTokenPrefix(token: string): string {
  return token.slice(0, MCP_TOKEN_PREFIX.length + DISPLAY_CHARS);
}

interface McpClientRow {
  id: string;
  shopper_id: string;
  name: string | null;
  token_prefix: string | null;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = `id, shopper_id, name, token_prefix, scopes, created_at, last_used_at, revoked_at`;

function viewOf(r: McpClientRow): McpClientView {
  return {
    id: r.id,
    name: r.name ?? 'MCP client',
    tokenPrefix: r.token_prefix ?? MCP_TOKEN_PREFIX,
    scopes: r.scopes.filter((s): s is McpScope => s === 'read' || s === 'bid'),
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
  };
}

export interface CreateMcpClientInput {
  shopperId: string;
  name: string;
  scopes: readonly McpScope[];
}

/** Create a token. The returned `token` exists only in this return value. */
export async function createMcpClient(
  db: Db,
  input: CreateMcpClientInput,
): Promise<{ client: McpClientView; token: string }> {
  const token = generateMcpToken();
  const scopes = normalizeMcpScopes(input.scopes);
  const client = await db.tx(async (tx) => {
    const res = await tx.query<McpClientRow>(
      `INSERT INTO mcp_clients (shopper_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5::text[])
       RETURNING ${COLUMNS}`,
      [input.shopperId, input.name, hashMcpToken(token), mcpTokenPrefix(token), scopes],
    );
    const row = res.rows[0]!;
    await audit(tx, {
      actorType: 'SHOPPER',
      actorId: input.shopperId,
      entity: 'mcp_client',
      entityId: row.id,
      action: 'MCP_TOKEN_CREATED',
      data: { name: input.name, scopes },
    });
    return viewOf(row);
  });
  return { client, token };
}

/** The shopper's tokens, newest first, revoked ones included (W19 shows them as revoked). */
export async function listMcpClients(q: Queryable, shopperId: string): Promise<McpClientView[]> {
  const res = await q.query<McpClientRow>(
    `SELECT ${COLUMNS} FROM mcp_clients WHERE shopper_id = $1 ORDER BY created_at DESC, id`,
    [shopperId],
  );
  return res.rows.map(viewOf);
}

/**
 * Revoke one of the shopper's tokens. Idempotent: an already revoked token keeps its first
 * `revoked_at`. Null when the id is unknown or belongs to another shopper (the route's 404).
 */
export async function revokeMcpClient(
  db: Db,
  shopperId: string,
  clientId: string,
): Promise<McpClientView | null> {
  return db.tx(async (tx) => {
    const res = await tx.query<McpClientRow>(
      `UPDATE mcp_clients SET revoked_at = now(), updated_at = now()
        WHERE id = $1 AND shopper_id = $2 AND revoked_at IS NULL
        RETURNING ${COLUMNS}`,
      [clientId, shopperId],
    );
    if (res.rows[0]) {
      await audit(tx, {
        actorType: 'SHOPPER',
        actorId: shopperId,
        entity: 'mcp_client',
        entityId: clientId,
        action: 'MCP_TOKEN_REVOKED',
      });
      return viewOf(res.rows[0]);
    }
    const existing = await tx.query<McpClientRow>(
      `SELECT ${COLUMNS} FROM mcp_clients WHERE id = $1 AND shopper_id = $2`,
      [clientId, shopperId],
    );
    return existing.rows[0] ? viewOf(existing.rows[0]) : null;
  });
}

/** Who an MCP bearer token acts as. Shape of `McpPrincipal` in apps/api's guards. */
export interface McpTokenPrincipal {
  clientId: string;
  shopperId: string;
  scopes: string[];
  rateLimitPerMin: number;
}

/**
 * Resolve a bearer token: null when it is malformed, unknown or revoked. Stamps `last_used_at`.
 */
export async function verifyMcpToken(
  q: Queryable,
  token: string,
): Promise<McpTokenPrincipal | null> {
  if (!token.startsWith(MCP_TOKEN_PREFIX) || token.length > 200) return null;
  const res = await q.query<{
    id: string;
    shopper_id: string;
    scopes: string[];
    rate_limit_per_min: number;
  }>(
    `UPDATE mcp_clients SET last_used_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id, shopper_id, scopes, rate_limit_per_min`,
    [hashMcpToken(token)],
  );
  const r = res.rows[0];
  return r
    ? {
        clientId: r.id,
        shopperId: r.shopper_id,
        scopes: r.scopes,
        rateLimitPerMin: r.rate_limit_per_min,
      }
    : null;
}
