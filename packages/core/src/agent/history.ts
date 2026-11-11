import type { Queryable } from '../db.js';
import type { AgentMessage, ContentBlock } from './model.js';

/**
 * Buyer agent conversations (HF-039; data-model §agent_conversations, §agent_messages; M24).
 *
 * A conversation belongs to one shopper: every read filters by `shopper_id`, so another shopper's
 * id is indistinguishable from an unknown one (404). Each assistant content-block array and each
 * user `tool_result` array is stored **as-is**, in order (`seq`), so the model sees exactly what
 * it produced (tool_use ids, thinking blocks) when the history is replayed.
 */

/** Messages replayed to the model per turn; older ones are summarised (ticket: ~30). */
export const HISTORY_WINDOW = 30;
const SUMMARY_MAX_CHARS = 1_500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

export interface ConversationRow {
  id: string;
  shopper_id: string;
  title: string | null;
  created_at: Date;
}

/** The shopper's conversation, or null (unknown id, malformed id, or another shopper's). */
export async function findConversation(
  q: Queryable,
  shopperId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  if (!isUuid(conversationId)) return null;
  const res = await q.query(
    `SELECT id, shopper_id, title, created_at FROM agent_conversations
      WHERE id = $1 AND shopper_id = $2`,
    [conversationId, shopperId],
  );
  return (res.rows[0] as ConversationRow | undefined) ?? null;
}

export async function createConversation(
  q: Queryable,
  shopperId: string,
  firstMessage: string,
): Promise<ConversationRow> {
  const title = firstMessage.trim().replace(/\s+/g, ' ').slice(0, 80) || null;
  const res = await q.query(
    `INSERT INTO agent_conversations (shopper_id, title) VALUES ($1, $2)
     RETURNING id, shopper_id, title, created_at`,
    [shopperId, title],
  );
  return res.rows[0] as ConversationRow;
}

export interface StoredMessage extends AgentMessage {
  seq: number;
}

/** Every message of a conversation, oldest first (the caller has checked ownership). */
export async function loadMessages(
  q: Queryable,
  shopperId: string,
  conversationId: string,
): Promise<StoredMessage[]> {
  const res = await q.query(
    `SELECT seq, role, content FROM agent_messages
      WHERE conversation_id = $1 AND shopper_id = $2
      ORDER BY seq`,
    [conversationId, shopperId],
  );
  return (
    res.rows as Array<{ seq: number; role: 'user' | 'assistant'; content: ContentBlock[] }>
  ).map((r) => ({ seq: r.seq, role: r.role, content: r.content }));
}

/**
 * Append one message at the next `seq`. The unique (conversation_id, seq) key turns a concurrent
 * writer into a retry instead of an interleaving.
 */
export async function appendMessage(
  q: Queryable,
  shopperId: string,
  conversationId: string,
  message: AgentMessage,
): Promise<number> {
  const toolCalls = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name }));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await q.query(
        `INSERT INTO agent_messages (conversation_id, shopper_id, seq, role, content, tool_calls)
         SELECT $1, $2, coalesce(max(seq), 0) + 1, $3, $4::jsonb, $5::jsonb
           FROM agent_messages WHERE conversation_id = $1
         RETURNING seq`,
        [
          conversationId,
          shopperId,
          message.role,
          JSON.stringify(message.content),
          toolCalls.length ? JSON.stringify(toolCalls) : null,
        ],
      );
      await q.query(`UPDATE agent_conversations SET updated_at = now() WHERE id = $1`, [
        conversationId,
      ]);
      return (res.rows[0] as { seq: number }).seq;
    } catch (err) {
      const pg = err as { code?: string; constraint?: string };
      if (
        attempt < 5 &&
        pg.code === '23505' &&
        pg.constraint === 'agent_messages_conversation_seq_key'
      ) {
        continue;
      }
      throw err;
    }
  }
}

const isToolResultMessage = (m: AgentMessage) =>
  m.role === 'user' && m.content.some((b) => b.type === 'tool_result');

const textOf = (m: AgentMessage) =>
  m.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A short, deterministic summary of messages dropped from the window (no model call). */
export function summarise(dropped: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of dropped) {
    if (m.role === 'assistant') {
      const tools = m.content.filter((b) => b.type === 'tool_use').map((b) => String(b.name));
      const text = textOf(m);
      if (text) lines.push(`Agent: ${text.slice(0, 160)}`);
      if (tools.length) lines.push(`Agent used tools: ${tools.join(', ')}`);
    } else if (!isToolResultMessage(m)) {
      const text = textOf(m);
      if (text)
        lines.push(
          `${text.startsWith('[Holdfast server]') ? '' : 'Shopper: '}${text.slice(0, 160)}`,
        );
    }
  }
  let out = lines.join('\n');
  if (out.length > SUMMARY_MAX_CHARS) out = `…${out.slice(out.length - SUMMARY_MAX_CHARS)}`;
  return out;
}

const stripThinking = (m: AgentMessage): AgentMessage =>
  m.role === 'assistant'
    ? {
        ...m,
        content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking'),
      }
    : m;

/**
 * The messages to send the model: the whole history when it fits, else a summary of the older
 * part plus the newest ≤ `window` messages, cut at a plain user message so no `tool_result` is
 * separated from its `tool_use`. When trimmed, replayed thinking blocks are dropped (their prefix
 * changed). Always starts with a user message.
 */
export function windowHistory(
  messages: readonly AgentMessage[],
  window = HISTORY_WINDOW,
): AgentMessage[] {
  const all = messages.map(({ role, content }) => ({ role, content }));
  if (all.length <= window) return all;
  let cut = all.length - window;
  while (cut < all.length && (all[cut]!.role !== 'user' || isToolResultMessage(all[cut]!))) cut++;
  if (cut >= all.length) {
    // No clean boundary inside the window: keep from the last plain user message.
    cut = all.length - 1;
    while (cut > 0 && (all[cut]!.role !== 'user' || isToolResultMessage(all[cut]!))) cut--;
  }
  const summary = summarise(all.slice(0, cut));
  const kept = all.slice(cut).map(stripThinking);
  if (!summary) return kept;
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[Holdfast server] Summary of the earlier part of this conversation (for context only; re-check prices and bids with tools):\n${summary}`,
        },
      ],
    },
    ...kept,
  ];
}
