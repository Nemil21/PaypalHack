import {
  isNotificationTemplate,
  type NotificationItem,
  type NotificationReadResponse,
  type NotificationRecipientType,
  type NotificationsResponse,
} from '@holdfast/shared';
import type { Queryable } from '../db.js';

/**
 * The in-app list behind the bell (HF-054a; api.md `GET /notifications`,
 * `POST /notifications/:id/read`). Every read is scoped to the session's recipient: a shopper sees
 * their own rows, a brand user sees their brand's. Another recipient's id answers like an unknown
 * one.
 */

export interface Recipient {
  type: NotificationRecipientType;
  id: string;
}

export const NOTIFICATIONS_PAGE_SIZE = 50;

interface NotificationRow {
  id: string;
  template: string;
  payload: Record<string, unknown>;
  created_at: Date;
  read_at: Date | null;
}

async function unreadCount(q: Queryable, r: Recipient): Promise<number> {
  const res = await q.query(
    `SELECT count(*)::int AS n FROM notifications
      WHERE recipient_type = $1 AND recipient_id = $2 AND channel = 'IN_APP' AND read_at IS NULL`,
    [r.type, r.id],
  );
  return (res.rows[0] as { n: number }).n;
}

export async function listNotifications(
  q: Queryable,
  r: Recipient,
  limit = NOTIFICATIONS_PAGE_SIZE,
): Promise<NotificationsResponse> {
  const res = await q.query(
    `SELECT id, template, payload, created_at, read_at FROM notifications
      WHERE recipient_type = $1 AND recipient_id = $2 AND channel = 'IN_APP'
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [r.type, r.id, limit],
  );
  const notifications: NotificationItem[] = [];
  for (const row of res.rows as NotificationRow[]) {
    // Rows from a template this build doesn't know (a newer deploy) are left out, not crashed on.
    if (!isNotificationTemplate(row.template)) continue;
    notifications.push({
      id: row.id,
      template: row.template,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
      readAt: row.read_at ? row.read_at.toISOString() : null,
    });
  }
  return { notifications, unreadCount: await unreadCount(q, r) };
}

/** Mark one row read (idempotent: a second call keeps the first `read_at`). Null = not theirs. */
export async function markNotificationRead(
  q: Queryable,
  r: Recipient,
  id: string,
): Promise<NotificationReadResponse | null> {
  const res = await q.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now()), updated_at = now()
      WHERE id = $1 AND recipient_type = $2 AND recipient_id = $3
      RETURNING read_at`,
    [id, r.type, r.id],
  );
  const row = res.rows[0] as { read_at: Date } | undefined;
  if (!row) return null;
  return { id, readAt: row.read_at.toISOString(), unreadCount: await unreadCount(q, r) };
}

/** Mark every unread row read; returns the new unread count (0). */
export async function markAllNotificationsRead(
  q: Queryable,
  r: Recipient,
): Promise<{ unreadCount: number }> {
  await q.query(
    `UPDATE notifications SET read_at = now(), updated_at = now()
      WHERE recipient_type = $1 AND recipient_id = $2 AND read_at IS NULL`,
    [r.type, r.id],
  );
  return { unreadCount: await unreadCount(q, r) };
}
