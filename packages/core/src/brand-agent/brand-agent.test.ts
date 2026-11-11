/**
 * HF-051b: brand agent Ask. Tool registry snapshot per agent context (the ask agent has no
 * state-changing tool and never sees `send_nudge`), the three demo questions answered with
 * numbers equal to `simulate_clear` (the shared `simulateClear()` behind `/simulate`), the widget
 * UI action, and the Claude-down / timeout fallback (the code recommendation still comes back).
 */
import { describe, expect, it } from 'vitest';
import {
  brandAgentAskResponseSchema,
  formatUsd,
  simulateClear,
  type BookResponse,
  type ClearBid,
  type ClearInput,
} from '@holdfast/shared';
import { MONEY_TOOLS, TOOL_DEFINITIONS } from '../agent/tools.js';
import type { AgentModel, ContentBlock, ModelRequest } from '../agent/model.js';
import { recommend } from '../recommend.js';
import { askBrandAgent } from './ask.js';
import { ungroundedNumbers } from './grounding.js';
import {
  BRAND_AGENT_REGISTRIES,
  brandToolDefinitions,
  runAskTool,
  simulateResult,
  type BookReader,
} from './tools.js';

// --- Fixture: an Aurel-like book (240 bids ≥ $219, 60 at $199; public low $279) ---------------

let n = 0;
function bid(amountCents: number, isSimulated = false): ClearBid {
  const i = n++;
  return {
    id: `b${String(i).padStart(5, '0')}`,
    shopperId: `s${i}`,
    amountCents,
    seq: i,
    placedAt: '2026-11-11T10:00:00.000000Z',
    status: 'HELD',
    paypalAuthorizationId: `auth-${i}`,
    authorizedAt: '2026-11-11T10:00:00.000000Z',
    isSimulated,
  };
}
const bids = [
  ...Array.from({ length: 40 }, () => bid(24_900)),
  ...Array.from({ length: 80 }, () => bid(22_900, true)),
  ...Array.from({ length: 120 }, () => bid(21_900)),
  ...Array.from({ length: 60 }, () => bid(19_900, true)),
];
const input: ClearInput = {
  listingId: '00000000-0000-4000-8000-000000000001',
  floorCents: 18_000,
  quantity: 300,
  bids,
  bookVersion: 'v1',
  oldestHoldAuthorizedAt: '2026-11-11T10:00:00.000000Z',
};
const FEE_BPS = 900;
const LIQ = 3_800;
const simOpts = { feeBps: FEE_BPS, liquidationQuoteCents: LIQ };
const recommendation = recommend(input, {
  listingQuantity: 300,
  feeBps: FEE_BPS,
  liquidationQuoteCents: LIQ,
  publicLowCents: 27_900,
  maxDiscountBps: 2_200,
});

function bookFor(rec = recommendation, list = bids): BookResponse {
  const held = list.reduce((s, b) => s + b.amountCents, 0);
  return {
    listing: {
      id: input.listingId,
      slug: 'aurel-a7',
      status: 'OPEN',
      phase: 'OPEN',
      product: { title: 'Aurel A7 Wireless — Midnight', imageUrl: null },
      quantity: 300,
      floorCents: input.floorCents,
      liquidationQuoteCents: LIQ,
      feeBps: FEE_BPS,
      windowOpensAt: null,
      windowClosesAt: '2026-11-13T18:00:00.000Z',
      roundsStartedAt: null,
      roundsEndAt: null,
      roundEndsAt: null,
      currentRound: null,
      targetQuantity: null,
      clearDeadlineAt: null,
      oldestHoldAuthorizedAt: input.oldestHoldAuthorizedAt,
      clearByAt: '2026-11-14T04:00:00.000Z',
      priceWatch: {
        on: true,
        bestPublicPriceCents: 27_900,
        merchant: 'retailer.example',
        offerUrl: null,
        priceUpdatedAt: null,
      },
    },
    stats: {
      liveBids: list.length,
      heldCents: held,
      simulatedHeldCents: list.filter((b) => b.isSimulated).reduce((s, b) => s + b.amountCents, 0),
      bestPublicPriceCents: 27_900,
      releasedByPriceWatch: 0,
    },
    curve: [],
    bids: list.map((b, i) => ({
      id: b.id,
      amountCents: b.amountCents,
      rank: i + 1,
      placedAtUs: '1',
      source: b.isSimulated ? 'SIM' : i % 2 ? 'BUYER_AGENT' : 'OFFER_PAGE',
      isSimulated: b.isSimulated,
      shopperLabel: `Shopper #${1001 + i}`,
      status: 'HELD',
      belowFloor: false,
    })),
    pending: [],
    bookVersion: 'v1',
    asOf: '2026-11-12T10:00:00.000Z',
    recommendation: rec,
  };
}

function reader(book = bookFor()): BookReader & { simulated: number[] } {
  const simulated: number[] = [];
  return {
    simulated,
    book: async () => book,
    simulate: async (_b, _l, q) => {
      simulated.push(q);
      return simulateClear(input, q, simOpts);
    },
  };
}

// --- Scripted model -------------------------------------------------------------------------

type Turn = (req: ModelRequest) => { content: ContentBlock[]; stop_reason: string };
function scripted(turns: Turn[]): AgentModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const model = (async (req: ModelRequest) => {
    requests.push(structuredClone(req));
    const turn = turns[requests.length - 1];
    if (!turn) throw new Error('unexpected model call');
    return turn(req);
  }) as AgentModel & { requests: ModelRequest[] };
  model.requests = requests;
  return model;
}
const toolCall =
  (id: string, name: string, input: unknown): Turn =>
  () => ({
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
  });
/** Reads the last tool_result JSON and lets the test write the answer from it. */
const answerFrom =
  (write: (result: Record<string, number>) => string): Turn =>
  (req) => {
    const last = req.messages[req.messages.length - 1]!;
    const block = last.content.find((b) => b.type === 'tool_result') as { content: string };
    return {
      content: [{ type: 'text', text: write(JSON.parse(block.content)) }],
      stop_reason: 'end_turn',
    };
  };

const scope = { brandId: 'brand-1', listingId: input.listingId };

// --- Registries -----------------------------------------------------------------------------

describe('tool registry per agent context', () => {
  it('matches the snapshot', () => {
    const view = Object.fromEntries(
      Object.entries(BRAND_AGENT_REGISTRIES).map(([ctx, tools]) => [
        ctx,
        tools.map((t) => `${t.name}:${t.effect}:${t.runBy}`),
      ]),
    );
    expect(view).toMatchInlineSnapshot(`
      {
        "ask": [
          "get_book_summary:read:server",
          "simulate_clear:read:server",
          "get_recommendation:read:server",
          "add_console_widget:ui:browser",
        ],
        "nudge": [
          "send_nudge:write:round_runner",
        ],
      }
    `);
  });

  it('the ask agent has no state-changing tool and never sees send_nudge', () => {
    expect(BRAND_AGENT_REGISTRIES.ask.filter((t) => t.effect === 'write')).toEqual([]);
    const names = brandToolDefinitions('ask').map((t) => t.name);
    expect(names).not.toContain('send_nudge');
    for (const t of TOOL_DEFINITIONS) expect(names).not.toContain(t.name);
    for (const t of MONEY_TOOLS) expect(names).not.toContain(t);
    expect(
      names.some((n) =>
        /^(clear|place|cancel|raise|move|create|send|set)_|payout|capture|void/.test(n),
      ),
    ).toBe(false);
  });

  it('the nudge context offers the model nothing: send_nudge is called by the round runner', () => {
    expect(brandToolDefinitions('nudge')).toEqual([]);
  });

  it('explain mode drops the widget tool', () => {
    expect(brandToolDefinitions('ask', { widgets: false }).map((t) => t.name)).toEqual([
      'get_book_summary',
      'simulate_clear',
      'get_recommendation',
    ]);
  });

  it('runAskTool refuses anything outside the ask registry, and the UI tool', async () => {
    const r = reader();
    for (const name of ['send_nudge', 'place_bid', 'clear', 'add_console_widget']) {
      const out = await runAskTool(r, { ...scope, book: bookFor() }, name, {});
      expect(out).toMatchObject({ isError: true, result: { error: { code: 'UNKNOWN_TOOL' } } });
    }
  });

  it('simulate_clear refuses a quantity outside the listing', async () => {
    const r: BookReader = {
      book: async () => bookFor(),
      simulate: async () => {
        const { SimulateQuantityError } = await import('../listings/book.js');
        throw new SimulateQuantityError(300);
      },
    };
    const out = await runAskTool(r, { ...scope, book: bookFor() }, 'simulate_clear', {
      quantity: 400,
    });
    expect(out).toMatchObject({
      isError: true,
      result: { error: { code: 'VALIDATION_ERROR', maxQuantity: 300 } },
    });
  });
});

// --- Demo questions -------------------------------------------------------------------------

describe('three demo questions: numbers match simulate_clear', () => {
  const cases = [
    {
      question: 'What if I clear all 300?',
      quantity: 300,
      write: (s: Record<string, number>) =>
        `Clearing ${s.quantity} sets the cutoff at ${formatUsd(s.cutoffCents)}: ${formatUsd(s.grossCents)} gross, ${formatUsd(s.netCents)} net after the ${formatUsd(s.feeCents)} fee, vs ${formatUsd(s.liquidationCents)} liquidation.`,
    },
    {
      question: 'What do I get if I only clear 120?',
      quantity: 120,
      write: (s: Record<string, number>) =>
        `${s.winners} winners at a ${formatUsd(s.cutoffCents)} cutoff: ${formatUsd(s.grossCents)} gross, ${formatUsd(s.netCents)} net, ${s.recoveryMultiple}x liquidation.`,
    },
    {
      question: 'Why 240 and not more?',
      quantity: 240,
      write: (s: Record<string, number>) =>
        `At ${s.quantity} the cutoff is ${formatUsd(s.cutoffCents)}, inside your guard; ${s.losers} bids are released. Net is ${formatUsd(s.netCents)}.`,
    },
  ];

  it.each(cases)('$question', async ({ question, quantity, write }) => {
    const r = reader();
    const model = scripted([toolCall('t1', 'simulate_clear', { quantity }), answerFrom(write)]);
    const res = await askBrandAgent({ reader: r, model }, { ...scope, question });

    expect(brandAgentAskResponseSchema.parse(res)).toEqual(res);
    const expected = simulateResult(simulateClear(input, quantity, simOpts));
    const step = res.steps.find((s) => s.tool === 'simulate_clear')!;
    expect(step).toEqual({
      tool: 'simulate_clear',
      input: { quantity },
      ok: true,
      result: expected,
    });
    expect(res.answer).toBe(write(expected as unknown as Record<string, number>));
    expect(res.unverifiedNumbers).toEqual([]);
    expect(res.available).toBe(true);
    expect(r.simulated).toEqual([quantity]);
    // The code recommendation rides along unchanged.
    expect(res.recommendation).toMatchObject({ quantity: 240, cutoffCents: 21_900 });
    expect(res.recommendation!.reasons.length).toBeGreaterThan(1);
  });

  it('flags a number the model made up', async () => {
    const model = scripted([
      toolCall('t1', 'simulate_clear', { quantity: 300 }),
      () => ({
        content: [{ type: 'text', text: 'Clearing 300 earns $99,999 gross.' }],
        stop_reason: 'end_turn',
      }),
    ]);
    const res = await askBrandAgent(
      { reader: reader(), model },
      { ...scope, question: 'All 300?' },
    );
    expect(res.unverifiedNumbers).toEqual(['$99,999']);
  });

  it('seeds get_recommendation and get_book_summary, and sends prior turns as text', async () => {
    const model = scripted([
      () => ({ content: [{ type: 'text', text: 'Sure.' }], stop_reason: 'end_turn' }),
    ]);
    await askBrandAgent(
      { reader: reader(), model },
      {
        ...scope,
        question: 'And at 260?',
        history: [
          { role: 'assistant', text: 'dropped: a thread cannot start with the agent' },
          { role: 'user', text: 'What if I clear 300?' },
          { role: 'assistant', text: 'Cutoff $199.' },
        ],
      },
    );
    const req = model.requests[0]!;
    expect(req.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(req.messages[0]!.content[0]).toEqual({ type: 'text', text: 'What if I clear 300?' });
    expect(req.messages[3]!.content.map((b) => (b as { name: string }).name)).toEqual([
      'get_recommendation',
      'get_book_summary',
    ]);
    const summary = JSON.parse((req.messages[4]!.content[1] as { content: string }).content);
    expect(summary).toMatchObject({
      quantity: 300,
      floorCents: 18_000,
      publicLowCents: 27_900,
      liveBids: 300,
    });
    expect(summary.heldBySource.map((s: { source: string }) => s.source).sort()).toEqual([
      'BUYER_AGENT',
      'OFFER_PAGE',
      'SIM',
    ]);
    expect(req.tools.map((t) => t.name)).toContain('add_console_widget');
  });
});

// --- Widget -----------------------------------------------------------------------------------

describe('add_console_widget', () => {
  it('returns one UI action for the browser; nothing runs on the server', async () => {
    const r = reader();
    const model = scripted([
      toolCall('w1', 'add_console_widget', { kind: 'held_by_source' }),
      () => ({
        content: [{ type: 'text', text: 'Added "Held $ by source" to your dashboard.' }],
        stop_reason: 'end_turn',
      }),
    ]);
    const res = await askBrandAgent(
      { reader: r, model },
      { ...scope, question: 'Show me held dollars by source as a chart' },
    );
    expect(res.widgets).toEqual([{ kind: 'held_by_source' }]);
    expect(res.answer).toContain('Held $ by source');
    expect(r.simulated).toEqual([]);
  });

  it('rejects an unknown kind and a second widget', async () => {
    const model = scripted([
      () => ({
        content: [
          {
            type: 'tool_use',
            id: 'a',
            name: 'add_console_widget',
            input: { kind: 'pie_of_floor' },
          },
          {
            type: 'tool_use',
            id: 'b',
            name: 'add_console_widget',
            input: { kind: 'bids_by_price' },
          },
          {
            type: 'tool_use',
            id: 'c',
            name: 'add_console_widget',
            input: { kind: 'held_by_source' },
          },
        ],
        stop_reason: 'tool_use',
      }),
      () => ({ content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' }),
    ]);
    const res = await askBrandAgent({ reader: reader(), model }, { ...scope, question: 'charts' });
    expect(res.widgets).toEqual([{ kind: 'bids_by_price' }]);
    expect(res.steps.slice(-3).map((s) => s.ok)).toEqual([false, true, false]);
  });
});

// --- Fallbacks --------------------------------------------------------------------------------

describe('Claude down or slow: the card still renders', () => {
  it('times out at the budget and returns the code recommendation without prose', async () => {
    const hang: AgentModel = () => new Promise(() => {});
    const t0 = Date.now();
    const res = await askBrandAgent(
      { reader: reader(), model: hang, timeoutMs: 50 },
      { ...scope, question: 'All 300?' },
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res).toMatchObject({ answer: null, available: false, widgets: [] });
    expect(res.recommendation).toMatchObject({ quantity: 240, cutoffCents: 21_900 });
  });

  it('an API error gives the same fallback', async () => {
    const down: AgentModel = async () => {
      throw new Error('anthropic messages 529');
    };
    const res = await askBrandAgent({ reader: reader(), model: down }, scope);
    expect(res).toMatchObject({ answer: null, available: false });
    expect(res.recommendation?.quantity).toBe(240);
  });

  it('no API key: no model call, same fallback', async () => {
    const res = await askBrandAgent({ reader: reader(), model: null }, scope);
    expect(res).toMatchObject({ answer: null, available: false, steps: [] });
  });

  it('explain mode with no demand makes no model call', async () => {
    const model = scripted([]);
    const empty = bookFor({ kind: 'NO_DEMAND', minCutoffCents: 21_762 }, []);
    const res = await askBrandAgent({ reader: reader(empty), model }, scope);
    expect(model.requests).toEqual([]);
    expect(res).toMatchObject({ answer: null, available: true, recommendation: null });
  });

  it('explain mode asks for prose without the widget tool', async () => {
    const model = scripted([
      () => ({
        content: [{ type: 'text', text: 'Clear 240 at a $219 cutoff.' }],
        stop_reason: 'end_turn',
      }),
    ]);
    const res = await askBrandAgent({ reader: reader(), model }, scope);
    expect(res.answer).toBe('Clear 240 at a $219 cutoff.');
    expect(res.unverifiedNumbers).toEqual([]);
    expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain('add_console_widget');
  });
});

// --- Grounding --------------------------------------------------------------------------------

describe('ungroundedNumbers', () => {
  const results = [
    {
      quantity: 240,
      cutoffCents: 21_900,
      grossCents: 5_420_000,
      feeBps: 900,
      recoveryMultiple: 5.8,
    },
    { windowClosesAt: '2026-11-13T18:00:00.000Z' },
  ];
  it.each([
    ['Clear 240 at $219 for $54,200 gross.', []],
    ['$54.2k gross, ×5.8 liquidation, a 9% fee.', []],
    ['That is 5.8x what liquidation pays.', []],
    ['Top 3 bands. Aurel A7 closes Nov 13.', []],
    ['Clear 250 for $54.9k.', ['250', '$54.9k']],
    ['A 12% fee.', ['12%']],
  ])('case %#', (text, expected) => {
    expect(ungroundedNumbers(text, results)).toEqual(expected);
  });
});
