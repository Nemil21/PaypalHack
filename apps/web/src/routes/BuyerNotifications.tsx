import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { NotificationReadResponse, NotificationsResponse } from '@holdfast/shared';
import { PushToggle } from '../components/PushToggle';
import { ErrorBanner, Skeleton } from '../components/ui';
import { ApiAction, ApiError, api } from '../lib/api';
import { cn } from '../lib/cn';
import {
  markReadLocally,
  NOTIFICATIONS_POLL_MS,
  notificationsQuery,
  toView,
  type NotificationView,
} from '../lib/notifications';
import type { MeResponse } from '../lib/viewer';
import { ErrorState } from './bids/ErrorState';
import { usePolling } from './bids/hooks';

/**
 * v4 buyer notifications (frame 120:896, M11): one list, newest first, an orange dot on unread
 * rows, each with its deep link ("Raise →", "Track →", "View receipt & tracking →"). Opening a row
 * marks it read. The phone-alerts switch sits by the title; the push / email previews of every
 * template stay one link away (`?view=templates`).
 */
export function BuyerNotifications() {
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [name, setName] = useState<string | null>(null);
  const query = notificationsQuery('shopper');

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
      setError(
        err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.'),
      );
    }
  }, [query]);

  useEffect(() => {
    void load();
    let live = true;
    api
      .request<MeResponse>({ method: 'GET', path: '/api/me' })
      .then((me) => live && setName(me.shopper?.displayName ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [load]);
  usePolling(error?.status !== 401, NOTIFICATIONS_POLL_MS, () => void load());

  const markRead = async (id: string) => {
    setData((d) => (d ? markReadLocally(d, id, new Date().toISOString()) : d));
    try {
      const res = await new ApiAction(api).run<NotificationReadResponse>({
        method: 'POST',
        path: `/api/notifications/${encodeURIComponent(id)}/read${query}`,
      });
      setData((d) => (d ? markReadLocally(d, id, res.readAt, res.unreadCount) : d));
    } catch {
      void load();
    }
  };

  const now = Date.now();
  const rows = (data?.notifications ?? [])
    .map((n) => toView(n, now))
    .filter((v): v is NotificationView => v !== null);

  if (error?.status === 401) {
    return (
      <div className="mx-auto max-w-[600px] py-8">
        <ErrorState code="UNAUTHENTICATED" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[600px] flex-col gap-6 pt-6 pb-12 lg:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          {name && <span className="label text-[13px] text-orange">{name}</span>}
          <h1 className="text-[32px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[40px]">
            Notifications
          </h1>
        </div>
      </header>
      <PushToggle audience="shopper" />

      {error && !data && <ErrorBanner message={error.message} onRetry={() => void load()} />}
      {!data && !error && <Skeleton className="h-48 w-full" />}
      {data && rows.length === 0 && (
        <p className="rounded-sm bg-surface p-4 text-[14px] text-body">
          Nothing yet. Holds, price drops, raise prompts and results show up here.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-sm border border-line bg-white">
          {rows.map((n) => (
            <li key={n.id}>
              <Row n={n} onOpen={() => n.unread && void markRead(n.id)} />
            </li>
          ))}
        </ul>
      )}

      <Link
        to="/notifications?view=templates"
        className="label self-start text-[12px] text-body hover:text-ink"
      >
        Push and email previews <span aria-hidden>→</span>
      </Link>
    </div>
  );
}

function Row({ n, onOpen }: { n: NotificationView; onOpen(): void }) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn('mt-2 h-1.5 w-1.5 shrink-0 rounded-full', n.unread ? 'bg-orange' : '')}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] text-ink">
          {n.title}
          {n.unread && <span className="sr-only"> (unread)</span>}
        </span>
        <span className="text-[13px] text-body">
          {n.body} · {n.when}
        </span>
        {n.disclosure && <span className="text-[12px] text-muted">{n.disclosure}</span>}
      </span>
      {n.link && (
        <span className="label shrink-0 self-center text-[12px] text-ink">
          {n.link.label.replace(/\s*→$/, '')} <span aria-hidden>→</span>
        </span>
      )}
    </>
  );
  const cls = 'flex items-start gap-3 px-4 py-4 hover:bg-surface sm:px-5';
  if (!n.link) {
    return <div className={cls}>{body}</div>;
  }
  return n.external ? (
    <a
      href={n.link.href}
      target="_blank"
      rel="sponsored noopener noreferrer"
      className={cls}
      onClick={onOpen}
    >
      {body}
    </a>
  ) : (
    <Link to={n.link.href} className={cls} onClick={onOpen}>
      {body}
    </Link>
  );
}
