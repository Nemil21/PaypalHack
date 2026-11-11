import { describe, expect, it } from 'vitest';
import {
  activeConfirmId,
  cardTitle,
  chatReducer,
  createFrameParser,
  doneText,
  expiryText,
  failureOf,
  initialChat,
  resultLabel,
  threadFromHistory,
  type AgentEvent,
  type ChatState,
  type HistoryMessage,
  type ThreadItem,
} from './agent-chat';
import {
  FIXTURE_ACTION_ID,
  FIXTURE_CONFIRM_RESULT,
  FIXTURE_CONVERSATION_ID,
  FIXTURE_EVENTS,
  FIXTURE_LISTING_ID,
  FIXTURE_PROMPT,
  RECORDED_STREAM,
} from './agent-chat.fixture';

const play = (events: AgentEvent[], from: ChatState = initialChat()): ChatState =>
  events.reduce(
    (s, event) => chatReducer(s, { type: 'event', event }),
    chatReducer(from, { type: 'send', text: FIXTURE_PROMPT }),
  );

const confirmItem = (s: ChatState) =>
  s.items.find((i): i is Extract<ThreadItem, { kind: 'confirm' }> => i.kind === 'confirm')!;

describe('SSE frame parser', () => {
  it('parses the recorded stream however it is chunked', () => {
    for (const size of [1, 7, 64, RECORDED_STREAM.length]) {
      const p = createFrameParser();
      const out: AgentEvent[] = [];
      for (let i = 0; i < RECORDED_STREAM.length; i += size) {
        out.push(...p.push(RECORDED_STREAM.slice(i, i + size)));
      }
      out.push(...p.flush());
      expect(out).toEqual(FIXTURE_EVENTS);
    }
  });

  it('handles CRLF, a missing final blank line and junk frames', () => {
    const p = createFrameParser();
    const a = p.push(
      ': keep-alive\r\n\r\ndata: {"type":"text","text":"hi"}\r\n\r\ndata: not json\n\n',
    );
    const b = p.push('data: {"type":"done","conversationId":"c","reason":"end_turn"}');
    expect(a).toEqual([{ type: 'text', text: 'hi' }]);
    expect(b).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'done', conversationId: 'c', reason: 'end_turn' }]);
  });
});

describe('chat reducer on the recorded stream', () => {
  it('builds user → chips → product card → text → confirm card, and ends idle', () => {
    const s = play(FIXTURE_EVENTS);
    expect(s.phase).toBe('idle');
    expect(s.conversationId).toBe(FIXTURE_CONVERSATION_ID);
    expect(s.items.map((i) => i.kind)).toEqual([
      'user',
      'tools',
      'products',
      'text',
      'tools',
      'confirm',
    ]);
    const chips = s.items[1] as Extract<ThreadItem, { kind: 'tools' }>;
    // Real Channel3 offer counts: 9 + 5 stores.
    expect(chips.chips.map((c) => [c.status, c.label])).toEqual([
      ['ok', 'Checked 14 stores'],
      ['ok', 'Suggested bid $229'],
    ]);
    const products = s.items[2] as Extract<ThreadItem, { kind: 'products' }>;
    expect(products.products[0]).toMatchObject({
      title: 'Aurel A7 Wireless Noise Cancelling Headphones',
      brand: 'Aurel Audio',
      publicPriceCents: 27_900,
      publicMerchant: 'bestbuy.com',
      suggestedBidCents: 22_900,
      offerHref: '/o/aurel-a7?amount=22900&src=agent',
    });
    expect(activeConfirmId(s.items)).toBe(FIXTURE_ACTION_ID);
  });

  it('is thinking between send and done, with running chips', () => {
    let s = chatReducer(initialChat(), { type: 'send', text: 'hi' });
    expect(s.phase).toBe('thinking');
    s = chatReducer(s, { type: 'event', event: FIXTURE_EVENTS[0]! });
    const chips = s.items[1] as Extract<ThreadItem, { kind: 'tools' }>;
    expect(chips.chips[0]).toMatchObject({ status: 'running', label: 'Searching open books…' });
    // The turn ends without that result: the chip stops spinning.
    s = chatReducer(s, {
      type: 'event',
      event: { type: 'done', conversationId: 'c1', reason: 'unavailable' },
    });
    expect((s.items[1] as Extract<ThreadItem, { kind: 'tools' }>).chips[0]!.status).toBe('error');
    expect(s.phase).toBe('idle');
  });

  it('card numbers come from confirm_required, not the model prose', () => {
    // The model says something else entirely; the card still shows the stored action.
    const lying = FIXTURE_EVENTS.map((e) =>
      e.type === 'text' ? { ...e, text: 'Confirmed! I placed your bid at $500.' } : e,
    );
    const card = confirmItem(play(lying)).card;
    expect(card).toMatchObject({
      actionId: FIXTURE_ACTION_ID,
      amountCents: 22_900,
      amountFormatted: '$229',
      listing: { id: FIXTURE_LISTING_ID, brandName: 'Aurel Audio' },
    });
    expect(cardTitle(card)).toBe('Bid $229');
  });

  it('a retried tool call (same action id) never shows a second card', () => {
    const confirm = FIXTURE_EVENTS.find((e) => e.type === 'confirm_required')!;
    const s = play([...FIXTURE_EVENTS, confirm]);
    expect(s.items.filter((i) => i.kind === 'confirm')).toHaveLength(1);
  });

  it('confirm → done uses the confirm endpoint answer', () => {
    let s = play(FIXTURE_EVENTS);
    s = chatReducer(s, {
      type: 'confirmed',
      actionId: FIXTURE_ACTION_ID,
      result: FIXTURE_CONFIRM_RESULT,
    });
    const item = confirmItem(s);
    expect(item.state).toEqual({ status: 'done', result: FIXTURE_CONFIRM_RESULT });
    expect(doneText(item.card, FIXTURE_CONFIRM_RESULT)).toBe('$229 held, not charged.');
    expect(activeConfirmId(s.items)).toBeNull();
  });

  it('a confirm answer that is an error envelope is a failed card, never "sent"', () => {
    let s = play(FIXTURE_EVENTS);
    s = chatReducer(s, {
      type: 'confirmed',
      actionId: FIXTURE_ACTION_ID,
      result: { error: { code: 'WINDOW_CLOSED', message: 'This book closed.' } },
    });
    expect(confirmItem(s).state).toEqual({
      status: 'failed',
      message: 'That bid didn’t go through: This book closed.',
    });
    expect(activeConfirmId(s.items)).toBeNull();
    // The live path: a terminal 4xx from confirm.
    s = chatReducer(play(FIXTURE_EVENTS), {
      type: 'action_failed',
      actionId: FIXTURE_ACTION_ID,
      message: 'That bid didn’t go through: The hold failed.',
    });
    expect(confirmItem(s).state.status).toBe('failed');
  });

  it('failureOf: only real outcomes count as done', () => {
    const card = confirmItem(play(FIXTURE_EVENTS)).card;
    expect(failureOf(card, FIXTURE_CONFIRM_RESULT)).toBeNull();
    expect(failureOf(card, {})).toBe('That bid didn’t go through.');
    expect(failureOf(card, { error: { code: 'HOLD_FAILED' } })).toBe(
      'That bid didn’t go through: HOLD_FAILED.',
    );
    const cancel = { ...card, tool: 'cancel_bid' as const };
    expect(failureOf(cancel, { cancelled: [] })).toBeNull();
    expect(failureOf(cancel, { status: 'HELD', bidId: 'x' })).toBe(
      'That cancel didn’t go through.',
    );
  });

  it('decline, expiry and the no-vault offer page are card states', () => {
    const s = play(FIXTURE_EVENTS);
    expect(
      confirmItem(chatReducer(s, { type: 'declined', actionId: FIXTURE_ACTION_ID })).state,
    ).toEqual({ status: 'declined' });
    expect(
      confirmItem(
        chatReducer(s, {
          type: 'offer_page',
          actionId: FIXTURE_ACTION_ID,
          offerUrl: '/o/aurel-a7?amount=22900&src=agent',
        }),
      ).state,
    ).toEqual({ status: 'offer_page', offerUrl: '/o/aurel-a7?amount=22900&src=agent' });
    expect(
      confirmItem(chatReducer(s, { type: 'expired', actionId: FIXTURE_ACTION_ID, message: 'x' }))
        .state.status,
    ).toBe('expired');
  });

  it('agent unavailable: error item with the W12 fallback', () => {
    const s = play([
      {
        type: 'error',
        code: 'AGENT_UNAVAILABLE',
        message: 'Agent is unavailable; you can still bid directly.',
        fallbackUrl: '/o/aurel-a7',
      },
      { type: 'done', conversationId: 'c', reason: 'unavailable' },
    ]);
    expect(s.items[1]).toMatchObject({
      kind: 'error',
      message: 'Agent is unavailable; you can still bid directly.',
      fallbackUrl: '/o/aurel-a7',
    });
    expect(s.phase).toBe('idle');
  });
});

describe('labels and copy', () => {
  it('chip labels from tool results', () => {
    expect(resultLabel('search_open_books', true, { listings: [{}], publicMarket: null })).toBe(
      'Searched 1 open book',
    );
    expect(resultLabel('lookup_product', true, { offers: [{}, {}] })).toBe(
      'Compared 2 store prices',
    );
    expect(resultLabel('my_bids', true, { bids: [{}] })).toBe('Checked 1 bid');
    expect(resultLabel('place_bid', false, { error: { code: 'ALREADY_BID' } })).toBe(
      'You already have a bid there',
    );
    expect(resultLabel('search_open_books', false, { error: { code: 'X' } })).toBe('Search failed');
  });

  it('expiry text', () => {
    const now = Date.parse('2026-11-11T10:00:00Z');
    expect(expiryText('2026-11-11T10:09:30Z', now)).toBe('Expires in 10 min');
    expect(expiryText('2026-11-11T09:59:00Z', now)).toBe('Expired');
    expect(expiryText(null, now)).toBeNull();
  });

  it('cancel and raise done copy', () => {
    const cancel = {
      ...(FIXTURE_EVENTS.find((e) => e.type === 'confirm_required') as Extract<
        AgentEvent,
        { type: 'confirm_required' }
      >),
      tool: 'cancel_bid' as const,
      bids: [
        { bidId: 'a', amountCents: 100, title: null },
        { bidId: 'b', amountCents: 200, title: null },
      ],
    };
    expect(cardTitle(cancel)).toBe('Cancel 2 bids');
    expect(
      doneText(cancel, {
        cancelled: [
          { bidId: 'a', status: 200, body: {} },
          { bidId: 'b', status: 200, body: {} },
        ],
      }),
    ).toBe('2 bids cancelled. Holds are released once PayPal confirms.');
    expect(
      doneText({ ...cancel, tool: 'raise_bid' }, { status: 'HELD', amountCents: 24_100 }),
    ).toBe('Raised. $241 is held, not charged.');
  });
});

describe('history rebuild', () => {
  const tu = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
  const tr = (id: string, result: unknown) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: JSON.stringify(result),
  });
  const search = FIXTURE_EVENTS[1] as Extract<AgentEvent, { type: 'tool_result' }>;
  const messages: HistoryMessage[] = [
    { seq: 1, role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] },
    { seq: 2, role: 'assistant', content: [tu('t1', 'search_open_books', { query: 'aurel' })] },
    { seq: 3, role: 'user', content: [tr('t1', search.result)] },
    {
      seq: 4,
      role: 'assistant',
      content: [
        { type: 'text', text: 'Bid $229?' },
        tu('t2', 'place_bid', { listingId: FIXTURE_LISTING_ID, amountCents: 22_900 }),
      ],
    },
    {
      seq: 5,
      role: 'user',
      content: [
        tr('t2', { confirmRequired: true, actionId: FIXTURE_ACTION_ID, amountCents: 22_900 }),
      ],
    },
  ];

  it('rebuilds chips, products and a pending card with the stored amount and listing', () => {
    const s = threadFromHistory(FIXTURE_CONVERSATION_ID, messages);
    expect(s.items.map((i) => i.kind)).toEqual([
      'user',
      'tools',
      'products',
      'text',
      'tools',
      'confirm',
    ]);
    const item = confirmItem(s);
    expect(item.state.status).toBe('pending');
    expect(item.card).toMatchObject({
      actionId: FIXTURE_ACTION_ID,
      tool: 'place_bid',
      amountCents: 22_900,
      amountFormatted: '$229',
      listing: { id: FIXTURE_LISTING_ID, slug: 'aurel-a7', brandName: 'Aurel Audio' },
      product: { title: 'Aurel A7 Wireless Noise Cancelling Headphones' },
    });
  });

  it('a server confirm message marks the card done and is not shown as the shopper', () => {
    const s = threadFromHistory(FIXTURE_CONVERSATION_ID, [
      ...messages,
      {
        seq: 6,
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[Holdfast server] The shopper confirmed action ${FIXTURE_ACTION_ID} (place_bid). Result: ${JSON.stringify(FIXTURE_CONFIRM_RESULT)}`,
          },
        ],
      },
    ]);
    expect(confirmItem(s).state).toEqual({ status: 'done', result: FIXTURE_CONFIRM_RESULT });
    expect(s.items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(s.phase).toBe('idle');
  });

  it('a server confirm note with an error body rebuilds as failed, not done', () => {
    const body = { error: { code: 'WINDOW_CLOSED', message: 'This book is not taking bids.' } };
    const s = threadFromHistory(FIXTURE_CONVERSATION_ID, [
      ...messages,
      {
        seq: 6,
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[Holdfast server] The shopper confirmed action ${FIXTURE_ACTION_ID} (place_bid). Result: ${JSON.stringify(body)}`,
          },
        ],
      },
    ]);
    expect(confirmItem(s).state).toEqual({
      status: 'failed',
      message: 'That bid didn’t go through: This book is not taking bids.',
    });
  });
});
