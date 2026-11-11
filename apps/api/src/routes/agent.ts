import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  confirmAction,
  findConversation,
  loadAgentMessages,
  openConversation,
  runAgentTurn,
  type AgentDeps,
  type AgentEvent,
  type PlaceBidDeps,
} from '@holdfast/core';
import { ApiError, parse, stateConflict } from '../http/errors.js';

export interface AgentRoutesDeps extends Omit<AgentDeps, 'db'> {
  /** The bid service the confirm endpoint executes stored actions with. */
  money: PlaceBidDeps;
}

const chatSchema = z
  .object({
    conversationId: z.string().uuid().nullable().optional(),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();

/** Blocks the chat UI renders (thinking blocks and signatures stay server-side). */
const VISIBLE_BLOCKS = new Set(['text', 'tool_use', 'tool_result']);

/**
 * Buyer agent (HF-039; api.md §`POST /agent/chat`, §`POST /agent/actions/:id/confirm`).
 *
 *   POST /api/agent/chat                      shopper session; 20 turns/min/shopper
 *   POST /api/agent/actions/:id/confirm       owner only; runs the stored arguments (B10)
 *   GET  /api/agent/conversations/:id         owner only; history for the chat UI (HF-041)
 *
 * The chat answer is a `text/event-stream` read with fetch + ReadableStream (it is a POST, so not
 * `EventSource`): one `data: <AgentEvent JSON>` frame per event, ending with `done`. Another
 * shopper's conversation or action is a 404, before anything is streamed (M24).
 */
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
  const db = deps.money.db;
  /** One turn per conversation at a time (one web instance, like the rate limiter). */
  const busy = new Set<string>();

  app.post(
    '/api/agent/chat',
    { onRequest: [app.guards.requireShopper, app.guards.rateLimit('agent')] },
    async (req, reply) => {
      const body = parse(chatSchema, req.body, 'chat message');
      const shopperId = req.auth.shopper!.id;
      const conversation = await openConversation(
        db.pool,
        shopperId,
        body.conversationId ?? null,
        body.message,
      );
      if (!conversation) throw new ApiError('NOT_FOUND', 'Conversation not found.');
      if (busy.has(conversation.id)) {
        throw new ApiError('IN_PROGRESS', 'The agent is still answering your last message.');
      }
      busy.add(conversation.id);

      const abort = new AbortController();
      reply.raw.on('close', () => abort.abort());
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-conversation-id': conversation.id,
      });
      const emit = (event: AgentEvent) => {
        if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try {
        await runAgentTurn(
          { ...deps, db: db.pool },
          { shopperId, conversation, message: body.message, signal: abort.signal },
          emit,
        );
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'agent turn failed');
        emit({
          type: 'error',
          code: 'AGENT_UNAVAILABLE',
          message: 'Agent is unavailable; you can still bid directly.',
          fallbackUrl: null,
        });
        emit({ type: 'done', conversationId: conversation.id, reason: 'unavailable' });
      } finally {
        busy.delete(conversation.id);
        reply.raw.end();
      }
    },
  );

  app.post(
    '/api/agent/actions/:id/confirm',
    { onRequest: app.guards.requireShopper },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const outcome = await confirmAction({ money: deps.money }, req.auth.shopper!.id, id);
      switch (outcome.kind) {
        case 'not_found':
          throw new ApiError('NOT_FOUND', 'Action not found.');
        case 'expired':
          throw stateConflict('ACTION_EXPIRED', 'This proposal expired. Ask the agent again.');
        case 'rejected':
          throw stateConflict('ACTION_REJECTED', 'This proposal was dismissed.');
        case 'in_progress':
          throw new ApiError('IN_PROGRESS', 'This action is still being carried out.');
        case 'needs_offer_page':
          throw new ApiError(
            'STATE_CONFLICT',
            'Add a payment method on the offer page to place this bid.',
            { reason: 'NEEDS_PAYMENT_METHOD', offerUrl: outcome.offerUrl },
          );
        case 'executed':
          reply.header('agent-action-id', outcome.action.id);
          if (outcome.replayed) reply.header('idempotent-replayed', 'true');
          return reply.code(outcome.result.status).send(outcome.result.body);
      }
    },
  );

  app.get('/api/agent/conversations/:id', { onRequest: app.guards.requireShopper }, async (req) => {
    const { id } = req.params as { id: string };
    const shopperId = req.auth.shopper!.id;
    const conversation = await findConversation(db.pool, shopperId, id);
    if (!conversation) throw new ApiError('NOT_FOUND', 'Conversation not found.');
    const messages = await loadAgentMessages(db.pool, shopperId, conversation.id);
    return {
      conversationId: conversation.id,
      title: conversation.title,
      messages: messages.map((m) => ({
        seq: m.seq,
        role: m.role,
        content: m.content.filter((b) => VISIBLE_BLOCKS.has(b.type)),
      })),
    };
  });
}
