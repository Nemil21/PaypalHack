import {
  isNotificationTemplate,
  notificationEmail,
  notificationPush,
  type NotificationChannel,
  type NotificationPayloads,
  type NotificationTemplate,
  type PushMessage,
} from '@holdfast/shared';
import { brandNotificationEnabled } from '../brands/settings.js';
import type { Db, Queryable } from '../db.js';
import type { EmailSender, PushSender } from './channels.js';
import type { Recipient } from './inbox.js';
import { activePushSubscriptions, markSubscriptionGone } from './push-subscriptions.js';

/**
 * Email and web-push fan-out (HF-054b; features/13 §Channels, §Logic "fans out to enabled
 * channels"). It runs after HF-054a's `notify()` wrote the in-app row, as its own cron job, so a
 * slow mail or push service never delays the bell and a failed send never touches money.
 *
 * Each (in-app notification, channel) pair is one `notifications` row with
 * `dedupe_key = '<in-app dedupe_key>#EMAIL' | '#PUSH'`. Inserting that row is the claim: the
 * UNIQUE key lets exactly one runner (of any number racing, across instances) send it. A row whose
 * send failed keeps `sent_at` NULL and is retried, re-claimed by a conditional update, up to
 * `FANOUT_MAX_ATTEMPTS`. A crash between send and `sent_at` re-sends after the retry delay; Resend
 * dedupes that with the row id as its Idempotency-Key, and a push repeat collapses on its tag.
 *
 * Recipients: a shopper's email (none for anonymous or simulated shoppers) and devices; a brand's
 * users' emails and devices, each filtered by that user's W11 switches (`brandNotificationEnabled`).
 */

export const FANOUT_INTERVAL_MS = 5_000;
/** Only in-app rows this recent are fanned out (a deploy does not email last week's history). */
export const FANOUT_WINDOW_MS = 60 * 60 * 1000;
export const FANOUT_MAX_ATTEMPTS = 3;
export const FANOUT_RETRY_AFTER_MS = 60_000;
export const FANOUT_BATCH = 50;
/**
 * A claimed send is in flight until this long after the claim: no runner re-claims it before,
 * however short the retry delay or slow the send. Well above one send (10 s timeout per target).
 */
export const FANOUT_LEASE_MS = 5 * 60_000;

/** `payload.leaseUntil` = DB now + lease, in epoch ms (DB clock, so instances agree). */
const LEASE_SQL = (param: string) =>
  `jsonb_build_object('leaseUntil', (extract(epoch from now()) * 1000)::bigint + ${param}::bigint)`;

export const FANOUT_CHANNELS: readonly NotificationChannel[] = ['EMAIL', 'PUSH'];

export interface FanoutDeps {
  db: Pick<Db, 'pool'>;
  email: EmailSender;
  /** Null: push not configured (no VAPID keys); push rows are recorded as skipped. */
  push: PushSender | null;
  /** `APP_BASE_URL`, for absolute links in email. */
  baseUrl?: string | null;
}

export interface FanoutOptions {
  windowMs?: number;
  retryAfterMs?: number;
  maxAttempts?: number;
  batch?: number;
  leaseMs?: number;
  onError?: (err: unknown, ctx: { notificationId: string; channel: NotificationChannel }) => void;
}

export type DeliverySkip =
  'NO_EMAIL' | 'NO_DEVICE' | 'PUSH_OFF' | 'SIMULATED' | 'DISABLED' | 'UNKNOWN_TEMPLATE';

/** What a channel row's payload records. Never addresses or endpoints. */
export interface DeliveryRecord {
  attempts: number;
  sent?: number;
  failed?: number;
  gone?: number;
  skipped?: DeliverySkip;
  error?: string;
}

interface InAppRow {
  id: string;
  recipient_type: Recipient['type'];
  recipient_id: string;
  template: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
}

interface Outcome {
  record: Omit<DeliveryRecord, 'attempts'>;
  /** True: done (sent, skipped, or partly sent). False: every target failed; retry. */
  done: boolean;
}

export interface FanoutRunResult {
  /** Channel rows finished this run (sent or skipped). */
  delivered: number;
  /** Channel rows that failed and wait for a retry. */
  failed: number;
}

export interface Fanout {
  run(): Promise<FanoutRunResult>;
}

export function channelDedupeKey(inAppKey: string, channel: NotificationChannel): string {
  return `${inAppKey}#${channel}`;
}

export function createFanout(deps: FanoutDeps, opts: FanoutOptions = {}): Fanout {
  const q = deps.db.pool;
  const windowMs = opts.windowMs ?? FANOUT_WINDOW_MS;
  const retryAfterMs = opts.retryAfterMs ?? FANOUT_RETRY_AFTER_MS;
  const maxAttempts = opts.maxAttempts ?? FANOUT_MAX_ATTEMPTS;
  const batch = opts.batch ?? FANOUT_BATCH;
  const leaseMs = opts.leaseMs ?? FANOUT_LEASE_MS;

  async function attempt(
    channelRowId: string,
    attempts: number,
    channel: NotificationChannel,
    n: InAppRow,
  ): Promise<boolean> {
    let out: Outcome;
    try {
      out = await deliver(deps, channel, n, channelRowId);
    } catch (err) {
      opts.onError?.(err, { notificationId: n.id, channel });
      out = { record: { error: errorText(err) }, done: false };
    }
    // The whole payload is replaced: the lease ends with the attempt.
    const record: DeliveryRecord = { attempts, ...out.record };
    await q.query(
      `UPDATE notifications SET payload = $2, sent_at = CASE WHEN $3 THEN now() END WHERE id = $1`,
      [channelRowId, JSON.stringify(record), out.done],
    );
    return out.done;
  }

  async function fresh(result: FanoutRunResult) {
    const res = await q.query(
      `SELECT n.id, n.recipient_type, n.recipient_id, n.template, n.payload, n.dedupe_key
         FROM notifications n
        WHERE n.channel = 'IN_APP' AND n.dedupe_key IS NOT NULL
          AND n.created_at > now() - make_interval(secs => $1::double precision / 1000)
          AND (NOT EXISTS (SELECT 1 FROM notifications e WHERE e.dedupe_key = n.dedupe_key || '#EMAIL')
            OR NOT EXISTS (SELECT 1 FROM notifications p WHERE p.dedupe_key = n.dedupe_key || '#PUSH'))
        ORDER BY n.created_at, n.id
        LIMIT $2`,
      [windowMs, batch],
    );
    for (const n of res.rows as InAppRow[]) {
      for (const channel of FANOUT_CHANNELS) {
        // The claim: one runner inserts the channel row; everyone else gets nothing back.
        const claim = await q.query(
          `INSERT INTO notifications (recipient_type, recipient_id, channel, template, payload, dedupe_key)
           VALUES ($1, $2, $3, $4, $5::jsonb || ${LEASE_SQL('$7')}, $6)
           ON CONFLICT (dedupe_key) DO NOTHING
           RETURNING id`,
          [
            n.recipient_type,
            n.recipient_id,
            channel,
            n.template,
            JSON.stringify({ attempts: 1 } satisfies DeliveryRecord),
            channelDedupeKey(n.dedupe_key, channel),
            leaseMs,
          ],
        );
        const row = claim.rows[0] as { id: string } | undefined;
        if (!row) continue;
        if (await attempt(row.id, 1, channel, n)) result.delivered++;
        else result.failed++;
      }
    }
  }

  async function retries(result: FanoutRunResult) {
    // Conditional re-claim: SKIP LOCKED serialises racing runners, and the lease keeps a send
    // that is still in flight (first try or a retry) from being claimed again.
    const res = await q.query(
      `UPDATE notifications c
          SET payload = jsonb_set(c.payload, '{attempts}', to_jsonb(COALESCE((c.payload->>'attempts')::int, 0) + 1))
                        || ${LEASE_SQL('$4')}
        WHERE c.id IN (
          SELECT id FROM notifications
           WHERE channel IN ('EMAIL', 'PUSH') AND sent_at IS NULL
             AND updated_at < now() - make_interval(secs => $1::double precision / 1000)
             AND COALESCE((payload->>'attempts')::int, 0) < $2
             AND COALESCE((payload->>'leaseUntil')::bigint, 0) < (extract(epoch from now()) * 1000)::bigint
           ORDER BY updated_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING c.id, c.channel, (c.payload->>'attempts')::int AS attempts,
                  split_part(c.dedupe_key, '#', 1) AS base_key`,
      [retryAfterMs, maxAttempts, batch, leaseMs],
    );
    for (const r of res.rows as {
      id: string;
      channel: NotificationChannel;
      attempts: number;
      base_key: string;
    }[]) {
      const base = await q.query(
        `SELECT id, recipient_type, recipient_id, template, payload, dedupe_key
           FROM notifications WHERE dedupe_key = $1 AND channel = 'IN_APP'`,
        [r.base_key],
      );
      const n = base.rows[0] as InAppRow | undefined;
      if (!n) continue;
      if (await attempt(r.id, r.attempts, r.channel, n)) result.delivered++;
      else result.failed++;
    }
  }

  return {
    async run() {
      const result: FanoutRunResult = { delivered: 0, failed: 0 };
      await fresh(result);
      await retries(result);
      return result;
    },
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

async function deliver(
  deps: FanoutDeps,
  channel: NotificationChannel,
  n: InAppRow,
  channelRowId: string,
): Promise<Outcome> {
  if (!isNotificationTemplate(n.template)) {
    return { record: { skipped: 'UNKNOWN_TEMPLATE' }, done: true };
  }
  const template = n.template;
  const payload = n.payload as unknown as NotificationPayloads[typeof template];
  const recipient: Recipient = { type: n.recipient_type, id: n.recipient_id };
  return channel === 'EMAIL'
    ? deliverEmail(deps, recipient, template, payload, channelRowId)
    : deliverPush(deps.db.pool, deps.push, recipient, template, payload, n.dedupe_key);
}

async function deliverEmail<T extends NotificationTemplate>(
  deps: FanoutDeps,
  r: Recipient,
  template: T,
  payload: NotificationPayloads[T],
  channelRowId: string,
): Promise<Outcome> {
  const q = deps.db.pool;
  let to: string[];
  if (r.type === 'SHOPPER') {
    const res = await q.query(`SELECT email, is_simulated FROM shoppers WHERE id = $1`, [r.id]);
    const s = res.rows[0] as { email: string | null; is_simulated: boolean } | undefined;
    if (s?.is_simulated) return { record: { skipped: 'SIMULATED' }, done: true };
    to = s?.email ? [s.email] : [];
  } else {
    const res = await q.query(
      `SELECT email, notification_prefs AS prefs FROM brand_users WHERE brand_id = $1 ORDER BY created_at`,
      [r.id],
    );
    const users = res.rows as { email: string; prefs: unknown }[];
    to = users
      .filter((u) => brandNotificationEnabled(u.prefs, template, 'EMAIL'))
      .map((u) => u.email);
    if (users.length > 0 && to.length === 0) return { record: { skipped: 'DISABLED' }, done: true };
  }
  if (to.length === 0) return { record: { skipped: 'NO_EMAIL' }, done: true };

  const msg = notificationEmail(template, payload, { baseUrl: deps.baseUrl });
  let sent = 0;
  let failed = 0;
  let error: string | undefined;
  for (const [i, addr] of to.entries()) {
    try {
      await deps.email.send({ to: addr, ...msg, idempotencyKey: `${channelRowId}:${i}` });
      sent++;
    } catch (err) {
      failed++;
      error = errorText(err);
    }
  }
  return { record: { sent, failed, ...(error ? { error } : {}) }, done: sent > 0 || failed === 0 };
}

/**
 * Send one push message to every live device of `r` (W11 switches applied for brand devices).
 * Devices the push service reports gone are revoked. Shared by the fan-out and the test push.
 */
export async function pushToRecipient(
  q: Queryable,
  push: PushSender,
  r: Recipient,
  message: PushMessage,
): Promise<{ sent: number; failed: number; gone: number; devices: number; error?: string }> {
  const subs = (await activePushSubscriptions(q, r)).filter(
    (s) => s.brandUserId === null || brandNotificationEnabled(s.prefs, message.template, 'PUSH'),
  );
  const body = JSON.stringify(message);
  let sent = 0;
  let failed = 0;
  let gone = 0;
  let error: string | undefined;
  for (const s of subs) {
    try {
      if ((await push.send(s, body)) === 'GONE') {
        gone++;
        await markSubscriptionGone(q, s.id);
      } else sent++;
    } catch (err) {
      failed++;
      error = errorText(err);
    }
  }
  return { sent, failed, gone, devices: subs.length, ...(error ? { error } : {}) };
}

async function deliverPush<T extends NotificationTemplate>(
  q: Queryable,
  push: PushSender | null,
  r: Recipient,
  template: T,
  payload: NotificationPayloads[T],
  tag: string,
): Promise<Outcome> {
  if (!push) return { record: { skipped: 'PUSH_OFF' }, done: true };
  const out = await pushToRecipient(q, push, r, notificationPush(template, payload, tag));
  if (out.devices === 0) return { record: { skipped: 'NO_DEVICE' }, done: true };
  const { devices: _devices, ...record } = out;
  return { record, done: out.sent > 0 || out.failed === 0 };
}
