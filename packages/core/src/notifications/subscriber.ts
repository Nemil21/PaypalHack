import type { Db } from '../db.js';
import { draftsForAuditEvent, isNotifyEvent, type AuditEventLike } from './from-audit.js';
import { notify, type NotifiedRow } from './notify.js';
import { scanTimedNotifications } from './timed.js';

/**
 * `notify()` as an audit-event subscriber (HF-054a; features/13 §Logic). A cron job reads
 * `audit_events` after the money transactions committed and writes deduped notifications, so the
 * money tracks never call it and a failed notification can never roll back money.
 *
 * Cursor: `notification_cursor.last_event_id` only moves past an id once every lower id is
 * either seen or a gap old enough to be a rolled-back insert. `audit_events.id` is a sequence, so
 * a transaction still in flight can commit a lower id after a higher one: the cursor waits at
 * that gap (up to `gapGraceMs`) while the rows after it are still handled. Rows handled more than
 * once (overlap, a restart, a second instance) are harmless: `notifications.dedupe_key` is UNIQUE.
 */

export const NOTIFY_INTERVAL_MS = 5_000;
/** How long a hole in `audit_events.id` may be an in-flight transaction before we skip it. */
export const NOTIFY_GAP_GRACE_MS = 60_000;
/** A mapping that keeps failing on one event is skipped after this many tries. */
export const NOTIFY_MAX_ATTEMPTS = 3;

export interface NotifySubscriberOptions {
  batchSize?: number;
  gapGraceMs?: number;
  now?: () => number;
  onError?: (err: unknown, event: { id: string; action: string }) => void;
}

export interface NotifyRunResult {
  /** Audit rows read this run. */
  scanned: number;
  /** Notifications created (deduped rows are not counted). */
  created: NotifiedRow[];
  /** The cursor after this run. */
  cursor: string;
}

export interface NotifySubscriber {
  run(): Promise<NotifyRunResult>;
}

type Row = AuditEventLike;

/**
 * One subscriber per process. Its memory (gaps first seen, ids handled past the cursor, failing
 * events) is an optimisation only; a fresh subscriber re-reads from the stored cursor.
 */
export function createNotifySubscriber(
  db: Pick<Db, 'pool'>,
  opts: NotifySubscriberOptions = {},
): NotifySubscriber {
  const batch = opts.batchSize ?? 500;
  const grace = opts.gapGraceMs ?? NOTIFY_GAP_GRACE_MS;
  const now = opts.now ?? Date.now;
  const gapSeen = new Map<string, number>();
  const handled = new Set<string>();
  const failures = new Map<string, number>();

  async function handle(e: Row): Promise<NotifiedRow[] | 'FAILED'> {
    try {
      const drafts = await draftsForAuditEvent(db.pool, e);
      const out: NotifiedRow[] = [];
      for (const d of drafts) {
        const row = await notify(db.pool, d);
        if (row) out.push(row);
      }
      return out;
    } catch (err) {
      opts.onError?.(err, { id: e.id, action: e.action });
      const n = (failures.get(e.id) ?? 0) + 1;
      failures.set(e.id, n);
      return n >= NOTIFY_MAX_ATTEMPTS ? [] : 'FAILED';
    }
  }

  return {
    async run() {
      const cur = await db.pool.query(
        `SELECT last_event_id::text AS id FROM notification_cursor WHERE id`,
      );
      const start = BigInt((cur.rows[0] as { id: string } | undefined)?.id ?? '0');
      // All actions (not only the ones we map) so that holes in the id sequence are visible.
      const res = await db.pool.query(
        `SELECT id::text AS id, action, entity, entity_id, listing_id, data
           FROM audit_events WHERE id > $1 ORDER BY id LIMIT $2`,
        [start.toString(), batch],
      );
      const rows = res.rows as Row[];
      const created: NotifiedRow[] = [];
      let safe = start;
      let blocked = false;
      let expected = start + 1n;
      for (const e of rows) {
        const id = BigInt(e.id);
        if (id !== expected && !blocked) {
          const key = `${expected}-${id - 1n}`;
          const first = gapSeen.get(key) ?? now();
          gapSeen.set(key, first);
          if (now() - first < grace) blocked = true;
          else gapSeen.delete(key);
        }
        expected = id + 1n;
        if (!handled.has(e.id)) {
          const out = isNotifyEvent(e) ? await handle(e) : [];
          if (out === 'FAILED') {
            blocked = true;
          } else {
            created.push(...out);
            handled.add(e.id);
            failures.delete(e.id);
          }
        }
        if (!blocked) safe = id;
      }
      if (safe > start) {
        await db.pool.query(
          `UPDATE notification_cursor SET last_event_id = GREATEST(last_event_id, $1::bigint) WHERE id`,
          [safe.toString()],
        );
        for (const id of handled) if (BigInt(id) <= safe) handled.delete(id);
      }
      return { scanned: rows.length, created, cursor: safe.toString() };
    },
  };
}

/** The time-based scan (`scanTimedNotifications`) runs at most this often. */
export const NOTIFY_TIMED_SCAN_MS = 60_000;

/**
 * The `notify` cron job (HF-034 runner): drain the audit subscriber, and once a minute look for
 * windows closing within 12 h / 6 h. Returns only `{ notified }` (see `CRON_JOB_IDS.notify`).
 */
export function createNotifyJob(
  db: Pick<Db, 'pool'>,
  opts: NotifySubscriberOptions & { timedScanMs?: number } = {},
): () => Promise<{ notified: number }> {
  const subscriber = createNotifySubscriber(db, opts);
  const now = opts.now ?? Date.now;
  const every = opts.timedScanMs ?? NOTIFY_TIMED_SCAN_MS;
  let lastScan = -Infinity;
  return async () => {
    const { created } = await subscriber.run();
    let notified = created.length;
    if (now() - lastScan >= every) {
      lastScan = now();
      notified += (await scanTimedNotifications(db.pool)).length;
    }
    return { notified };
  };
}
