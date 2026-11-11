import type { Queryable } from './db.js';

/**
 * Webhook dedupe (HF-003b, review M14; data-model §Locking and idempotency rule 7).
 *
 * `INSERT INTO webhook_events … ON CONFLICT DO NOTHING` keyed by the provider's event id. An event
 * is processed when its row is new **or** `processed_at IS NULL` (an earlier delivery crashed or
 * failed), and is a duplicate only once `processed_at` is set, which happens after processing
 * succeeds. So a crash between receipt and processing never loses the event: the provider's
 * redelivery or the HF-034 cron (`pendingWebhookEvents`) picks it up.
 *
 * Two deliveries of the same unprocessed event can overlap; processors (HF-033, HF-042b) must be
 * idempotent, which they are by construction: every state change is a conditional transition.
 */

export type WebhookProvider = 'PAYPAL' | 'CHANNEL3';

export interface WebhookEventInput {
  /** Provider event id: the primary key. */
  id: string;
  provider: WebhookProvider;
  eventType?: string | null;
  payload: unknown;
}

export interface WebhookEventRow {
  id: string;
  provider: WebhookProvider;
  event_type: string | null;
  received_at: Date;
  payload: unknown;
  processed_at: Date | null;
  attempts: number;
  last_error: string | null;
}

export type RecordedWebhook =
  /** First delivery: process it. */
  | { status: 'NEW'; event: WebhookEventRow }
  /** Seen before but never processed (crash or failure): process it again. */
  | { status: 'RETRY'; event: WebhookEventRow }
  /** Already processed: acknowledge and do nothing. */
  | { status: 'DUPLICATE'; event: WebhookEventRow };

/**
 * Record a delivery and say whether to process it. Each NEW / RETRY bumps `attempts`. A redelivery
 * keeps the first payload.
 */
export async function recordWebhookEvent(
  q: Queryable,
  input: WebhookEventInput,
): Promise<RecordedWebhook> {
  const inserted = await q.query(
    `INSERT INTO webhook_events (id, provider, event_type, payload, attempts)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [input.id, input.provider, input.eventType ?? null, JSON.stringify(input.payload ?? null)],
  );
  if (inserted.rows[0]) return { status: 'NEW', event: inserted.rows[0] as WebhookEventRow };

  const retried = await q.query(
    `UPDATE webhook_events SET attempts = attempts + 1
      WHERE id = $1 AND processed_at IS NULL
      RETURNING *`,
    [input.id],
  );
  if (retried.rows[0]) return { status: 'RETRY', event: retried.rows[0] as WebhookEventRow };

  const existing = await q.query(`SELECT * FROM webhook_events WHERE id = $1`, [input.id]);
  return { status: 'DUPLICATE', event: existing.rows[0] as WebhookEventRow };
}

/** Set `processed_at` after successful processing. Pass the processing transaction if any. */
export async function markWebhookProcessed(q: Queryable, id: string): Promise<void> {
  await q.query(
    `UPDATE webhook_events SET processed_at = now(), last_error = NULL
      WHERE id = $1 AND processed_at IS NULL`,
    [id],
  );
}

/** Keep the row unprocessed and remember why, for the retry and the ops screen. */
export async function markWebhookFailed(q: Queryable, id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await q.query(
    `UPDATE webhook_events SET last_error = $2 WHERE id = $1 AND processed_at IS NULL`,
    [id, message.slice(0, 1000)],
  );
}

export type WebhookHandled = 'PROCESSED' | 'DUPLICATE';

/**
 * Record, process if new or unprocessed, then set `processed_at`. If `process` throws, the row
 * stays unprocessed with `last_error` and the error is rethrown so the route answers 5xx and the
 * provider redelivers.
 */
export async function handleWebhookEvent(
  q: Queryable,
  input: WebhookEventInput,
  process: (event: WebhookEventRow) => Promise<void>,
): Promise<WebhookHandled> {
  const recorded = await recordWebhookEvent(q, input);
  if (recorded.status === 'DUPLICATE') return 'DUPLICATE';
  try {
    await process(recorded.event);
  } catch (err) {
    await markWebhookFailed(q, input.id, err);
    throw err;
  }
  await markWebhookProcessed(q, input.id);
  return 'PROCESSED';
}

/**
 * Unprocessed events received more than `olderThanMs` ago (default 2 min), oldest first, for the
 * HF-034 cron to reprocess.
 */
export async function pendingWebhookEvents(
  q: Queryable,
  opts: { olderThanMs?: number; limit?: number; provider?: WebhookProvider } = {},
): Promise<WebhookEventRow[]> {
  const res = await q.query(
    `SELECT * FROM webhook_events
      WHERE processed_at IS NULL
        AND received_at < now() - make_interval(secs => $1)
        AND ($2::text IS NULL OR provider = $2)
      ORDER BY received_at ASC
      LIMIT $3`,
    [(opts.olderThanMs ?? 120_000) / 1000, opts.provider ?? null, opts.limit ?? 100],
  );
  return res.rows as WebhookEventRow[];
}
