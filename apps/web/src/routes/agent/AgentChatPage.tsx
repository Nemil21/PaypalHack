import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatUsd } from '@holdfast/shared';
import { Badge, Button, ButtonLink, Skeleton } from '../../components/ui';
import {
  activeConfirmId,
  SUGGESTED_PROMPTS,
  type ProductCardView,
  type ThreadItem,
  type ToolChip,
} from '../../lib/agent-chat';
import { api } from '../../lib/api';
import { clientConfig } from '../../lib/client-config';
import { cn } from '../../lib/cn';
import { DEMO_OFFER_SLUG, paths } from '../../lib/routes';
import { useAgentChat } from '../../lib/use-agent-chat';
import { useApiAction } from '../../lib/use-api-action';
import { AgentSidePanel } from './AgentSidePanel';
import { ConfirmCard } from './ConfirmCard';

/**
 * W16 / M05 buyer agent chat (HF-041; screens.md §W16, §M05; features/04 §Logic 2).
 * The shopper describes a want; the agent's checks show as chips ("Checked 14 stores"), open
 * books as product cards, and a money proposal as a confirm card the shopper approves in one tap.
 * States: empty with prompts · thinking (streaming) · confirm required · action done · agent
 * unavailable (link to W12). Phones: full-screen thread, bottom input, the pending confirm card as
 * a bottom sheet, chips collapsed. Desktop: side panel with live bids and the mandate summary.
 * `?fixture=1` replays a recorded turn (lib/agent-chat.fixture.ts) with no API key or database.
 */
export function AgentChatPage() {
  const [params] = useSearchParams();
  const fixture = params.get('fixture') === '1';
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);
  const chat = useAgentChat({ fixture, onTurnEnd: refresh });
  const me = useShopper(fixture);
  const signedOut = !fixture && (chat.signedOut || me === 'none');

  const { items, phase } = chat.state;
  const sheetId = activeConfirmId(items);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
    // Every change (a new event, a card turning "held") keeps the newest content in view.
  }, [items, phase]);

  return (
    <div className="grid grid-cols-1 gap-8 pt-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:pt-6">
      <section aria-label="Agent chat" className="flex min-h-[calc(100dvh-8rem)] flex-col">
        <header className="flex items-center justify-between gap-3 pb-4">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="text-[22px] font-medium tracking-headline whitespace-nowrap text-ink sm:text-[28px]">
              Your buying agent
            </h1>
            {fixture && <Badge tone="sim">Recorded demo</Badge>}
          </div>
          {items.length > 0 && (
            <Button variant="ghost" onClick={chat.newChat} disabled={phase === 'thinking'}>
              New chat
            </Button>
          )}
        </header>

        <div
          className="flex flex-1 flex-col gap-4"
          aria-live="polite"
          aria-busy={phase === 'thinking'}
        >
          {signedOut ? (
            <SignedOut onSignedIn={() => window.location.reload()} />
          ) : chat.loadingHistory ? (
            <Skeleton className="h-32" />
          ) : items.length === 0 ? (
            <EmptyChat onPick={(p) => void chat.send(p)} />
          ) : (
            items.map((item) => (
              <Item
                key={item.id}
                item={item}
                sheet={item.kind === 'confirm' && item.card.actionId === sheetId}
                fixture={fixture}
                dispatch={chat.dispatch}
                onExecuted={refresh}
              />
            ))
          )}
          {phase === 'thinking' && <Thinking />}
          {/* Phones: room to scroll the thread above the confirm sheet. */}
          {sheetId && <div aria-hidden className="h-80 lg:hidden" />}
          <div ref={endRef} className="scroll-mb-24" />
        </div>

        {!signedOut && (
          <Composer
            disabled={phase === 'thinking' || chat.loadingHistory}
            onSend={(t) => void chat.send(t)}
          />
        )}
      </section>

      <div className="hidden lg:block">
        <div className="sticky top-6">
          <AgentSidePanel refreshKey={refreshKey} />
        </div>
      </div>
    </div>
  );
}

/** 'none' = no shopper session (requireShopper would 401). Null while loading. */
function useShopper(skip: boolean): 'yes' | 'none' | null {
  const [me, setMe] = useState<'yes' | 'none' | null>(null);
  useEffect(() => {
    if (skip) return;
    let live = true;
    api
      .request<{ shopper: unknown }>({ method: 'GET', path: '/api/me' })
      .then((r) => live && setMe(r.shopper ? 'yes' : 'none'))
      .catch(() => live && setMe('yes')); // let the chat call decide
    return () => {
      live = false;
    };
  }, [skip]);
  return me;
}

function Item({
  item,
  sheet,
  fixture,
  dispatch,
  onExecuted,
}: {
  item: ThreadItem;
  sheet: boolean;
  fixture: boolean;
  dispatch: Parameters<typeof ConfirmCard>[0]['dispatch'];
  onExecuted(): void;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <p className="max-w-[85%] self-end rounded-md bg-charcoal px-4 py-2.5 text-[15px] leading-[22px] text-white">
          {item.text}
        </p>
      );
    case 'text':
      return (
        <p className="max-w-[92%] text-[16px] leading-[25px] whitespace-pre-line text-ink">
          {item.text}
        </p>
      );
    case 'tools':
      return <ToolChips chips={item.chips} />;
    case 'products':
      return (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {item.products.map((p) => (
            <li key={p.key}>
              <ProductCard product={p} />
            </li>
          ))}
        </ul>
      );
    case 'confirm':
      return (
        <ConfirmCard
          item={item}
          sheet={sheet}
          fixture={fixture}
          dispatch={dispatch}
          onExecuted={onExecuted}
        />
      );
    case 'error':
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-md border border-line bg-surface p-4"
        >
          <p className="text-[15px] text-ink">{item.message}</p>
          <ButtonLink to={item.fallbackUrl ?? paths.offer(DEMO_OFFER_SLUG)} variant="outline">
            Bid directly
          </ButtonLink>
        </div>
      );
  }
}

function chipIcon(c: ToolChip) {
  if (c.status === 'running') {
    return <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange" />;
  }
  return (
    <span
      aria-hidden
      className={cn('h-1.5 w-1.5 rounded-full', c.status === 'ok' ? 'bg-success' : 'bg-danger')}
    />
  );
}

/** Tool-call chips: all shown from `sm`; collapsed to one summary chip on phones (M05). */
function ToolChips({ chips }: { chips: ToolChip[] }) {
  const running = chips.some((c) => c.status === 'running');
  const list = (
    <ul className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <li
          key={c.id}
          className="inline-flex items-center gap-2 rounded-sm border border-line bg-white px-2.5 py-1 font-mono text-[12px] text-body"
        >
          {chipIcon(c)}
          {c.label}
        </li>
      ))}
    </ul>
  );
  return (
    <div data-testid="tool-chips">
      <div className="hidden sm:block">{list}</div>
      <details className="group sm:hidden">
        <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-sm border border-line bg-white px-2.5 py-1 font-mono text-[12px] text-body">
          {chipIcon(chips[chips.length - 1]!)}
          {running ? chips[chips.length - 1]!.label : chips[0]!.label}
          {chips.length > 1 && <span className="text-muted">+{chips.length - 1}</span>}
        </summary>
        <div className="pt-2">{list}</div>
      </details>
    </div>
  );
}

function ProductCard({ product: p }: { product: ProductCardView }) {
  return (
    <div className="flex h-full gap-3 rounded-md border border-line bg-white p-3">
      {p.imageUrl && (
        <img
          src={p.imageUrl}
          alt=""
          className="h-14 w-14 shrink-0 rounded-sm border border-line object-contain"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-[14px] leading-[20px] text-ink">{p.title}</p>
        {p.brand && <p className="text-[12px] text-muted">{p.brand}</p>}
        <dl className="grid grid-cols-2 gap-2 pt-1">
          <div>
            <dt className="label text-[10px] text-muted">Public low</dt>
            <dd className="font-mono text-[14px] text-ink tabular-nums">
              {p.publicPriceCents != null ? formatUsd(p.publicPriceCents) : '—'}
            </dd>
            {p.publicMerchant && (
              <dd className="truncate text-[11px] text-muted">Channel3 · {p.publicMerchant}</dd>
            )}
          </div>
          {p.suggestedBidCents != null && (
            <div>
              <dt className="label text-[10px] text-muted">Suggested bid</dt>
              <dd className="font-mono text-[14px] text-orange tabular-nums">
                {formatUsd(p.suggestedBidCents)}
              </dd>
            </div>
          )}
        </dl>
        {p.myBidCents != null && (
          <Badge tone="held" className="self-start">
            Your bid {formatUsd(p.myBidCents)}
          </Badge>
        )}
        {p.offerHref && (
          <Link
            to={p.offerHref}
            className="label self-start pt-1 text-[11px] text-body underline-offset-4 hover:text-ink hover:underline"
          >
            Open offer →
          </Link>
        )}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <p role="status" className="flex items-center gap-2 font-mono text-[12px] text-muted">
      <span aria-hidden className="flex gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted [animation-delay:300ms]" />
      </span>
      Thinking…
    </p>
  );
}

function EmptyChat({ onPick }: { onPick(prompt: string): void }) {
  return (
    <div className="flex flex-col gap-5 py-4 sm:py-8">
      <p className="max-w-[520px] text-[17px] leading-[25px] text-body">
        Tell me what you want and what you’d pay. I check open books and real store prices, then
        propose a bid. Nothing is held until you approve it.
      </p>
      <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" aria-label="Suggested prompts">
        {SUGGESTED_PROMPTS.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => onPick(p)}
              className="w-full rounded-sm border border-border bg-white px-3 py-2 text-left text-[14px] text-charcoal hover:bg-surface sm:w-auto"
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend(text: string): void }) {
  const [text, setText] = useState('');
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled || !text.trim()) return;
    onSend(text);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) submit(e);
  };
  return (
    <form
      onSubmit={submit}
      className="sticky bottom-0 z-20 -mx-4 mt-4 flex items-end gap-2 border-t border-line bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:mx-0 sm:rounded-md sm:border sm:px-3"
    >
      <label htmlFor="agent-input" className="sr-only">
        Message your agent
      </label>
      <textarea
        id="agent-input"
        rows={1}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="Aurel headphones under $230"
        className="max-h-32 min-h-10 flex-1 resize-none rounded-sm px-2 py-2 text-[16px] text-ink focus:outline-none"
      />
      <Button type="submit" size="lg" disabled={disabled || !text.trim()}>
        {disabled ? '…' : 'Send'}
      </Button>
    </form>
  );
}

function SignedOut({ onSignedIn }: { onSignedIn(): void }) {
  const demo = clientConfig().demoMode;
  const signIn = useApiAction<{ shopper: unknown }>();
  const go = async () => {
    const res = await signIn.run({ method: 'POST', path: '/api/auth/demo/shopper', body: {} });
    if (res?.shopper) onSignedIn();
  };
  return (
    <div className="flex flex-col items-start gap-4 rounded-md border border-dashed border-planned bg-surface p-6">
      <p className="text-[15px] text-body">
        Your agent bids as you. {demo ? 'Sign in as the demo shopper' : 'Open an offer first'} to
        start a chat.
      </p>
      {demo ? (
        <Button onClick={() => void go()} disabled={signIn.status === 'pending'}>
          {signIn.status === 'pending' ? '…' : 'Continue as demo shopper'}
        </Button>
      ) : (
        <ButtonLink to={paths.offer(DEMO_OFFER_SLUG)}>Open an offer</ButtonLink>
      )}
      {signIn.status === 'error' && (
        <p role="alert" className="text-[13px] text-danger">
          {signIn.error.message}
        </p>
      )}
    </div>
  );
}
