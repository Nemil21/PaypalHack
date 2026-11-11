import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { NotificationReadResponse, NotificationsResponse } from '@holdfast/shared';
import { ApiAction, ApiError, api } from '../lib/api';
import { cn } from '../lib/cn';
import {
  badgeText,
  bellLabel,
  markAllReadLocally,
  markReadLocally,
  NOTIFICATIONS_POLL_MS,
  notificationsQuery,
  toView,
  type Audience,
  type NotificationView,
} from '../lib/notifications';
import { usePolling } from '../routes/bids/hooks';

/**
 * The in-app bell (HF-054a; W14 / M03 header for shoppers, W04 for brands): unread count, a list
 * of the latest notifications, mark one read (opening it does too) or mark all read. Signed out →
 * renders nothing. Polls every 15 s while the tab is visible.
 */
export function NotificationBell({
  audience,
  className,
}: {
  audience: Audience;
  className?: string;
}) {
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const query = notificationsQuery(audience);

  const load = useCallback(async () => {
    try {
      setData(
        await api.request<NotificationsResponse>({
          method: 'GET',
          path: `/api/notifications${query}`,
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setHidden(true);
      // Anything else: keep the last good list; the next poll retries.
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(!hidden, NOTIFICATIONS_POLL_MS, () => void load());

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markRead = async (id: string) => {
    setData((d) => (d ? markReadLocally(d, id, new Date().toISOString()) : d));
    try {
      const res = await new ApiAction(api).run<NotificationReadResponse>({
        method: 'POST',
        path: `/api/notifications/${encodeURIComponent(id)}/read${query}`,
      });
      setData((d) => (d ? markReadLocally(d, id, res.readAt, res.unreadCount) : d));
    } catch {
      void load(); // put the server's state back
    }
  };

  const markAll = async () => {
    setData((d) => (d ? markAllReadLocally(d, new Date().toISOString()) : d));
    try {
      await new ApiAction(api).run({ method: 'POST', path: `/api/notifications/read-all${query}` });
    } catch {
      void load();
    }
  };

  if (hidden) return null;
  const unread = data?.unreadCount ?? 0;
  const badge = badgeText(unread);
  const now = Date.now();
  const views = (data?.notifications ?? [])
    .map((n) => toView(n, now))
    .filter((v): v is NotificationView => v !== null);

  return (
    <div ref={root} className={cn('relative', className)}>
      <button
        type="button"
        aria-label={bellLabel(unread)}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-sm border border-border bg-white text-charcoal hover:text-ink"
      >
        <BellIcon />
        {badge && (
          <span
            aria-hidden
            className="label absolute -top-1.5 -right-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-orange px-1 text-[10px] leading-none text-white"
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Notifications"
          className="absolute right-0 z-30 mt-2 w-[min(92vw,380px)] rounded-md border border-border bg-white shadow-card"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="label text-[11px] text-muted">
              Notifications{unread > 0 ? ` · ${unread} unread` : ''}
            </p>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAll()}
                className="font-mono text-[12px] text-body hover:text-ink"
              >
                Mark all read
              </button>
            )}
          </div>
          {views.length === 0 ? (
            <p className="px-4 py-6 text-[14px] text-muted">
              {data ? 'Nothing yet. Money events show up here.' : 'Loading…'}
            </p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
              {views.map((v) => (
                <NotificationRow key={v.id} view={v} onRead={() => void markRead(v.id)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationRow({ view, onRead }: { view: NotificationView; onRead: () => void }) {
  return (
    <li className={cn('flex gap-3 px-4 py-3', view.unread && 'bg-orange-tint/40')}>
      <span
        aria-hidden
        className={cn(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          view.unread ? 'bg-orange' : 'bg-transparent',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[14px] font-medium text-ink">
            {view.title}
            {view.unread && <span className="sr-only"> (unread)</span>}
          </p>
          <span className="shrink-0 font-mono text-[11px] text-muted">{view.when}</span>
        </div>
        <p className="mt-0.5 text-[14px] text-body">{view.body}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          {view.link &&
            (view.external ? (
              <a
                href={view.link.href}
                target="_blank"
                rel="noopener noreferrer sponsored"
                onClick={onRead}
                className="font-mono text-[12px] text-ink underline underline-offset-2"
              >
                {view.link.label}
              </a>
            ) : (
              <Link
                to={view.link.href}
                onClick={onRead}
                className="font-mono text-[12px] text-ink underline underline-offset-2"
              >
                {view.link.label}
              </Link>
            ))}
          {view.unread && (
            <button
              type="button"
              onClick={onRead}
              className="font-mono text-[12px] text-muted hover:text-ink"
            >
              Mark read
            </button>
          )}
        </div>
        {view.disclosure && <p className="mt-1 text-[12px] text-muted">{view.disclosure}</p>}
      </div>
    </li>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M10 20.5a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
