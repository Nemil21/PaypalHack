import type { FastifyInstance } from 'fastify';
import { createMcpClient, listMcpClients, revokeMcpClient, type Db } from '@holdfast/core';
import {
  createMcpClientRequestSchema,
  type McpClientCreatedBody,
  type McpClientListBody,
  type McpClientRevokedBody,
} from '@holdfast/shared';
import { ApiError, parse } from '../http/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * W19 token management (HF-043; features/07 §Logic 1, screens.md §W19). Shopper session only.
 *
 *   GET    /api/mcp-clients       the shopper's tokens (never the token or its hash)
 *   POST   /api/mcp-clients       { name, scopes } → 201 { client, token }: the only time the
 *                                 token is ever returned
 *   DELETE /api/mcp-clients/:id   revoke → `revoked_at`; the next `/mcp` call with it is 401
 *
 * POST needs an `Idempotency-Key` like every mutating call but is deliberately **not** run through
 * `app.idempotent`: the store keeps the response body, which would persist the plaintext token
 * and replay it to anyone repeating the key. A double submit makes two tokens; both are listed
 * and revocable. DELETE is naturally idempotent (an already revoked token answers the same).
 */
export function registerMcpClientRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/api/mcp-clients', { onRequest: app.guards.requireShopper }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body: McpClientListBody = {
      clients: await listMcpClients(deps.db.pool, req.auth.shopper!.id),
    };
    return body;
  });

  app.post('/api/mcp-clients', { onRequest: app.guards.requireShopper }, async (req, reply) => {
    const shopper = req.auth.shopper!;
    // A token outlives a cookie; bind it to a signed-in shopper who can find it again (D13).
    if (!shopper.email) {
      throw new ApiError('UNAUTHENTICATED', 'Sign in to create an MCP token.');
    }
    const input = parse(createMcpClientRequestSchema, req.body, 'token');
    const body: McpClientCreatedBody = await createMcpClient(deps.db, {
      shopperId: shopper.id,
      name: input.name,
      scopes: input.scopes,
    });
    return reply.code(201).header('Cache-Control', 'no-store').send(body);
  });

  app.delete('/api/mcp-clients/:id', { onRequest: app.guards.requireShopper }, async (req) => {
    const id = (req.params as { id?: string }).id ?? '';
    // Unknown, malformed and other shoppers' ids all answer 404 (never 403).
    const client = UUID.test(id) ? await revokeMcpClient(deps.db, req.auth.shopper!.id, id) : null;
    if (!client) throw new ApiError('NOT_FOUND', 'Token not found.');
    const body: McpClientRevokedBody = { client };
    return body;
  });
}
