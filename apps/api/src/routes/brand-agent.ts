import type { FastifyInstance } from 'fastify';
import {
  NotFoundError,
  askBrandAgent,
  dbBookReader,
  type AgentModel,
  type Db,
} from '@holdfast/core';
import { brandAgentAskRequestSchema } from '@holdfast/shared';
import { ApiError, parse } from '../http/errors.js';

export interface BrandAgentRouteDeps {
  db: Db;
  /** Null without `ANTHROPIC_API_KEY`: every answer is null and the card shows without prose. */
  model: AgentModel | null;
  timeoutMs?: number;
}

/**
 * `POST /api/brand-agent/ask {listingId, question?, history?}` (HF-051b; api.md, features/09
 * §Logic 2–3). Brand session, any role (it reads the book like the console; nothing changes), and
 * the brand comes from the session: another brand's listing is 404. 20 calls/min per brand user.
 * Without `question` it explains the code recommendation (the prose under the W06 card).
 *
 * Always 200 once the listing is found: when Claude is down or slow the body still carries the
 * code recommendation, with `answer: null` and `available: false`.
 */
export function registerBrandAgentRoutes(app: FastifyInstance, deps: BrandAgentRouteDeps): void {
  const reader = dbBookReader(deps.db);
  app.post(
    '/api/brand-agent/ask',
    { onRequest: [app.guards.requireBrandUser(), app.guards.rateLimit('agent')] },
    async (req, reply) => {
      const body = parse(brandAgentAskRequestSchema, req.body, 'brand agent question');
      const abort = new AbortController();
      reply.raw.on('close', () => abort.abort());
      try {
        return await askBrandAgent(
          { reader, model: deps.model, timeoutMs: deps.timeoutMs },
          {
            ...body,
            brandId: req.auth.brandUser!.brandId,
            signal: abort.signal,
          },
        );
      } catch (err) {
        if (err instanceof NotFoundError) throw new ApiError('NOT_FOUND', 'Listing not found.');
        throw err;
      }
    },
  );
}
