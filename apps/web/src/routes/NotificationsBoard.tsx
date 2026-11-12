import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { NotificationsResponse } from '@holdfast/shared';
import { PushToggle } from '../components/PushToggle';
import { ErrorBanner, Skeleton } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { cn } from '../lib/cn';
import { boardCards, sampleCards, type BoardCard } from '../lib/notification-board';
import { NOTIFICATIONS_POLL_MS, notificationsQuery, type Audience } from '../lib/notifications';
import { usePolling } from './bids/hooks';
import { BuyerNotifications } from './BuyerNotifications';

/**
 * M11 push / email notification set (HF-054b; screens.md §M11, features/13 §Templates). Mobile
 * first: the "Phone alerts" switch, then each notification as the push preview and the email it
 * also went out as. "Yours" is the bell's own list (same request, same rendering); "All
 * templates" shows every template on the features/13 numbers. Shoppers at `/notifications`,
 * brand users at `/brand/notifications`.
 */
export function NotificationsBoard({ audience }: { audience: Audience }) {
  const [tab, setTab] = useState<'yours' | 'all'>('yours');
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const query = notificationsQuery(audience);

  const load = useCallback(async () => {
    try {
      setData(
        await api.request<NotificationsResponse>({
          method: 'GET',
          path: `/api/notifications${query}`,
        }),
      );
      setError(null);
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      setError({ code: e?.code ?? 'CLIENT_ERROR', message: e?.message ?? 'Something went wrong.' });
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(error?.code !== 'UNAUTHENTICATED', NOTIFICATIONS_POLL_MS, () => void load());

  const now = Date.now();
  const cards =
    tab === 'yours' ? boardCards(data?.notifications ?? [], now) : sampleCards(audience, now);
  const signIn = audience === 'brand' ? '/brand/sign-in' : '/bids';

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6 pt-6 pb-12">
      <header className="flex flex-col gap-1">
        <p className="label text-[11px] text-muted">M11 · Push and email</p>
        <h1 className="text-[28px] font-semibold tracking-tight text-ink">Notifications</h1>
        <p className="text-[15px] text-body">
          Every money event, in the words you'll see on your phone and in your inbox.
        </p>
      </header>

      {error?.code === 'UNAUTHENTICATED' ? (
        <p className="rounded-md bg-surface p-4 text-[14px] text-body">
          Sign in to see your notifications.{' '}
          <Link to={signIn} className="text-ink underline underline-offset-2">
            Go there
          </Link>
        </p>
      ) : (
        <PushToggle audience={audience} />
      )}

      <div role="tablist" aria-label="Notification set" className="flex gap-1 border-b border-line">
        <TabButton active={tab === 'yours'} onClick={() => setTab('yours')}>
          Yours{data ? ` · ${data.notifications.length}` : ''}
        </TabButton>
        <TabButton active={tab === 'all'} onClick={() => setTab('all')}>
          All templates
        </TabButton>
      </div>

      {tab === 'yours' && error && error.code !== 'UNAUTHENTICATED' && !data && (
        <ErrorBanner message={error.message} onRetry={() => void load()} />
      )}
      {tab === 'yours' && !data && !error && (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      )}
      {tab === 'yours' && data && cards.length === 0 && (
        <p className="rounded-md bg-surface p-4 text-[14px] text-body">
          Nothing yet. Holds, price drops, raise prompts and results show up here.
        </p>
      )}

      <ul className="flex flex-col gap-6">
        {cards.map((c) => (
          <li key={c.id} className="grid gap-3 md:grid-cols-2">
            <PushPreview card={c} sample={tab === 'all'} />
            <EmailPreview card={c} sample={tab === 'all'} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        '-mb-px border-b-2 px-3 py-2 text-[14px]',
        active ? 'border-ink font-medium text-ink' : 'border-transparent text-body hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** The lock-screen banner. Tapping it in the app does what tapping the real push does. */
function PushPreview({ card, sample }: { card: BoardCard; sample: boolean }) {
  const inner = (
    <>
      <div className="flex items-center gap-2">
        <img src="/icons/icon-192.png" alt="" className="h-5 w-5 rounded-[5px]" />
        <span className="label text-[10px] text-muted">Holdfast</span>
        <span className="ml-auto font-mono text-[11px] text-muted">{card.when}</span>
      </div>
      <p className="mt-1.5 text-[14px] font-semibold text-ink">
        {card.title}
        {card.unread && <span className="sr-only"> (unread)</span>}
      </p>
      <p className="text-[14px] text-body">{card.body}</p>
    </>
  );
  const cls = cn(
    'block rounded-[18px] bg-surface p-4 shadow-card',
    card.unread && 'ring-1 ring-orange/50',
  );
  return (
    <div className="flex flex-col gap-1">
      <p className="label text-[10px] text-muted">Push</p>
      {sample ? (
        <div className={cls}>{inner}</div>
      ) : (
        <Link to={card.pushUrl} className={cn(cls, 'hover:bg-surface/70')}>
          {inner}
        </Link>
      )}
    </div>
  );
}

function EmailPreview({ card, sample }: { card: BoardCard; sample: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="label text-[10px] text-muted">Email</p>
      <div className="flex flex-col gap-2 rounded-md border border-border bg-white p-4">
        <p className="font-mono text-[12px] text-muted">Subject: {card.title}</p>
        <p className="text-[14px] text-ink">{card.body}</p>
        {card.link &&
          (sample ? (
            <span className="self-start rounded-sm bg-ink px-3 py-1.5 text-[13px] font-medium text-white">
              {card.link.label}
            </span>
          ) : card.external ? (
            <a
              href={card.link.href}
              target="_blank"
              rel="noopener noreferrer sponsored"
              className="self-start rounded-sm bg-ink px-3 py-1.5 text-[13px] font-medium text-white"
            >
              {card.link.label}
            </a>
          ) : (
            <Link
              to={card.link.href}
              className="self-start rounded-sm bg-ink px-3 py-1.5 text-[13px] font-medium text-white"
            >
              {card.link.label}
            </Link>
          ))}
        {card.disclosure && <p className="text-[12px] text-muted">{card.disclosure}</p>}
      </div>
    </div>
  );
}

/** Route entries (lazy-loaded in app.tsx): `/notifications` and `/brand/notifications`. */
export function ShopperNotificationsBoard() {
  // v4 (frame 120:896): buyers get the plain list; the M11 push / email set stays one link away.
  const [params] = useSearchParams();
  return params.get('view') === 'templates' ? (
    <NotificationsBoard audience="shopper" />
  ) : (
    <BuyerNotifications />
  );
}

export function BrandNotificationsBoard() {
  return <NotificationsBoard audience="brand" />;
}
