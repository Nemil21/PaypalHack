import {
  BRAND_AGENT_WIDGET_TITLES,
  brandAgentAskResponseSchema,
  formatUsd,
  type BookResponse,
  type BrandAgentAskRequest,
  type BrandAgentAskResponse,
  type BrandAgentWidgetKind,
  type Recommendation,
} from '@holdfast/shared';
import { api as defaultApi, newIdempotencyKey, type ApiClient } from '../api';

/**
 * W06 brand agent Ask panel (HF-051b; features/09 §Logic 2–4, §Edge cases). No React and no AG
 * imports, so it is unit-tested directly:
 * - the `POST /api/brand-agent/ask` call;
 * - the AG-UI events the AG Studio agent emits for one server answer (`askEvents`);
 * - the widgets the agent can add to its AG Studio dashboard, built from the console's bids;
 * - the cards the thread renders **from tool JSON fields only** (the text is commentary).
 */

export const AGENT_UNAVAILABLE_COPY =
  'The brand agent is unavailable right now. The recommendation above is computed by code and is still current.';

/** The three demo questions (features/09 user stories; the manual test plan). */
export function demoQuestions(quantity: number): { label: string; prompt: string }[] {
  return [
    { label: `Clear all ${quantity}?`, prompt: `What if I clear all ${quantity}?` },
    { label: 'Why not more or fewer?', prompt: 'Why that quantity and not more or fewer?' },
    { label: 'Chart held $ by source', prompt: 'Add a widget showing held dollars by source.' },
  ];
}

export async function askBrandAgent(
  body: BrandAgentAskRequest,
  opts: { signal?: AbortSignal; client?: ApiClient } = {},
): Promise<BrandAgentAskResponse> {
  const client = opts.client ?? defaultApi;
  const res = await client.request<unknown>(
    { method: 'POST', path: '/api/brand-agent/ask', body, signal: opts.signal },
    newIdempotencyKey(),
  );
  return brandAgentAskResponseSchema.parse(res);
}

/** The prose under the card is fetched once per recommendation, not once per bid. */
export function explainKey(listingId: string, rec: Recommendation | undefined): string | null {
  if (!rec || rec.kind !== 'RECOMMEND') return null;
  return `${listingId}:${rec.quantity}:${rec.cutoffCents}:${rec.grossCents}`;
}

// --- AG Studio agent run ----------------------------------------------------------------------

/** The subset of AG-UI messages the run reads (`AgAiRunInput.messages`). */
export interface RunMessage {
  role: string;
  content?: string;
  toolCallId?: string;
  error?: string;
}

/** The latest question and the earlier text turns (at most 8), for `history`. */
export function questionAndHistory(messages: readonly RunMessage[]): {
  question: string | null;
  history: { role: 'user' | 'assistant'; text: string }[];
} {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0 && lastUser < 0; i--) {
    if (messages[i]!.role === 'user') lastUser = i;
  }
  if (lastUser < 0) return { question: null, history: [] };
  const history = messages
    .slice(0, lastUser)
    .filter(
      (m): m is RunMessage & { role: 'user' | 'assistant'; content: string } =>
        (m.role === 'user' || m.role === 'assistant') && !!m.content?.trim(),
    )
    .map((m) => ({ role: m.role, text: m.content.slice(0, 4_000) }))
    .slice(-8);
  return { question: messages[lastUser]!.content?.trim() || null, history };
}

export type AgentEvent =
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string }
  | {
      type: 'TOOL_CALL_RESULT';
      messageId: string;
      toolCallId: string;
      content: string;
      role: 'tool';
    };

export function textEvents(text: string, id: string): AgentEvent[] {
  return [
    { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text },
    { type: 'TEXT_MESSAGE_END', messageId: id },
  ];
}

/** The answer text, with a note when it quotes a number no tool returned. */
export function answerText(res: BrandAgentAskResponse): string {
  if (!res.answer) return AGENT_UNAVAILABLE_COPY;
  if (!res.unverifiedNumbers.length) return res.answer;
  return `${res.answer}\n\n(${res.unverifiedNumbers.join(', ')} ${res.unverifiedNumbers.length === 1 ? 'is' : 'are'} not in the tool results; trust the cards.)`;
}

/** Steps the server ran before the model's first turn (always the first two). */
const SEEDED = 2;

/**
 * One server answer as AG-UI events. The server's read-only tool calls arrive resolved (call +
 * result), so Studio shows them and never runs them. A widget request is left unresolved: Studio
 * runs `add_console_widget` in the browser and calls the agent again, which then says the answer
 * (`pendingText`).
 */
export function askEvents(
  res: BrandAgentAskResponse,
  newId: () => string,
): { events: AgentEvent[]; pending: { toolCallId: string; text: string } | null } {
  const events: AgentEvent[] = [];
  for (const step of res.available ? res.steps.slice(SEEDED) : []) {
    const id = newId();
    events.push(
      { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: step.tool },
      { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(step.input ?? {}) },
      { type: 'TOOL_CALL_END', toolCallId: id },
      {
        type: 'TOOL_CALL_RESULT',
        messageId: newId(),
        toolCallId: id,
        content: JSON.stringify(step.result),
        role: 'tool',
      },
    );
  }
  const text = answerText(res);
  const widget = res.widgets[0];
  if (!widget) return { events: [...events, ...textEvents(text, newId())], pending: null };
  const id = newId();
  events.push(
    { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'add_console_widget' },
    { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify({ kind: widget.kind }) },
    { type: 'TOOL_CALL_END', toolCallId: id },
  );
  return { events, pending: { toolCallId: id, text } };
}

// --- Agent dashboard widgets (AG Studio) ------------------------------------------------------

export const AGENT_PAGE_ID = 'agent';
export const AGENT_SOURCE_ID = 'bids';
const BAND_CENTS = 1_000;

export interface AgentBidRow {
  [k: string]: string | number;
  bidId: string;
  amount: number;
  source: string;
  priceBand: string;
  kind: string;
}

const SOURCE_LABEL: Record<string, string> = {
  OFFER_PAGE: 'Offer page',
  BUYER_AGENT: 'Buyer agent',
  MCP: 'MCP',
  SIM: 'Simulated',
};

/** The console's held bids as Studio rows (dollars; the band label sorts as text). */
export function agentBidRows(book: Pick<BookResponse, 'bids'> | null): AgentBidRow[] {
  return (book?.bids ?? []).map((b) => {
    const from = Math.floor(b.amountCents / BAND_CENTS) * BAND_CENTS;
    const source = b.isSimulated ? 'SIM' : (b.source ?? 'UNKNOWN');
    return {
      bidId: b.id,
      amount: b.amountCents / 100,
      source: SOURCE_LABEL[source] ?? source,
      priceBand: `${formatUsd(from)}–${formatUsd(from + BAND_CENTS - 100)}`,
      kind: b.isSimulated ? 'Simulated' : 'Real',
    };
  });
}

export interface AgentWidgetState {
  type: string;
  dataMapping: Record<string, { id: string; aggregation?: string }[]>;
  format: { title: { enabled: boolean; text: string } };
}

/** Studio field references are `<source>.<field>`. */
const field = (id: string, aggregation?: string) => ({
  id: `${AGENT_SOURCE_ID}.${id}`,
  ...(aggregation ? { aggregation } : {}),
});

export function agentWidgetState(kind: BrandAgentWidgetKind): AgentWidgetState {
  const title = { title: { enabled: true, text: BRAND_AGENT_WIDGET_TITLES[kind] } };
  switch (kind) {
    case 'held_by_source':
      return {
        type: 'column-chart-grouped',
        dataMapping: {
          categoryKey: [field('source')],
          valueKey: [field('amount', 'sum')],
        },
        format: title,
      };
    case 'bids_by_price':
      return {
        type: 'column-chart-grouped',
        dataMapping: {
          categoryKey: [field('priceBand')],
          valueKey: [field('bidId', 'count')],
        },
        format: title,
      };
    case 'simulated_vs_real':
      return {
        type: 'column-chart-grouped',
        dataMapping: {
          categoryKey: [field('kind')],
          valueKey: [field('amount', 'sum')],
        },
        format: title,
      };
  }
}

/** Two columns of 12 × 22 px rows: one widget per kind, in the order the agent added them. */
export const AGENT_PAGE_LAYOUT = { columns: 2, rowHeight: 22, pagePadding: 0, widgetPadding: 8 };
export const WIDGET_ROWS = 12;

interface PageLike {
  id: string;
  widgets?: Partial<Record<string, unknown>>;
  widgetLayout?: Partial<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * The report state with `kind` added to the agent page. `added: false` when it is already
 * there (asking twice does not stack copies).
 */
export function withAgentWidget<S extends { pages: PageLike[] }>(
  state: S,
  kind: BrandAgentWidgetKind,
): { state: S; added: boolean; count: number } {
  const page = state.pages.find((p) => p.id === AGENT_PAGE_ID);
  const widgets = { ...(page?.widgets ?? {}) };
  const id = `agent-${kind}`;
  const count = Object.keys(widgets).length;
  if (widgets[id]) return { state, added: false, count };
  widgets[id] = agentWidgetState(kind);
  const layout = {
    ...(page?.widgetLayout ?? {}),
    [id]: {
      xTrack: count % 2,
      yTrack: Math.floor(count / 2) * WIDGET_ROWS,
      xSpan: 1,
      ySpan: WIDGET_ROWS,
    },
  };
  const next: PageLike = {
    ...(page ?? { id: AGENT_PAGE_ID, layout: AGENT_PAGE_LAYOUT }),
    widgets,
    widgetLayout: layout,
  };
  const pages = page
    ? state.pages.map((p) => (p.id === AGENT_PAGE_ID ? next : p))
    : [...state.pages, next];
  return { state: { ...state, pages }, added: true, count: count + 1 };
}

// --- Thread cards (numbers from JSON fields only) ---------------------------------------------

export interface FactCard {
  title: string;
  rows: [label: string, value: string][];
  warning: string | null;
}

const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
const usd = (v: unknown) => (int(v) === null ? '—' : formatUsd(v as number));

/** A `simulate_clear` result as a card. Null when the JSON is not a simulate result. */
export function simulateCard(result: unknown): FactCard | null {
  const r = (typeof result === 'string' ? safeParse(result) : result) as Record<
    string,
    unknown
  > | null;
  if (!r || int(r.quantity) === null || !('grossCents' in r)) return null;
  const rows: [string, string][] = [
    ['Cutoff', usd(r.cutoffCents)],
    ['Winners', String(int(r.winners) ?? '—')],
    ['Released', String(int(r.losers) ?? '—')],
    ['Gross', usd(r.grossCents)],
    ['Fee', usd(r.feeCents)],
    ['Net', usd(r.netCents)],
  ];
  if (int(r.liquidationCents) !== null) rows.push(['Liquidation', usd(r.liquidationCents)]);
  if (typeof r.recoveryMultiple === 'number')
    rows.push(['vs liquidation', `×${r.recoveryMultiple}`]);
  const aged = int(r.holdsTooOld) ?? 0;
  return {
    title: `Clear ${r.quantity}`,
    rows,
    warning: aged > 0 ? `${aged} winning holds are too old to capture; Clear would refuse.` : null,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Short label for a tool step in the thread. */
export function toolLabel(name: string, args: Record<string, unknown> | undefined): string {
  switch (name) {
    case 'simulate_clear':
      return `Simulated clearing ${String(args?.quantity ?? '')}`.trim();
    case 'get_book_summary':
      return 'Read the book';
    case 'get_recommendation':
      return 'Read the recommendation';
    case 'add_console_widget': {
      const kind = args?.kind as BrandAgentWidgetKind | undefined;
      return kind && kind in BRAND_AGENT_WIDGET_TITLES
        ? `Added widget: ${BRAND_AGENT_WIDGET_TITLES[kind]}`
        : 'Added a widget';
    }
    default:
      return name;
  }
}
