import { formatUsd } from '@holdfast/shared';

/**
 * W16 / M05 buyer agent chat logic (HF-041; screens.md §W16, §M05; features/04 §Logic 2) with no
 * React in it, so it is unit-tested against the recorded stream fixture.
 *
 * The server (HF-039, `POST /api/agent/chat`) answers a `text/event-stream` read with fetch +
 * ReadableStream: one `data: <AgentEvent JSON>` frame per event, ending with `done`. The reducer
 * turns those events into thread items: shopper and agent text, tool-call chips, product cards
 * and confirm cards. Numbers on a confirm card come from the `confirm_required` event, which the
 * server builds from the stored pending action, never from the model's prose (B10).
 */

// ---------------------------------------------------------------------------------------------
// Wire types (packages/core/src/agent/loop.ts `AgentEvent`, tools.ts `ConfirmRequired`)
// ---------------------------------------------------------------------------------------------

export type MoneyTool = 'place_bid' | 'raise_bid' | 'cancel_bid' | 'move_bid' | 'create_intent';

export interface ConfirmRequired {
  actionId: string;
  tool: MoneyTool;
  amountCents: number | null;
  amountFormatted: string | null;
  product: { title: string | null; imageUrl: string | null } | null;
  listing: { id: string; slug: string | null; brandName: string | null } | null;
  bids?: Array<{ bidId: string; amountCents: number; title: string | null }>;
  /** `create_intent` (HF-052): the want and its products; `amountCents` is the max per item. */
  intent?: {
    intentId: string;
    text: string | null;
    products: Array<{ productId: string; title: string | null }>;
  };
  /** `move_bid`: the bid being moved. */
  from?: { bidId: string; amountCents: number; title: string | null; listingId: string };
  /** `INLINE`: approve in chat (vaulted card). `OFFER_PAGE`: continue on W12 at `offerUrl`. */
  confirmMode: 'INLINE' | 'OFFER_PAGE';
  offerUrl: string | null;
  /** Null when the card was rebuilt from history (the server still checks expiry on confirm). */
  expiresAt: string | null;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; result: unknown }
  | ({ type: 'confirm_required' } & ConfirmRequired)
  | { type: 'error'; code: string; message: string; fallbackUrl: string | null }
  | {
      type: 'done';
      conversationId: string;
      reason: 'end_turn' | 'confirm_required' | 'iteration_cap' | 'unavailable';
    };

/**
 * What `POST /api/agent/actions/:id/confirm` answered (place / raise / cancel). The server also
 * appends it to the conversation for every executed action, including failed ones, whose body is
 * the error envelope (`bidErrorResponse`: WINDOW_CLOSED, HOLD_FAILED, …).
 */
export interface ConfirmResultBody {
  error?: { code?: string; message?: string };
  bidId?: string;
  status?: string;
  amountCents?: number;
  previousAmountCents?: number;
  message?: string | null;
  cancelled?: Array<{ bidId: string; status: number; body: { message?: string } }>;
  /** `create_intent`: the intent that is now on, and what the move rule did first. */
  intentId?: string;
  why?: string | null;
}

// ---------------------------------------------------------------------------------------------
// SSE frame parser
// ---------------------------------------------------------------------------------------------

/**
 * Incremental `text/event-stream` parser: push decoded chunks as they arrive (a frame may be split
 * anywhere, even inside a JSON string); get back every complete event. Unknown or malformed frames
 * are skipped rather than breaking the thread.
 */
export function createFrameParser() {
  let buffer = '';
  const parseFrame = (frame: string): AgentEvent | null => {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return null;
    try {
      const event = JSON.parse(data) as AgentEvent;
      return event && typeof event === 'object' && typeof event.type === 'string' ? event : null;
    } catch {
      return null;
    }
  };
  const drain = (final: boolean): AgentEvent[] => {
    buffer = buffer.replace(/\r\n?/g, '\n');
    const frames = buffer.split('\n\n');
    buffer = final ? '' : (frames.pop() ?? '');
    return frames.map(parseFrame).filter((e): e is AgentEvent => e !== null);
  };
  return {
    push(chunk: string): AgentEvent[] {
      buffer += chunk;
      return drain(false);
    },
    /** End of stream: a last frame without the trailing blank line still counts. */
    flush(): AgentEvent[] {
      return drain(true);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Thread model
// ---------------------------------------------------------------------------------------------

export interface ToolChip {
  id: string;
  name: string;
  status: 'running' | 'ok' | 'error';
  /** "Checked 14 stores", "Suggested bid $229". */
  label: string;
}

export interface ProductCardView {
  key: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  channel3Id: string | null;
  /** Real Channel3 public low (D15), from the tool result. */
  publicPriceCents: number | null;
  publicMerchant: string | null;
  suggestedBidCents: number | null;
  /** W12 for this book, prefilled with the suggested bid; null when there is no open book. */
  offerHref: string | null;
  myBidCents: number | null;
}

export type ConfirmState =
  | { status: 'pending' }
  | { status: 'declined' }
  | { status: 'done'; result: ConfirmResultBody }
  | { status: 'expired'; message: string }
  /** Executed, but the bid service refused it: nothing was held (D14: never "sent"). */
  | { status: 'failed'; message: string }
  /** No saved payment method: the server sent us to the offer page (M24). */
  | { status: 'offer_page'; offerUrl: string | null };

export type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tools'; id: string; chips: ToolChip[] }
  | { kind: 'products'; id: string; products: ProductCardView[] }
  | { kind: 'confirm'; id: string; card: ConfirmRequired; state: ConfirmState }
  | { kind: 'error'; id: string; message: string; fallbackUrl: string | null };

export type ChatPhase = 'idle' | 'thinking';

export interface ChatState {
  conversationId: string | null;
  items: ThreadItem[];
  phase: ChatPhase;
  /** Running counter for item ids (stable React keys). */
  seq: number;
}

export const initialChat = (conversationId: string | null = null): ChatState => ({
  conversationId,
  items: [],
  phase: 'idle',
  seq: 0,
});

export type ChatAction =
  | { type: 'send'; text: string }
  | { type: 'event'; event: AgentEvent }
  /** The request failed before or during the stream (HTTP error, network). */
  | { type: 'failed'; message: string; fallbackUrl: string | null }
  | { type: 'confirmed'; actionId: string; result: ConfirmResultBody }
  | { type: 'declined'; actionId: string }
  | { type: 'expired'; actionId: string; message: string }
  /** The confirm answered a terminal error: replays the same error, so Approve stays off. */
  | { type: 'action_failed'; actionId: string; message: string }
  | { type: 'offer_page'; actionId: string; offerUrl: string | null }
  /** The thread rebuilt from history (`threadFromHistory`). */
  | { type: 'hydrate'; state: ChatState }
  /** The server no longer knows this conversation: the next message starts a new one. */
  | { type: 'forget_conversation' }
  | { type: 'reset' };

export const MAX_PRODUCT_CARDS = 3;

/** Where "bid directly" goes when the server did not name a listing (agent unavailable). */
export const AGENT_UNAVAILABLE_COPY = 'Agent is unavailable; you can still bid directly.';

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send':
      return push({ ...state, phase: 'thinking' }, (id) => ({
        kind: 'user',
        id,
        text: action.text,
      }));
    case 'event':
      return applyEvent(state, action.event);
    case 'failed':
      return push({ ...state, phase: 'idle' }, (id) => ({
        kind: 'error',
        id,
        message: action.message,
        fallbackUrl: action.fallbackUrl,
      }));
    case 'confirmed': {
      const card = state.items.find(
        (it): it is Extract<ThreadItem, { kind: 'confirm' }> =>
          it.kind === 'confirm' && it.card.actionId === action.actionId,
      )?.card;
      const failed = card ? failureOf(card, action.result) : null;
      return setConfirm(
        state,
        action.actionId,
        failed ? { status: 'failed', message: failed } : { status: 'done', result: action.result },
      );
    }
    case 'action_failed':
      return setConfirm(state, action.actionId, { status: 'failed', message: action.message });
    case 'declined':
      return setConfirm(state, action.actionId, { status: 'declined' });
    case 'expired':
      return setConfirm(state, action.actionId, { status: 'expired', message: action.message });
    case 'offer_page':
      return setConfirm(state, action.actionId, {
        status: 'offer_page',
        offerUrl: action.offerUrl,
      });
    case 'hydrate':
      return action.state;
    case 'forget_conversation':
      return { ...state, conversationId: null };
    case 'reset':
      return initialChat();
  }
}

function push(state: ChatState, make: (id: string) => ThreadItem): ChatState {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, make(`i${seq}`)] };
}

function setConfirm(state: ChatState, actionId: string, next: ConfirmState): ChatState {
  return {
    ...state,
    items: state.items.map((it) =>
      it.kind === 'confirm' && it.card.actionId === actionId ? { ...it, state: next } : it,
    ),
  };
}

function applyEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case 'text':
      return event.text ? push(state, (id) => ({ kind: 'text', id, text: event.text })) : state;
    case 'tool_call': {
      const chip: ToolChip = {
        id: event.id,
        name: event.name,
        status: 'running',
        label: runningLabel(event.name),
      };
      // Consecutive calls share one chip row ("Checked 14 stores · Suggested bid $229"), also
      // across the product card the first call produced.
      const n = state.items.length;
      const at =
        state.items[n - 1]?.kind === 'tools'
          ? n - 1
          : state.items[n - 1]?.kind === 'products' && state.items[n - 2]?.kind === 'tools'
            ? n - 2
            : -1;
      if (at >= 0) {
        const row = state.items[at] as Extract<ThreadItem, { kind: 'tools' }>;
        const items = [...state.items];
        items[at] = { ...row, chips: [...row.chips, chip] };
        return { ...state, items };
      }
      return push(state, (id) => ({ kind: 'tools', id, chips: [chip] }));
    }
    case 'tool_result': {
      const items = state.items.map((it) =>
        it.kind === 'tools' && it.chips.some((c) => c.id === event.id)
          ? {
              ...it,
              chips: it.chips.map((c) =>
                c.id === event.id
                  ? {
                      ...c,
                      status: event.ok ? ('ok' as const) : ('error' as const),
                      label: resultLabel(event.name, event.ok, event.result),
                    }
                  : c,
              ),
            }
          : it,
      );
      const next = { ...state, items };
      return event.ok ? addProducts(next, event.name, event.result) : next;
    }
    case 'confirm_required': {
      const { type: _type, ...card } = event;
      // A retried tool call maps to the same action id: never show a second card for it.
      if (state.items.some((it) => it.kind === 'confirm' && it.card.actionId === card.actionId)) {
        return state;
      }
      return push(state, (id) => ({ kind: 'confirm', id, card, state: { status: 'pending' } }));
    }
    case 'error':
      return push(state, (id) => ({
        kind: 'error',
        id,
        message: event.message || AGENT_UNAVAILABLE_COPY,
        fallbackUrl: event.fallbackUrl,
      }));
    case 'done':
      return {
        ...state,
        phase: 'idle',
        conversationId: event.conversationId || state.conversationId,
        // A chip still "running" when the turn ended never got its result.
        items: state.items.map((it) =>
          it.kind === 'tools' && it.chips.some((c) => c.status === 'running')
            ? {
                ...it,
                chips: it.chips.map((c) =>
                  c.status === 'running' ? { ...c, status: 'error' as const } : c,
                ),
              }
            : it,
        ),
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Tool chips
// ---------------------------------------------------------------------------------------------

const RUNNING: Record<string, string> = {
  search_open_books: 'Searching open books',
  lookup_product: 'Comparing store prices',
  suggest_bid: 'Working out a bid',
  place_bid: 'Preparing a proposal',
  raise_bid: 'Preparing a raise',
  cancel_bid: 'Preparing a cancel',
  move_bid: 'Preparing a move',
  create_intent: 'Setting up your intent',
  my_intents: 'Checking your intents',
  my_bids: 'Checking your bids',
};

const FAILED: Record<string, string> = {
  search_open_books: 'Search failed',
  lookup_product: 'Price lookup failed',
  suggest_bid: 'No suggestion',
  place_bid: 'Couldn’t propose that bid',
  raise_bid: 'Couldn’t propose that raise',
  cancel_bid: 'Couldn’t propose that cancel',
  move_bid: 'Couldn’t propose that move',
  create_intent: 'Couldn’t set up that intent',
  my_intents: 'Couldn’t load your intents',
  my_bids: 'Couldn’t load your bids',
};

export function runningLabel(name: string): string {
  return `${RUNNING[name] ?? 'Working'}…`;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Chip text once the tool answered; every number comes from the tool result. */
export function resultLabel(name: string, ok: boolean, result: unknown): string {
  const r = obj(result);
  if (!ok) {
    const code = str(obj(r.error).code);
    if (code === 'ALREADY_BID') return 'You already have a bid there';
    if (code === 'WINDOW_CLOSED') return 'That book is closed';
    if (code === 'ABOVE_MANDATE_MAX') return 'Above your mandate max';
    return FAILED[name] ?? 'A check failed';
  }
  switch (name) {
    case 'search_open_books': {
      const market = r.publicMarket;
      const books = arr(r.listings).length;
      if (!Array.isArray(market)) return `Searched ${plural(books, 'open book')}`;
      const stores = market.reduce<number>((s, m) => s + (num(obj(m).offerCount) ?? 0), 0);
      return stores > 0
        ? `Checked ${plural(stores, 'store')}`
        : `Searched ${plural(books, 'open book')}`;
    }
    case 'lookup_product': {
      const offers = arr(r.offers).length;
      return offers ? `Compared ${plural(offers, 'store price')}` : 'Looked up the product';
    }
    case 'suggest_bid': {
      const cents = num(r.suggestedBidCents);
      return cents != null ? `Suggested bid ${formatUsd(cents)}` : 'No suggested bid';
    }
    case 'place_bid':
    case 'raise_bid':
    case 'cancel_bid':
    case 'move_bid':
    case 'create_intent':
      return 'Proposal ready to confirm';
    case 'my_intents':
      return `Checked ${plural(arr(r.intents).length, 'intent')}`;
    case 'my_bids':
      return `Checked ${plural(arr(r.bids).length, 'bid')}`;
    default:
      return 'Done';
  }
}

// ---------------------------------------------------------------------------------------------
// Product cards
// ---------------------------------------------------------------------------------------------

export function offerHrefFor(slug: string | null, amountCents: number | null): string | null {
  if (!slug) return null;
  const base = `/o/${encodeURIComponent(slug)}`;
  return amountCents != null ? `${base}?amount=${amountCents}&src=agent` : `${base}?src=agent`;
}

/** Cards from `search_open_books` (our open books) and `lookup_product` (image, public low). */
export function productsFromResult(name: string, result: unknown): ProductCardView[] {
  const r = obj(result);
  if (name === 'search_open_books') {
    return arr(r.listings)
      .map(obj)
      .slice(0, MAX_PRODUCT_CARDS)
      .map((l) => {
        const offer = obj(l.publicOffer);
        const suggested = num(l.suggestedBidCents);
        const slug = str(l.slug);
        return {
          key: str(l.listingId) ?? str(l.channel3Id) ?? JSON.stringify(l).slice(0, 40),
          title: str(l.productTitle) ?? 'Untitled product',
          brand: str(l.brand),
          imageUrl: null,
          channel3Id: str(l.channel3Id),
          publicPriceCents: num(offer.priceCents),
          publicMerchant: str(offer.merchant),
          suggestedBidCents: suggested,
          offerHref: l.biddable === false ? null : offerHrefFor(slug, suggested),
          myBidCents: num(obj(l.myBid).amountCents),
        };
      });
  }
  if (name === 'lookup_product') {
    const listing = obj(arr(r.openListings)[0]);
    return [
      {
        key: str(r.channel3Id) ?? 'product',
        title: str(r.title) ?? 'Untitled product',
        brand: str(r.brand),
        imageUrl: str(r.imageUrl),
        channel3Id: str(r.channel3Id),
        publicPriceCents: num(r.cheapestPublicPriceCents),
        publicMerchant: str(r.cheapestPublicMerchant),
        suggestedBidCents: null,
        offerHref: offerHrefFor(str(listing.slug), null),
        myBidCents: null,
      },
    ];
  }
  return [];
}

function addProducts(state: ChatState, name: string, result: unknown): ChatState {
  const found = productsFromResult(name, result);
  if (!found.length) return state;
  if (name === 'lookup_product') {
    // Enrich a card we already show (same Channel3 product) instead of repeating it.
    const p = found[0]!;
    let merged = false;
    const items = state.items.map((it) => {
      if (it.kind !== 'products') return it;
      const products = it.products.map((c) => {
        if (!p.channel3Id || c.channel3Id !== p.channel3Id) return c;
        merged = true;
        return { ...c, imageUrl: c.imageUrl ?? p.imageUrl };
      });
      return { ...it, products };
    });
    if (merged) return { ...state, items };
  }
  return push(state, (id) => ({ kind: 'products', id, products: found }));
}

// ---------------------------------------------------------------------------------------------
// Confirm card copy
// ---------------------------------------------------------------------------------------------

/** The card's headline amount: the stored action's, as the server formatted it. */
export function cardAmount(card: ConfirmRequired): string | null {
  if (card.amountFormatted) return card.amountFormatted;
  if (card.amountCents != null) return formatUsd(card.amountCents);
  if (card.tool === 'cancel_bid' && card.bids?.length) {
    return formatUsd(card.bids.reduce((s, b) => s + b.amountCents, 0));
  }
  return null;
}

export function cardTitle(card: ConfirmRequired): string {
  const amount = cardAmount(card) ?? '';
  switch (card.tool) {
    case 'place_bid':
      return `Bid ${amount}`;
    case 'raise_bid':
      return `Raise to ${amount}`;
    case 'cancel_bid': {
      const n = card.bids?.length ?? 1;
      return n === 1 ? 'Cancel this bid' : `Cancel ${n} bids`;
    }
    case 'move_bid':
      return `Move bid: ${amount}`;
    case 'create_intent':
      return `Bid up to ${amount}`;
  }
}

/** v4 confirm-card eyebrow (frame 120:687): what the shopper is approving, in words. */
export function cardEyebrow(card: Pick<ConfirmRequired, 'tool'>): string {
  switch (card.tool) {
    case 'place_bid':
      return 'Confirm · place a held bid';
    case 'raise_bid':
      return 'Confirm · raise your bid';
    case 'cancel_bid':
      return 'Confirm · cancel and release';
    case 'move_bid':
      return 'Confirm · move your bid';
    case 'create_intent':
      return 'Confirm · let your agent bid';
  }
}

/** Tile text for a product with no image: a model token ("A7"), else two initials. */
export function productInitials(title: string): string {
  const words = title.split(/[\s—–-]+/).filter(Boolean);
  const model = words.find((w) => /\d/.test(w) && w.length <= 4);
  if (model) return model.toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0]!)
    .join('')
    .toUpperCase();
}

export function cardWhere(card: ConfirmRequired): string | null {
  if (card.tool === 'create_intent') {
    const titles = (card.intent?.products ?? []).map((p) => p.title).filter(Boolean);
    return titles.length ? `on ${titles.join(' or ')}` : null;
  }
  const brand = card.listing?.brandName;
  return brand ? `in ${brand}’s book` : null;
}

/** Money copy (D14): a hold, not a charge; "released" only once it has landed. */
export function cardNote(card: ConfirmRequired): string {
  switch (card.tool) {
    case 'place_bid':
      return 'A PayPal hold, not a charge. You are only charged your bid if the brand fills it.';
    case 'raise_bid':
      return 'A new hold at the higher amount; the old hold is released once it lands.';
    case 'cancel_bid':
      return 'Your holds are released. Nothing is charged.';
    case 'move_bid':
      return 'A new hold in this book first; your old hold is released once it lands.';
    case 'create_intent':
      return 'One live bid at a time, never above this max. Holdfast moves it to the book most likely to clear. Nothing is held until you approve.';
  }
}

export function approveLabel(card: ConfirmRequired): string {
  switch (card.tool) {
    case 'place_bid':
      return 'Approve with PayPal';
    case 'raise_bid':
      return `Raise to ${cardAmount(card) ?? ''}`;
    case 'cancel_bid':
      return (card.bids?.length ?? 1) === 1 ? 'Cancel bid' : 'Cancel bids';
    case 'move_bid':
      return 'Move bid';
    case 'create_intent':
      return 'Approve intent';
  }
}

/** "Expires in 9 min"; null when unknown, "Expired" once past. */
export function expiryText(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'Expired';
  const min = Math.ceil(ms / 60_000);
  return `Expires in ${min} min`;
}

/** "That bid didn’t go through: <why>." for a refused place / raise / cancel. */
export function failedText(card: ConfirmRequired, why: string | null | undefined): string {
  const what =
    card.tool === 'raise_bid'
      ? 'raise'
      : card.tool === 'cancel_bid'
        ? 'cancel'
        : card.tool === 'move_bid'
          ? 'move'
          : card.tool === 'create_intent'
            ? 'intent'
            : 'bid';
  const reason = why?.trim().replace(/\.$/, '');
  return reason ? `That ${what} didn’t go through: ${reason}.` : `That ${what} didn’t go through.`;
}

/**
 * Null when the confirm answer is a real outcome; else the failure copy. An error envelope, a
 * place / raise without a bid, or a cancel without its per-bid list is not something we can call
 * held, sent or cancelled.
 */
export function failureOf(card: ConfirmRequired, result: ConfirmResultBody): string | null {
  if (result.error && typeof result.error === 'object') {
    return failedText(card, result.error.message ?? result.error.code);
  }
  if (card.tool === 'cancel_bid') {
    return Array.isArray(result.cancelled) ? null : failedText(card, result.message);
  }
  if (card.tool === 'create_intent') {
    return result.intentId ? null : failedText(card, result.message);
  }
  return result.bidId && result.status ? null : failedText(card, result.message);
}

/** What the "action done" state says, from the confirm endpoint's answer (never the model's). */
export function doneText(card: ConfirmRequired, result: ConfirmResultBody): string {
  if (card.tool === 'cancel_bid') {
    const list = result.cancelled ?? [];
    const ok = list.filter((c) => c.status < 400).length;
    if (!list.length) return result.message ?? 'Cancel requested.';
    return ok === list.length
      ? `${plural(ok, 'bid')} cancelled. Holds are released once PayPal confirms.`
      : `${ok} of ${list.length} bids cancelled. Check My bids for the rest.`;
  }
  if (card.tool === 'create_intent') return result.message ?? 'Your intent is on.';
  const amount = result.amountCents != null ? formatUsd(result.amountCents) : cardAmount(card);
  if (result.status === 'HELD') {
    if (card.tool === 'raise_bid') return `Raised. ${amount} is held, not charged.`;
    if (card.tool === 'move_bid') return `Moved. ${amount} is held, not charged.`;
    return `${amount} held, not charged.`;
  }
  if (result.status === 'PENDING_APPROVAL') return `${amount} is waiting for PayPal approval.`;
  return result.message ?? `Bid ${amount}: ${(result.status ?? '').toLowerCase()}.`;
}

// ---------------------------------------------------------------------------------------------
// History (`GET /api/agent/conversations/:id`)
// ---------------------------------------------------------------------------------------------

export interface HistoryBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface HistoryMessage {
  seq: number;
  role: 'user' | 'assistant';
  content: HistoryBlock[];
}

const SERVER_CONFIRM =
  /^\[Holdfast server\] The shopper confirmed action ([0-9a-f-]{36}) \((\w+)\)\. Result: ([\s\S]*)$/;

/**
 * Rebuild the thread after a reload. History is replayed through the same reducer as the live
 * stream; a money tool's card is rebuilt from its stored tool result (the action id and amount the
 * server stored) plus the listing the agent found earlier in the conversation. A later
 * "[Holdfast server] The shopper confirmed action …" message marks that card done.
 */
export function threadFromHistory(conversationId: string, messages: HistoryMessage[]): ChatState {
  let state = initialChat(conversationId);
  const calls = new Map<string, { name: string; input: Json }>();
  const listings = new Map<
    string,
    { slug: string | null; brand: string | null; title: string | null }
  >();

  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    for (const b of m.content) {
      if (b.type === 'text' && typeof b.text === 'string') {
        if (m.role === 'assistant') {
          state = chatReducer(state, { type: 'event', event: { type: 'text', text: b.text } });
          continue;
        }
        const server = SERVER_CONFIRM.exec(b.text);
        if (server) {
          let result: ConfirmResultBody = {};
          try {
            result = JSON.parse(server[3]!) as ConfirmResultBody;
          } catch {
            /* keep the card, without numbers */
          }
          state = chatReducer(state, { type: 'confirmed', actionId: server[1]!, result });
          continue;
        }
        if (b.text.startsWith('[Holdfast server]')) continue;
        state = chatReducer(state, { type: 'send', text: b.text });
        continue;
      }
      if (b.type === 'tool_use' && b.id && b.name) {
        calls.set(b.id, { name: b.name, input: obj(b.input) });
        state = chatReducer(state, {
          type: 'event',
          event: { type: 'tool_call', id: b.id, name: b.name, input: b.input },
        });
        continue;
      }
      if (b.type === 'tool_result' && b.tool_use_id) {
        const call = calls.get(b.tool_use_id);
        const name = call?.name ?? 'tool';
        let result: unknown = b.content;
        if (typeof b.content === 'string') {
          try {
            result = JSON.parse(b.content);
          } catch {
            result = {};
          }
        }
        for (const l of [...arr(obj(result).listings), result].map(obj)) {
          const id = str(l.listingId);
          if (id) {
            listings.set(id, {
              slug: str(l.slug),
              brand: str(l.brand),
              title: str(l.productTitle),
            });
          }
        }
        state = chatReducer(state, {
          type: 'event',
          event: { type: 'tool_result', id: b.tool_use_id, name, ok: !b.is_error, result },
        });
        const r = obj(result);
        if (!b.is_error && r.confirmRequired === true && str(r.actionId) && call) {
          state = chatReducer(state, {
            type: 'event',
            event: { type: 'confirm_required', ...rebuiltCard(call, r, listings) },
          });
        }
      }
    }
  }
  // Cards confirmed later in history were marked as they appeared; nothing is "thinking" now.
  return { ...state, phase: 'idle' };
}

function rebuiltCard(
  call: { name: string; input: Json },
  r: Json,
  listings: Map<string, { slug: string | null; brand: string | null; title: string | null }>,
): ConfirmRequired {
  const tool =
    (['place_bid', 'raise_bid', 'cancel_bid', 'move_bid', 'create_intent'] as const).find(
      (t) => t === call.name,
    ) ?? 'place_bid';
  const listingId = str(call.input.listingId) ?? str(call.input.toListingId);
  const l = listingId ? listings.get(listingId) : undefined;
  const amountCents = num(r.amountCents);
  return {
    actionId: str(r.actionId)!,
    tool,
    amountCents,
    amountFormatted: amountCents != null ? formatUsd(amountCents) : null,
    product: l ? { title: l.title, imageUrl: null } : null,
    listing: listingId
      ? { id: listingId, slug: l?.slug ?? null, brandName: l?.brand ?? null }
      : null,
    // The confirm endpoint answers NEEDS_PAYMENT_METHOD with the offer link when there's no vault.
    confirmMode: 'INLINE',
    offerUrl: null,
    expiresAt: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

/** The newest confirm card still waiting for the shopper: the one shown as a sheet on phones. */
export function activeConfirmId(items: ThreadItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'confirm') return it.state.status === 'pending' ? it.card.actionId : null;
  }
  return null;
}

export const SUGGESTED_PROMPTS = [
  'Aurel headphones under $230',
  'What bids do I have live?',
  'Is my bid likely to clear?',
  'Find me a good price on wireless earbuds',
] as const;

/** Copy for an HTTP error from `POST /api/agent/chat` before any stream. */
export function chatErrorMessage(status: number, code: string, message: string): string {
  if (status === 429) return 'You’re sending messages quickly. Wait a few seconds and try again.';
  if (code === 'IN_PROGRESS') return 'The agent is still answering your last message.';
  if (status === 0 || status >= 500) return AGENT_UNAVAILABLE_COPY;
  return message || AGENT_UNAVAILABLE_COPY;
}
