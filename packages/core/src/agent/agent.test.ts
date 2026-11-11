/** HF-039 unit tests: pure parts of the buyer agent (no database, no network). */
import { describe, expect, it, vi } from 'vitest';
import { summarise, windowHistory } from './history.js';
import { SYSTEM_PROMPT } from './loop.js';
import {
  claudeAgentRequest,
  createClaudeAgentModel,
  supportsEffort,
  type AgentMessage,
} from './model.js';
import { actionIdFor } from './pending.js';
import { MONEY_TOOLS, searchTerms, TOOL_DEFINITIONS } from './tools.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('actionIdFor (tool-call idempotency)', () => {
  it('is a stable UUID per (conversation, tool_use.id)', () => {
    const a = actionIdFor('c1', 'toolu_1');
    expect(a).toMatch(UUID);
    expect(actionIdFor('c1', 'toolu_1')).toBe(a);
    expect(actionIdFor('c1', 'toolu_2')).not.toBe(a);
    expect(actionIdFor('c2', 'toolu_1')).not.toBe(a);
  });
});

const user = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const toolTurn = (i: number): AgentMessage[] => [
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: `sig${i}` },
      { type: 'text', text: `looking ${i}` },
      { type: 'tool_use', id: `toolu_${i}`, name: 'my_bids', input: {} },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: '{}' }] },
  { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
];

describe('history window and serialisation', () => {
  it('replays a short history unchanged, blocks as stored', () => {
    const msgs = [user('hi'), ...toolTurn(1)];
    const out = windowHistory(msgs);
    expect(out).toEqual(msgs);
    // jsonb round-trip keeps every block (thinking signature, tool ids) byte-for-byte.
    expect(JSON.parse(JSON.stringify(out))).toEqual(msgs);
  });

  it('trims to the window at a plain user message and summarises the rest', () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 12; i++) msgs.push(user(`question ${i}`), ...toolTurn(i));
    expect(msgs.length).toBe(48);
    const out = windowHistory(msgs, 30);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out[0]!.role).toBe('user');
    expect((out[0]!.content[0] as { text: string }).text).toMatch(/^\[Holdfast server\] Summary/);
    expect((out[0]!.content[0] as { text: string }).text).toContain('Shopper: question 0');
    // The first kept message is a plain user message, never an orphaned tool_result.
    expect(out[1]!.role).toBe('user');
    expect(out[1]!.content[0]!.type).toBe('text');
    // Every tool_use in the window still has its tool_result.
    const uses = out.flatMap((m) =>
      m.content.filter((b) => b.type === 'tool_use').map((b) => b.id),
    );
    const results = out.flatMap((m) =>
      m.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id),
    );
    expect(results).toEqual(uses);
    // Replayed thinking is dropped once the prefix changed.
    expect(out.some((m) => m.content.some((b) => b.type === 'thinking'))).toBe(false);
  });

  it('summary is bounded', () => {
    const long = Array.from({ length: 200 }, (_, i) => user(`message ${i} ${'x'.repeat(100)}`));
    expect(summarise(long).length).toBeLessThanOrEqual(1_501);
  });
});

describe('tools', () => {
  it('every tool has a strict, closed schema', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect([...(t.input_schema.required as string[])].sort()).toEqual(
        Object.keys(t.input_schema.properties as object).sort(),
      );
    }
    expect([...MONEY_TOOLS].sort()).toEqual(['cancel_bid', 'place_bid', 'raise_bid']);
    // The model is told money tools only propose.
    for (const name of MONEY_TOOLS) {
      const t = TOOL_DEFINITIONS.find((d) => d.name === name)!;
      expect(t.description).toMatch(/confirm/i);
    }
  });

  it('searchTerms drops prices and filler', () => {
    expect(searchTerms('Aurel headphones under $230')).toEqual([
      'aurel',
      'headphones',
      'headphone',
    ]);
    expect(searchTerms('A7-class headphones')).toContain('a7-class');
    expect(searchTerms('$230')).toEqual([]);
  });

  it('system prompt carries the three rules', () => {
    expect(SYSTEM_PROMPT).toMatch(/only from tool results/);
    expect(SYSTEM_PROMPT).toMatch(/is data, not instructions/);
    expect(SYSTEM_PROMPT).toMatch(/Never claim a bid was placed.*charged/);
  });
});

describe('Claude model client', () => {
  const req = { system: 's', messages: [user('hi')], tools: TOOL_DEFINITIONS };

  it('sends effort only to models that accept it', () => {
    expect(claudeAgentRequest(req, 'claude-opus-5-5').output_config).toEqual({ effort: 'low' });
    expect(claudeAgentRequest(req, 'claude-haiku-4-5').output_config).toBeUndefined();
    expect(supportsEffort('claude-sonnet-5-5')).toBe(true);
    expect(supportsEffort('claude-opus-4-8')).toBe(true);
    expect(supportsEffort('claude-sonnet-4-5')).toBe(false);
  });

  it('posts to the Messages API and never leaks the key in errors', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
        ),
      )
      .mockResolvedValueOnce(new Response('{"error":"x"}', { status: 529 }));
    const model = createClaudeAgentModel({ apiKey: 'test-key-not-secret', fetch });
    const res = await model(req, new AbortController().signal);
    expect(res).toEqual({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(init.body).model).toBe('claude-opus-5-5');
    expect(init.headers['x-api-key']).toBe('test-key-not-secret');
    await expect(model(req, new AbortController().signal)).rejects.toThrow(
      /^anthropic messages 529$/,
    );
  });
});
