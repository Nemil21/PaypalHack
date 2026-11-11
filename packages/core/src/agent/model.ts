/**
 * The buyer agent's model port (HF-039). The loop only needs "send these messages and tools, get
 * one assistant message back", so tests plug in a scripted stub and production uses the Anthropic
 * Messages API over `fetch` (no SDK, like `rounds/phrasing.ts`).
 */

/** Anthropic content blocks, kept loose: assistant arrays are persisted and replayed as-is. */
export type ContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      [k: string]: unknown;
    }
  | { type: string; [k: string]: unknown };

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ModelRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
}

export interface ModelResponse {
  content: ContentBlock[];
  /** `end_turn`, `tool_use`, `max_tokens`, `refusal`, … */
  stop_reason: string | null;
}

export type AgentModel = (req: ModelRequest, signal: AbortSignal) => Promise<ModelResponse>;

/** Default when `ANTHROPIC_MODEL` is unset. */
export const DEFAULT_AGENT_MODEL = 'claude-opus-5-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export interface ClaudeAgentModelOptions {
  apiKey: string;
  model?: string;
  /** `output_config.effort`; chat turns stay well inside the 20 s budget at `low`. */
  effort?: 'low' | 'medium' | 'high';
  /** Test seam. */
  fetch?: typeof fetch;
}

/** Haiku 4.5, Sonnet 4.5 and older reject `output_config.effort`. */
export function supportsEffort(model: string): boolean {
  return (
    /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[5678])/.test(model) &&
    !/^claude-(sonnet|haiku)-4-5/.test(model)
  );
}

/** The exact request body sent (exported so tests can check it carries no secrets or floors). */
export function claudeAgentRequest(
  req: ModelRequest,
  model: string,
  effort: ClaudeAgentModelOptions['effort'] = 'low',
): Record<string, unknown> {
  return {
    model,
    max_tokens: 4096,
    system: req.system,
    tools: req.tools,
    messages: req.messages,
    ...(supportsEffort(model) ? { output_config: { effort } } : {}),
  };
}

export function createClaudeAgentModel(opts: ClaudeAgentModelOptions): AgentModel {
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? DEFAULT_AGENT_MODEL;
  return async (req, signal) => {
    const res = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(claudeAgentRequest(req, model, opts.effort)),
    });
    // Status only: the body may echo the request, and the key must never reach logs.
    if (!res.ok) throw new Error(`anthropic messages ${res.status}`);
    const body = (await res.json()) as { content?: ContentBlock[]; stop_reason?: string | null };
    return { content: body.content ?? [], stop_reason: body.stop_reason ?? null };
  };
}
