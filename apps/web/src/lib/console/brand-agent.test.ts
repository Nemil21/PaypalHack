import { describe, expect, it } from 'vitest';
import type { BrandAgentAskResponse } from '@holdfast/shared';
import {
  AGENT_PAGE_ID,
  AGENT_UNAVAILABLE_COPY,
  agentBidRows,
  agentWidgetState,
  askBrandAgent,
  askEvents,
  explainKey,
  questionAndHistory,
  simulateCard,
  toolLabel,
  withAgentWidget,
} from './brand-agent';

const sim = {
  quantity: 300,
  cutoffCents: 19_900,
  winners: 272,
  losers: 8,
  grossCents: 6_081_700,
  averageWinningCents: 22_359,
  feeBps: 900,
  feeCents: 547_353,
  netCents: 5_534_347,
  liquidationCents: 1_033_600,
  recoveryMultiple: 5.88,
  holdsTooOld: 0,
  bookVersion: 'v1',
};

function response(over: Partial<BrandAgentAskResponse> = {}): BrandAgentAskResponse {
  return {
    answer: 'Clearing 300 puts the cutoff at $199.',
    available: true,
    recommendation: { quantity: 240, cutoffCents: 21_900, grossCents: 5_413_300, reasons: [] },
    steps: [
      { tool: 'get_recommendation', input: {}, ok: true, result: {} },
      { tool: 'get_book_summary', input: {}, ok: true, result: {} },
      { tool: 'simulate_clear', input: { quantity: 300 }, ok: true, result: sim },
    ],
    widgets: [],
    unverifiedNumbers: [],
    ...over,
  };
}

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

describe('askEvents (AG Studio clientToolRunner turn)', () => {
  it('resolved server tool calls (seeds skipped), then the answer', () => {
    const { events, pending } = askEvents(response(), ids());
    expect(pending).toBeNull();
    expect(events.map((e) => e.type)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
    expect(events[0]).toMatchObject({ toolCallName: 'simulate_clear' });
    expect(JSON.parse((events[3] as { content: string }).content)).toEqual(sim);
    expect(events[5]).toMatchObject({ delta: 'Clearing 300 puts the cutoff at $199.' });
  });

  it('a widget request is left unresolved for Studio; the answer waits for the resume', () => {
    const { events, pending } = askEvents(
      response({ steps: response().steps.slice(0, 2), widgets: [{ kind: 'held_by_source' }] }),
      ids(),
    );
    expect(events.map((e) => e.type)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ]);
    expect(events[0]).toMatchObject({ toolCallName: 'add_console_widget' });
    expect(JSON.parse((events[1] as { delta: string }).delta)).toEqual({ kind: 'held_by_source' });
    expect(pending).toEqual({ toolCallId: 'id1', text: 'Clearing 300 puts the cutoff at $199.' });
  });

  it('Claude down: the fallback copy, no tool calls', () => {
    const { events } = askEvents(response({ answer: null, available: false, steps: [] }), ids());
    expect(events[1]).toMatchObject({ delta: AGENT_UNAVAILABLE_COPY });
  });

  it('an unverified number gets a note pointing at the cards', () => {
    const { events } = askEvents(response({ unverifiedNumbers: ['$99,999'] }), ids());
    expect((events[5] as { delta: string }).delta).toContain('$99,999 is not in the tool results');
  });
});

describe('questionAndHistory', () => {
  it('takes the last user message and the earlier text turns', () => {
    expect(
      questionAndHistory([
        { role: 'user', content: 'What if I clear 300?' },
        { role: 'assistant', content: 'Cutoff $199.' },
        { role: 'tool', content: '{}', toolCallId: 't' },
        { role: 'assistant', content: '' },
        { role: 'user', content: ' And 260? ' },
      ]),
    ).toEqual({
      question: 'And 260?',
      history: [
        { role: 'user', text: 'What if I clear 300?' },
        { role: 'assistant', text: 'Cutoff $199.' },
      ],
    });
    expect(questionAndHistory([])).toEqual({ question: null, history: [] });
  });
});

describe('thread cards render numbers from JSON only', () => {
  it('simulateCard', () => {
    expect(simulateCard(JSON.stringify(sim))).toEqual({
      title: 'Clear 300',
      rows: [
        ['Cutoff', '$199'],
        ['Winners', '272'],
        ['Released', '8'],
        ['Gross', '$60,817'],
        ['Fee', '$5,473.53'],
        ['Net', '$55,343.47'],
        ['Liquidation', '$10,336'],
        ['vs liquidation', '×5.88'],
      ],
      warning: null,
    });
    expect(simulateCard({ ...sim, holdsTooOld: 3 })!.warning).toContain('3 winning holds');
    expect(simulateCard({ error: { code: 'VALIDATION_ERROR' } })).toBeNull();
    expect(simulateCard('not json')).toBeNull();
  });

  it('toolLabel', () => {
    expect(toolLabel('add_console_widget', { kind: 'held_by_source' })).toBe(
      'Added widget: Held $ by source',
    );
    expect(toolLabel('simulate_clear', { quantity: 120 })).toBe('Simulated clearing 120');
  });
});

describe('agent dashboard widgets', () => {
  it('rows from the console bids', () => {
    const rows = agentBidRows({
      bids: [
        {
          id: 'b1',
          amountCents: 21_950,
          rank: 1,
          placedAtUs: '1',
          source: 'MCP',
          isSimulated: false,
          shopperLabel: 'Shopper #1001',
          status: 'HELD',
          belowFloor: false,
        },
        {
          id: 'b2',
          amountCents: 19_900,
          rank: 2,
          placedAtUs: '2',
          source: null,
          isSimulated: true,
          shopperLabel: 'Shopper #1002',
          status: 'HELD',
          belowFloor: false,
        },
      ],
    });
    expect(rows).toEqual([
      { bidId: 'b1', amount: 219.5, source: 'MCP', priceBand: '$210–$219', kind: 'Real' },
      { bidId: 'b2', amount: 199, source: 'Simulated', priceBand: '$190–$199', kind: 'Simulated' },
    ]);
  });

  it('widget state references qualified Studio fields', () => {
    expect(agentWidgetState('held_by_source')).toEqual({
      type: 'column-chart-grouped',
      dataMapping: {
        categoryKey: [{ id: 'bids.source' }],
        valueKey: [{ id: 'bids.amount', aggregation: 'sum' }],
      },
      format: { title: { enabled: true, text: 'Held $ by source' } },
    });
  });

  it('adds each kind once, laid out in two columns', () => {
    const empty = {
      selectedPageId: AGENT_PAGE_ID,
      pages: [{ id: AGENT_PAGE_ID, widgets: {}, widgetLayout: {} }],
    };
    const a = withAgentWidget(empty, 'held_by_source');
    expect(a).toMatchObject({ added: true, count: 1 });
    const b = withAgentWidget(a.state, 'bids_by_price');
    const c = withAgentWidget(b.state, 'simulated_vs_real');
    expect(c.count).toBe(3);
    expect(c.state.pages[0]!.widgetLayout).toEqual({
      'agent-held_by_source': { xTrack: 0, yTrack: 0, xSpan: 1, ySpan: 12 },
      'agent-bids_by_price': { xTrack: 1, yTrack: 0, xSpan: 1, ySpan: 12 },
      'agent-simulated_vs_real': { xTrack: 0, yTrack: 12, xSpan: 1, ySpan: 12 },
    });
    const again = withAgentWidget(c.state, 'held_by_source');
    expect(again).toMatchObject({ added: false, count: 3 });
    expect(again.state).toBe(c.state);
  });
});

describe('askBrandAgent / explainKey', () => {
  it('posts with an Idempotency-Key and validates the response', async () => {
    const calls: { path: string; key?: string; body: unknown }[] = [];
    const res = await askBrandAgent(
      { listingId: '00000000-0000-4000-8000-000000000001', question: 'All 300?' },
      {
        client: {
          request: async (req, key) => {
            calls.push({ path: req.path, key, body: req.body });
            return response() as never;
          },
        },
      },
    );
    expect(res.answer).toContain('$199');
    expect(calls[0]!.path).toBe('/api/brand-agent/ask');
    expect(calls[0]!.key).toBeTruthy();
  });

  it('explainKey changes with the recommendation, not with every bid', () => {
    const rec = {
      kind: 'RECOMMEND' as const,
      quantity: 240,
      cutoffCents: 21_900,
      grossCents: 5_413_300,
      netCents: 1,
      liquidationCents: null,
      withinGuard: true,
      minCutoffCents: 21_762,
      alternatives: [],
    };
    expect(explainKey('l', rec)).toBe('l:240:21900:5413300');
    expect(explainKey('l', { kind: 'NO_DEMAND', minCutoffCents: 1 })).toBeNull();
    expect(explainKey('l', undefined)).toBeNull();
  });
});
