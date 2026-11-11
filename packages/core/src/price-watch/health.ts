import { audit } from '../audit.js';
import type { Db, Queryable } from '../db.js';
import type { Channel3Client } from '../channel3/client.js';
import { isChannel3Error } from '../channel3/errors.js';
import { emit } from '../money/emit.js';
import { CLOSABLE_LISTING_STATUSES } from '../money/locks.js';
import { WATCHER_ACTOR } from './process.js';

/**
 * The Channel3-outage banner (HF-042b; features/06 §Edge cases "Channel3 outage"). Channel3 sends
 * no heartbeat and only fires events on a change (it re-scrapes each subscribed product daily), so
 * the heartbeat is ours: the `channel3-probe` cron calls the free detail endpoint for a watched
 * product every 5 minutes. The nightly poll's calls count too, and a verified webhook delivery
 * stamps `last_event_at`.
 *
 * Channel3 is "down" when the last `CHANNEL3_OUTAGE_FAILURES` calls in a row failed, or nothing
 * succeeded (call or delivery) for `CHANNEL3_OUTAGE_WINDOW_MS`. Then every live (OPEN/ROUNDS)
 * listing on a Channel3 product gets `price_watch_paused_at`, and the console and offer page show
 * "Public price check paused". One successful call clears every flag. Each change emits
 * `listing.updated` (clients re-fetch) and is audited `PRICE_WATCH_PAUSED` / `PRICE_WATCH_RESUMED`.
 */

export const CHANNEL3_OUTAGE_FAILURES = 3;
export const CHANNEL3_OUTAGE_WINDOW_MS = 30 * 60_000;
export const CHANNEL3_PROBE_INTERVAL_MS = 5 * 60_000;

export interface Channel3Health {
  lastOkAt: Date | null;
  lastEventAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  outageSince: Date | null;
  /** Database time when read. */
  now: Date;
}

export interface OutageOptions {
  failures?: number;
  windowMs?: number;
}

export async function readChannel3Health(q: Queryable): Promise<Channel3Health> {
  const { rows } = await q.query<{
    last_ok_at: Date | null;
    last_event_at: Date | null;
    last_failure_at: Date | null;
    consecutive_failures: number;
    last_error: string | null;
    outage_since: Date | null;
    now: Date;
  }>(
    `SELECT last_ok_at, last_event_at, last_failure_at, consecutive_failures, last_error,
            outage_since, now() AS now
       FROM channel3_health WHERE id`,
  );
  const r = rows[0];
  return {
    lastOkAt: r?.last_ok_at ?? null,
    lastEventAt: r?.last_event_at ?? null,
    lastFailureAt: r?.last_failure_at ?? null,
    consecutiveFailures: r?.consecutive_failures ?? 0,
    lastError: r?.last_error ?? null,
    outageSince: r?.outage_since ?? null,
    now: r?.now ?? new Date(),
  };
}

/** A successful Channel3 API call: resets the failure streak. */
export async function recordChannel3Ok(q: Queryable): Promise<void> {
  await q.query(
    `UPDATE channel3_health SET last_ok_at = now(), consecutive_failures = 0, last_error = NULL
      WHERE id`,
  );
}

/** A verified webhook delivery: proof Channel3 reaches us (not that our calls work). */
export async function recordChannel3Event(q: Queryable): Promise<void> {
  await q.query(`UPDATE channel3_health SET last_event_at = now() WHERE id`);
}

export async function recordChannel3Failure(q: Queryable, err: unknown): Promise<void> {
  const message = isChannel3Error(err)
    ? `${err.kind}: ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
  await q.query(
    `UPDATE channel3_health
        SET last_failure_at = now(), consecutive_failures = consecutive_failures + 1,
            last_error = $1
      WHERE id`,
    [message.slice(0, 500)],
  );
}

/** The outage rule, on database time. */
export function isChannel3Down(h: Channel3Health, opts: OutageOptions = {}): boolean {
  if (h.consecutiveFailures >= (opts.failures ?? CHANNEL3_OUTAGE_FAILURES)) return true;
  const last = Math.max(h.lastOkAt?.getTime() ?? 0, h.lastEventAt?.getTime() ?? 0);
  // Never in contact yet (fresh database): the failure streak decides.
  if (last === 0) return false;
  return h.now.getTime() - last > (opts.windowMs ?? CHANNEL3_OUTAGE_WINDOW_MS);
}

export interface PauseSync {
  down: boolean;
  paused: string[];
  resumed: string[];
}

/** Set or clear `price_watch_paused_at` on live Channel3 listings from the health row. */
export async function syncPriceWatchPause(
  deps: { db: Pick<Db, 'tx'> },
  opts: OutageOptions = {},
): Promise<PauseSync> {
  return deps.db.tx(async (tx) => {
    // Row lock: two instances never flip the same flags at once.
    await tx.query(`SELECT 1 FROM channel3_health WHERE id FOR UPDATE`);
    const health = await readChannel3Health(tx);
    const down = isChannel3Down(health, opts);
    await tx.query(
      down
        ? `UPDATE channel3_health SET outage_since = coalesce(outage_since, now()) WHERE id`
        : `UPDATE channel3_health SET outage_since = NULL WHERE id AND outage_since IS NOT NULL`,
    );
    const { rows } = down
      ? await tx.query<{ id: string; quantity: number }>(
          `UPDATE listings l SET price_watch_paused_at = now()
             FROM products p
            WHERE p.id = l.product_id AND p.channel3_id IS NOT NULL
              AND l.status = ANY($1::text[]) AND l.price_watch_paused_at IS NULL
           RETURNING l.id, l.quantity`,
          [CLOSABLE_LISTING_STATUSES],
        )
      : await tx.query<{ id: string; quantity: number }>(
          `UPDATE listings SET price_watch_paused_at = NULL
            WHERE price_watch_paused_at IS NOT NULL
           RETURNING id, quantity`,
        );
    const at = health.now.toISOString();
    for (const l of rows) {
      await audit(tx, {
        actorType: WATCHER_ACTOR.type,
        actorId: WATCHER_ACTOR.id,
        listingId: l.id,
        entity: 'listing',
        entityId: l.id,
        action: down ? 'PRICE_WATCH_PAUSED' : 'PRICE_WATCH_RESUMED',
        data: down
          ? {
              reason: 'CHANNEL3_UNREACHABLE',
              consecutiveFailures: health.consecutiveFailures,
              lastOkAt: health.lastOkAt?.toISOString() ?? null,
              lastError: health.lastError,
            }
          : {},
      });
      // Ids-only notice; the console and offer page re-fetch and show or hide the banner.
      await emit(tx, l.id, {
        type: 'listing.updated',
        listingId: l.id,
        at,
        previousQuantity: l.quantity,
        quantity: l.quantity,
      });
    }
    const ids = rows.map((r) => r.id).sort();
    return { down, paused: down ? ids : [], resumed: down ? [] : ids };
  });
}

export interface ProbeDeps {
  db: Pick<Db, 'pool' | 'tx'>;
  channel3: Pick<Channel3Client, 'product'>;
}

export interface ProbeResult {
  /** The Channel3 product called, or null when no live listing is watched. */
  probed: string | null;
  ok: boolean;
  paused: string[];
  resumed: string[];
}

/**
 * The `channel3-probe` cron (every 5 min): one free detail call for the watched product checked
 * longest ago, then `syncPriceWatchPause`. A `NOT_FOUND` is an answer (Channel3 is up); any other
 * Channel3 error is a failure. Nothing watched → no call, flags still synced.
 */
export async function probeChannel3(
  deps: ProbeDeps,
  opts: OutageOptions = {},
): Promise<ProbeResult> {
  const { rows } = await deps.db.pool.query<{ channel3_id: string }>(
    `SELECT p.channel3_id
       FROM listings l JOIN products p ON p.id = l.product_id
      WHERE l.status = ANY($1::text[]) AND p.channel3_id IS NOT NULL
      ORDER BY p.price_updated_at ASC NULLS FIRST, p.id
      LIMIT 1`,
    [CLOSABLE_LISTING_STATUSES],
  );
  const target = rows[0]?.channel3_id ?? null;
  let ok = true;
  if (target) {
    ok = await checkChannel3Call(deps.db.pool, () => deps.channel3.product(target));
  }
  const sync = await syncPriceWatchPause(deps, opts);
  return { probed: target, ok, paused: sync.paused, resumed: sync.resumed };
}

/**
 * Run one Channel3 call and record it in `channel3_health`. True when Channel3 answered
 * (`NOT_FOUND` included). Non-Channel3 errors (bugs) are rethrown, not counted.
 */
export async function checkChannel3Call(
  q: Queryable,
  call: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await call();
  } catch (err) {
    if (!isChannel3Error(err)) throw err;
    if (err.kind !== 'NOT_FOUND') {
      await recordChannel3Failure(q, err);
      return false;
    }
  }
  await recordChannel3Ok(q);
  return true;
}
