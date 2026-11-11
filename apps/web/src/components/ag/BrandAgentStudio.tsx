import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  clientToolRunner,
  createAiHarness,
  type AgAiAgentRun,
  type AgAiChatMessage,
  type AgAiChatSession,
  type AgAiEvent,
  type AgAiHarness,
  type AgAiParamsBuilder,
  type AgAiTool,
  type AgAiToolContext,
  type AgDataSourcesDefinition,
  type AgReportState,
  type AgStudioApi,
} from 'ag-studio';
import { AgStudio } from 'ag-studio-react';
import {
  BRAND_AGENT_WIDGETS,
  BRAND_AGENT_WIDGET_TITLES,
  type BookResponse,
  type BrandAgentWidgetKind,
} from '@holdfast/shared';
import { registerAg, studioV3Theme } from '../../lib/ag';
import { cn } from '../../lib/cn';
import {
  AGENT_PAGE_ID,
  AGENT_PAGE_LAYOUT,
  AGENT_SOURCE_ID,
  agentBidRows,
  askBrandAgent,
  askEvents,
  demoQuestions,
  questionAndHistory,
  simulateCard,
  textEvents,
  toolLabel,
  withAgentWidget,
  type FactCard,
  type RunMessage,
} from '../../lib/console/brand-agent';
import { Button } from '../ui';

registerAg();

/**
 * W06 "Ask about this book" (HF-051b, features/09 §Logic 3–4) on the AG Studio Agent Framework
 * (M26). Studio's harness owns the conversation and the agent loop: the agent is a
 * `clientToolRunner` whose turns come from `POST /api/brand-agent/ask` (Claude with read-only
 * tools, server-side), and whose one client tool, `add_console_widget`, Studio runs here against
 * this Studio's own dashboard. The thread renders numbers from tool JSON only; text is commentary.
 */

const AGENT_ID = 'holdfast-brand-agent';

const SERVER_TOOLS: { name: string; description: string; quantity: boolean }[] = [
  { name: 'get_book_summary', description: 'Read the live book (server).', quantity: false },
  { name: 'simulate_clear', description: 'Simulate clearing a quantity (server).', quantity: true },
  { name: 'get_recommendation', description: 'The code recommendation (server).', quantity: false },
];

const emptyReport = {
  selectedPageId: AGENT_PAGE_ID,
  pages: [{ id: AGENT_PAGE_ID, layout: AGENT_PAGE_LAYOUT, widgets: {}, widgetLayout: {} }],
} as unknown as AgReportState;

export default function BrandAgentStudio({ book }: { book: BookResponse }) {
  const listingId = book.listing.id;
  const rows = useMemo(() => agentBidRows(book), [book]);
  // Studio's `data` is reactive: added widgets follow the live book.
  const data = useMemo<AgDataSourcesDefinition>(
    () => ({
      description: 'Held bids in this listing console (brand-only).',
      sources: [
        {
          id: AGENT_SOURCE_ID,
          description: 'One row per held bid in the Clear input.',
          data: rows,
          fields: [
            { id: 'bidId', name: 'Bid', format: 'textFormat' },
            { id: 'amount', name: 'Held $', format: 'currencyFormat' },
            { id: 'source', name: 'Source', format: 'textFormat' },
            { id: 'priceBand', name: 'Price band', format: 'textFormat' },
            { id: 'kind', name: 'Simulated or real', format: 'textFormat' },
          ],
        },
      ],
    }),
    [rows],
  );

  const [harness, setHarness] = useState<AgAiHarness | null>(null);
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [, setVersion] = useState(0);
  const [widgets, setWidgets] = useState(0);
  const [draft, setDraft] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const pending = useRef(new Map<string, string>());
  const idSeq = useRef(0);
  const newId = () => `hf-${listingId.slice(0, 8)}-${++idSeq.current}`;

  const run: AgAiAgentRun = async function* (input, ctx) {
    const messages = input.messages as unknown as RunMessage[];
    const last = messages[messages.length - 1];
    // Resumed after Studio ran add_console_widget: say the answer the server already wrote.
    if (last?.role === 'tool' && last.toolCallId && pending.current.has(last.toolCallId)) {
      const text = pending.current.get(last.toolCallId)!;
      pending.current.delete(last.toolCallId);
      const note = last.error ? `\n\n(The widget could not be added: ${last.error})` : '';
      yield* textEvents(`${text}${note}`, newId()) as AgAiEvent[];
      return;
    }
    const { question, history } = questionAndHistory(messages);
    if (!question) return;
    let res;
    try {
      res = await askBrandAgent({ listingId, question, history }, { signal: ctx.signal });
    } catch (err) {
      if (ctx.signal?.aborted) return;
      const message =
        (err as { code?: string }).code === 'RATE_LIMITED'
          ? 'Too many questions in a minute. Try again shortly.'
          : 'The brand agent could not answer. The recommendation above is still current.';
      yield* textEvents(message, newId()) as AgAiEvent[];
      return;
    }
    const out = askEvents(res, newId);
    if (out.pending) pending.current.set(out.pending.toolCallId, out.pending.text);
    yield* out.events as AgAiEvent[];
  };

  // Studio may report ready more than once; the harness is built once per panel.
  const built = useRef(false);
  const onStudioReady = useRef(({ api }: { api: AgStudioApi }) => {
    if (built.current) return;
    built.current = true;
    const addWidget = api.defineAiTool({
      name: 'add_console_widget',
      description: `Add a chart to the agent dashboard: ${BRAND_AGENT_WIDGETS.join(', ')}.`,
      params: (s: AgAiParamsBuilder) => s.object({ kind: s.enum(BRAND_AGENT_WIDGETS) }),
      execute: ({ kind }: { kind: BrandAgentWidgetKind }, tc: AgAiToolContext) => {
        const result = withAgentWidget(api.getState() as never, kind);
        if (result.added) api.setState(result.state as never);
        setWidgets(result.count);
        const title = BRAND_AGENT_WIDGET_TITLES[kind];
        return tc.success(
          result.added ? `Added "${title}" to the dashboard.` : `"${title}" is already there.`,
          { kind },
        );
      },
    } as never);
    const serverTools: AgAiTool[] = SERVER_TOOLS.map((t) =>
      api.defineAiTool({
        kind: 'server',
        name: t.name,
        description: t.description,
        params: (s: AgAiParamsBuilder) =>
          t.quantity ? s.object({ quantity: s.number() }) : s.object({}),
      } as never),
    );
    setHarness(
      createAiHarness(api, () => ({
        agents: [
          clientToolRunner({
            id: AGENT_ID,
            name: 'Brand agent',
            description: 'Explains this book with read-only tools and adds charts on request.',
            tools: () => [...serverTools, addWidget],
            maxTurns: 4,
            run,
          }),
        ],
        primary: AGENT_ID,
      })),
    );
  }).current;

  useEffect(() => {
    if (!session) return;
    const bump = () => setVersion((v) => v + 1);
    session.addEventListener('changed', bump);
    return () => session.removeEventListener('changed', bump);
  }, [session]);
  useEffect(() => () => harness?.dispose?.(), [harness]);

  const busy = session?.status === 'running';
  const send = async (text: string) => {
    const q = text.trim();
    if (!q || !harness || busy) return;
    setDraft('');
    let s = session;
    if (!s) {
      try {
        s = await harness.createThread({ agentId: AGENT_ID });
      } catch (err) {
        console.error('brand agent: could not start a thread', err);
        setStartError(
          'The brand agent could not start. The recommendation above is still current.',
        );
        return;
      }
      setStartError(null);
      setSession(s);
    }
    // The user message and run start land synchronously, before the re-render reads them; the
    // run's later changes reach the listener attached above.
    s.sendMessage(q);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  const messages = session?.messages ?? [];
  const starters = demoQuestions(book.listing.quantity);

  return (
    <section
      aria-label="Ask about this book"
      className="flex flex-col gap-3 rounded-md border border-line bg-white p-4"
      data-testid="brand-agent-ask"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="label text-[11px] text-muted">Ask about this book</h2>
        <span className="text-[12px] text-muted">
          Read-only: the agent cannot clear or move money
        </span>
      </div>

      {messages.length > 0 && (
        <ol className="flex flex-col gap-3" aria-live="polite" data-testid="brand-agent-thread">
          {(() => {
            // Studio can surface the same tool call on the call and on the resumed turn.
            const seen = new Set<string>();
            return messages.map((m) => <ThreadMessage key={m.id} message={m} seen={seen} />);
          })()}
          {busy && <li className="text-[13px] text-muted">Reading the book…</li>}
        </ol>
      )}

      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {starters.map((q) => (
            <Button
              key={q.label}
              variant="ghost"
              disabled={!harness}
              onClick={() => void send(q.prompt)}
            >
              {q.label}
            </Button>
          ))}
        </div>
      )}

      {startError && <p className="text-[13px] text-orange">{startError}</p>}

      <form className="flex gap-2" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="brand-agent-question">
          Question about this book
        </label>
        <input
          id="brand-agent-question"
          className="min-w-0 flex-1 rounded-sm border border-line px-3 py-2 text-[14px] text-ink placeholder:text-muted focus:border-ink focus:outline-none"
          placeholder="What if I clear 200?"
          maxLength={1_000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!harness}
        />
        <Button type="submit" variant="secondary" disabled={!harness || busy || !draft.trim()}>
          Ask
        </Button>
      </form>

      {/* The agent's AG Studio dashboard: empty until the agent adds a widget. */}
      <div
        className={cn('w-full overflow-x-auto', widgets === 0 && 'h-0 overflow-hidden')}
        aria-hidden={widgets === 0 || undefined}
        data-testid="brand-agent-studio"
      >
        <div className="min-w-[640px]" style={{ height: widgets > 2 ? 560 : 280 }}>
          <AgStudio
            style={{ height: '100%', width: '100%' }}
            theme={studioV3Theme}
            data={data}
            initialState={emptyReport}
            panels={{ view: {} }}
            mode="view"
            onStudioReady={onStudioReady as never}
          />
        </div>
      </div>
    </section>
  );
}

function ThreadMessage({ message, seen }: { message: AgAiChatMessage; seen: Set<string> }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return (
      <li className="self-end rounded-md bg-surface px-3 py-2 text-[14px] text-ink">{text}</li>
    );
  }
  return (
    <li className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          return (
            <p key={i} className="whitespace-pre-line text-[14px] text-body">
              {part.text}
            </p>
          );
        }
        if (part.type === 'error') {
          return (
            <p key={i} className="text-[13px] text-orange">
              {part.message}
            </p>
          );
        }
        if (part.type === 'tool_call') {
          const { toolCallId, name, args, result, status } = part.toolCall;
          if (seen.has(toolCallId)) return null;
          seen.add(toolCallId);
          const card = name === 'simulate_clear' ? simulateCard(result) : null;
          return card ? (
            <FactCardView key={i} card={card} />
          ) : (
            <span key={i} className="label self-start text-[11px] text-muted">
              {toolLabel(name, args as Record<string, unknown>)}
              {status === 'error' ? ' · failed' : ''}
            </span>
          );
        }
        return null;
      })}
    </li>
  );
}

function FactCardView({ card }: { card: FactCard }) {
  return (
    <div className="rounded-sm border border-line" data-testid="brand-agent-card">
      <p className="label border-b border-line px-3 py-2 text-[11px] text-muted">{card.title}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 text-[13px] sm:grid-cols-4">
        {card.rows.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-muted">{label}</dt>
            <dd className="text-ink tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {card.warning && <p className="px-3 pb-2 text-[12px] text-orange">{card.warning}</p>}
    </div>
  );
}
