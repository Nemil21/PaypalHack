import {
  dedupeKey,
  recipientTypeOf,
  type NotificationPayloads,
  type NotificationRecipientType,
  type NotificationTemplate,
} from '@holdfast/shared';
import type { Queryable } from '../db.js';

/** One notification to write: who, which template, and the entity that makes it unique. */
export type NotificationDraft = {
  [T in NotificationTemplate]: {
    template: T;
    recipientId: string;
    /** `notifications.dedupe_key` = `<template>:<entityId>`; one row per template per event. */
    entityId: string;
    payload: NotificationPayloads[T];
  };
}[NotificationTemplate];

export interface NotifiedRow {
  id: string;
  recipientType: NotificationRecipientType;
  recipientId: string;
  template: NotificationTemplate;
  dedupeKey: string;
}

/**
 * Write one in-app notification (features/13 §Logic). Deduped on `notifications.dedupe_key
 * UNIQUE`: replaying the same audit event, or two subscribers racing on it, writes one row.
 * Returns the row when this call created it, null when it already existed.
 *
 * In-app is the only channel here (HF-054a); HF-054b fans the new row out to email and push.
 */
export async function notify(q: Queryable, draft: NotificationDraft): Promise<NotifiedRow | null> {
  const recipientType = recipientTypeOf(draft.template);
  const key = dedupeKey(draft.template, draft.entityId);
  const res = await q.query(
    `INSERT INTO notifications (recipient_type, recipient_id, channel, template, payload, dedupe_key, sent_at)
     VALUES ($1, $2, 'IN_APP', $3, $4, $5, now())
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [recipientType, draft.recipientId, draft.template, JSON.stringify(draft.payload), key],
  );
  const row = res.rows[0] as { id: string } | undefined;
  return row
    ? {
        id: row.id,
        recipientType,
        recipientId: draft.recipientId,
        template: draft.template,
        dedupeKey: key,
      }
    : null;
}
