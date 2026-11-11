import {
  isNotificationTemplate,
  renderNotification,
  type NotificationItem,
  type NotificationPayloads,
  type NotificationsResponse,
  type RenderedNotification,
} from '@holdfast/shared';

/**
 * The in-app bell (HF-054a; screens.md W14 / M03 header, W04 for brands). The list comes from
 * `GET /api/notifications` (`?as=brand` for a brand user); the words are rendered here with the
 * shared D14 templates in the browser's own time zone.
 */

export type Audience = 'shopper' | 'brand';

/** Poll while the tab is visible; money events also show on the bid pages themselves (D18). */
export const NOTIFICATIONS_POLL_MS = 15_000;

export function notificationsQuery(audience: Audience): string {
  return audience === 'brand' ? '?as=brand' : '';
}

export interface NotificationView extends RenderedNotification {
  id: string;
  unread: boolean;
  /** "Just now", "5 min ago", "3 h ago", "2 d ago". */
  when: string;
  /** In-app path (router link) vs. a retailer page (new tab). */
  external: boolean;
}

export function relativeTime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export function toView(
  item: NotificationItem,
  now: number,
  timeZone?: string,
): NotificationView | null {
  if (!isNotificationTemplate(item.template)) return null;
  let rendered: RenderedNotification;
  try {
    rendered = renderNotification(
      item.template,
      item.payload as unknown as NotificationPayloads[typeof item.template],
      { timeZone },
    );
  } catch {
    return null; // A malformed payload is skipped, never shown half-rendered.
  }
  return {
    ...rendered,
    id: item.id,
    unread: item.readAt === null,
    when: relativeTime(item.createdAt, now),
    external: rendered.link !== null && !rendered.link.href.startsWith('/'),
  };
}

/** "3", "9+", or null for none. */
export function badgeText(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 9 ? '9+' : String(unread);
}

/** Apply a mark-as-read locally (optimistic), keeping the server's count when it is known. */
export function markReadLocally(
  state: NotificationsResponse,
  id: string,
  readAt: string,
  unreadCount?: number,
): NotificationsResponse {
  let changed = 0;
  const notifications = state.notifications.map((n) => {
    if (n.id !== id || n.readAt !== null) return n;
    changed++;
    return { ...n, readAt };
  });
  return {
    notifications,
    unreadCount: unreadCount ?? Math.max(0, state.unreadCount - changed),
  };
}

export function markAllReadLocally(
  state: NotificationsResponse,
  readAt: string,
): NotificationsResponse {
  return {
    notifications: state.notifications.map((n) => (n.readAt ? n : { ...n, readAt })),
    unreadCount: 0,
  };
}

export function bellLabel(unread: number): string {
  return unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
}
