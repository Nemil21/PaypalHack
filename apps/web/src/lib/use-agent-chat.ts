import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError, api, newIdempotencyKey } from './api';
import {
  chatErrorMessage,
  chatReducer,
  createFrameParser,
  initialChat,
  threadFromHistory,
  type AgentEvent,
  type HistoryMessage,
} from './agent-chat';
import { FIXTURE_EVENTS } from './agent-chat.fixture';

/** The open conversation survives a reload on this device. */
export const CONVERSATION_KEY = 'holdfast.agent.conversationId';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** One turn's events, from the server or the recorded fixture. */
type Transport = (
  body: { conversationId: string | null; message: string },
  signal: AbortSignal,
  onEvent: (e: AgentEvent) => void,
) => Promise<{ conversationId: string | null }>;

/**
 * `POST /api/agent/chat` read with fetch + ReadableStream (it is a POST, so not `EventSource`).
 * HTTP errors before the stream throw `ApiError`; a stream cut mid-turn throws too.
 */
const serverTransport: Transport = async (body, signal, onEvent) => {
  let res: Response;
  try {
    res = await fetch('/api/agent/chat', {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        // Required on every mutating call; a turn is not replayable, so each send is a new key.
        'Idempotency-Key': newIdempotencyKey(),
      },
      body: JSON.stringify(body.conversationId ? body : { message: body.message }),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'We could not reach Holdfast. Check your connection.');
  }
  if (!res.ok || !res.body) {
    let env: Record<string, unknown> = {};
    try {
      env = ((await res.json()) as { error?: Record<string, unknown> }).error ?? {};
    } catch {
      /* not JSON */
    }
    throw new ApiError(
      res.status,
      typeof env.code === 'string' ? env.code : `HTTP_${res.status}`,
      typeof env.message === 'string' ? env.message : res.statusText,
    );
  }
  const conversationId = res.headers.get('x-conversation-id');
  const parser = createFrameParser();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let sawDone = false;
  for (;;) {
    const { value, done } = await reader.read();
    const events = done ? parser.flush() : parser.push(value);
    for (const e of events) {
      if (e.type === 'done') sawDone = true;
      onEvent(e);
    }
    if (done) break;
  }
  if (!sawDone) throw new ApiError(0, 'STREAM_CUT', 'The answer was cut off.');
  return { conversationId };
};

/** `/agent?fixture=1`: replays the recorded turn with a little pacing, no API or key needed. */
const fixtureTransport: Transport = async (_body, signal, onEvent) => {
  for (const e of FIXTURE_EVENTS) {
    await new Promise((r) => setTimeout(r, e.type === 'tool_call' ? 450 : 250));
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    // A recorded card expires 10 minutes after the replay, like a live one (ACTION_TTL_MS).
    onEvent(
      e.type === 'confirm_required'
        ? { ...e, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
        : e,
    );
  }
  return { conversationId: null };
};

export function useAgentChat({
  fixture,
  onTurnEnd,
}: {
  fixture: boolean;
  /** After each turn (the side panel refreshes live bids). */
  onTurnEnd?: () => void;
}) {
  const [state, dispatch] = useReducer(chatReducer, undefined, () => initialChat());
  const abort = useRef<AbortController | null>(null);
  const convId = useRef<string | null>(null);
  convId.current = state.conversationId;
  const [meta, setMeta] = useReducer(
    (m: { loadingHistory: boolean; signedOut: boolean }, n: Partial<typeof m>) => ({ ...m, ...n }),
    { loadingHistory: !fixture, signedOut: false },
  );
  const onTurnEndRef = useRef(onTurnEnd);
  onTurnEndRef.current = onTurnEnd;

  // Reload: the stored conversation, if it is still this shopper's.
  useEffect(() => {
    if (fixture) return;
    const stored = storage()?.getItem(CONVERSATION_KEY);
    if (!stored) {
      setMeta({ loadingHistory: false });
      return;
    }
    const ctrl = new AbortController();
    api
      .request<{ conversationId: string; messages: HistoryMessage[] }>({
        method: 'GET',
        path: `/api/agent/conversations/${encodeURIComponent(stored)}`,
        signal: ctrl.signal,
      })
      .then((h) => {
        dispatch({ type: 'hydrate', state: threadFromHistory(h.conversationId, h.messages) });
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // 404 (another shopper, or gone) or 401: start fresh.
        storage()?.removeItem(CONVERSATION_KEY);
        if (err instanceof ApiError && err.status === 401) setMeta({ signedOut: true });
      })
      .finally(() => setMeta({ loadingHistory: false }));
    return () => ctrl.abort();
  }, [fixture]);

  useEffect(() => () => abort.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || abort.current) return;
      const ctrl = new AbortController();
      abort.current = ctrl;
      dispatch({ type: 'send', text: message });
      try {
        const res = await (fixture ? fixtureTransport : serverTransport)(
          { conversationId: convId.current, message },
          ctrl.signal,
          (event) => {
            dispatch({ type: 'event', event });
            if (event.type === 'done' && !fixture && event.conversationId) {
              storage()?.setItem(CONVERSATION_KEY, event.conversationId);
            }
          },
        );
        if (res.conversationId && !fixture)
          storage()?.setItem(CONVERSATION_KEY, res.conversationId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const e = err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', '');
        if (e.status === 401) setMeta({ signedOut: true });
        if (e.status === 404) {
          // The stored conversation is not ours any more: the next message starts a new one.
          storage()?.removeItem(CONVERSATION_KEY);
          dispatch({ type: 'forget_conversation' });
        }
        dispatch({
          type: 'failed',
          message: chatErrorMessage(e.status, e.code, e.message),
          fallbackUrl: null,
        });
      } finally {
        abort.current = null;
        onTurnEndRef.current?.();
      }
    },
    [fixture],
  );

  const newChat = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    storage()?.removeItem(CONVERSATION_KEY);
    dispatch({ type: 'reset' });
  }, []);

  return { state, dispatch, send, newChat, ...meta };
}
