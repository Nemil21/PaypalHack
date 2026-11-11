import type { Queryable } from '../db.js';
import { PayPalRestClient } from '../paypal/client.js';
import type { PayPalClient } from '../paypal/types.js';
import { CHANNEL3_OUTAGE_FAILURES, readChannel3Health } from '../price-watch/health.js';
import { CAPTURE_RECONCILE_STALE_HOURS, lastCaptureReconcile } from './capture-reconcile.js';

/**
 * W20 health panel (HF-058; api.md §Ops `GET /admin/health`): PayPal token, Channel3
 * reachability, settlement queue depth, webhooks received in the last hour, and the alerts ops
 * must act on (sweeper `VOID_STUCK` bids, the last capture reconcile's mismatches). The public
 * `/healthz` (HF-048a) stays the liveness probe; this is the admin view.
 *
 * The alerts tile is also red when the last capture reconcile had failed PayPal GETs or is older
 * than 25 h. Each tile has `ok`; `status` is `degraded` when any tile is not ok (W20 shows red tiles).
 */

/** A RUNNING settlement whose lease expired this long ago is stuck, not busy. */
export const OPS_STALE_RUNNING_SECONDS = 120;
/** QUEUED / RETRY due for this long without being claimed means the runner isn't kicking. */
export const OPS_QUEUE_STALL_SECONDS = 5 * 60;
export const OPS_PAYPAL_TOKEN_TIMEOUT_MS = 5_000;

export type PayPalTokenProbe = () => Promise<unknown>;

/**
 * Mint (or reuse the cached) OAuth token: the cheapest call that proves the PayPal credentials
 * work. Undefined for a client that isn't the REST client (tests' bare stubs).
 */
export function paypalTokenProbe(client: PayPalClient): PayPalTokenProbe | undefined {
  return client instanceof PayPalRestClient ? () => client.http.token() : undefined;
}

export interface OpsHealthDeps {
  db: Queryable;
  paypalToken?: PayPalTokenProbe;
  paypalMode: string;
  tokenTimeoutMs?: number;
}

export interface OpsHealth {
  status: 'healthy' | 'degraded';
  checkedAt: string;
  paypal: { ok: boolean; mode: string; ms: number | null; error: string | null };
  channel3: {
    ok: boolean;
    lastOkAt: string | null;
    lastEventAt: string | null;
    consecutiveFailures: number;
    outageSince: string | null;
    lastError: string | null;
  };
  settlementQueue: {
    ok: boolean;
    /** QUEUED + RUNNING + RETRY. */
    depth: number;
    queued: number;
    running: number;
    retry: number;
    /** RUNNING with a lease expired more than 2 min ago. */
    staleRunning: number;
    /** QUEUED / RETRY due for more than 5 min. */
    stalled: number;
    failedLast24h: number;
  };
  webhooks: {
    ok: boolean;
    lastHour: { paypal: number; channel3: number; replayed: number };
    unprocessed: number;
    failing: number;
    lastReceivedAt: string | null;
  };
  alerts: {
    ok: boolean;
    /** Bids the sweeper gave up on (`VOID_STUCK`) that are still not VOIDED. */
    voidStuck: number;
    lastReconcile: {
      at: string;
      checked: number;
      matched: number;
      /** PayPal GETs that failed: the run could not check everything. */
      failed: number;
      mismatches: number;
      /** Older than 25 h: the nightly reconcile is not running. */
      stale: boolean;
    } | null;
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function readOpsHealth(deps: OpsHealthDeps): Promise<OpsHealth> {
  const [paypal, c3, queue, hooks, stuck, reconcile] = await Promise.all([
    probePayPal(deps),
    readChannel3Health(deps.db),
    deps.db.query<{
      queued: number;
      running: number;
      retry: number;
      stale_running: number;
      stalled: number;
      failed_24h: number;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
              count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
              count(*) FILTER (WHERE status = 'RETRY')::int AS retry,
              count(*) FILTER (WHERE status = 'RUNNING'
                                 AND lease_until < now() - make_interval(secs => $1))::int
                AS stale_running,
              count(*) FILTER (WHERE (status = 'QUEUED'
                                      AND created_at < now() - make_interval(secs => $2))
                                  OR (status = 'RETRY'
                                      AND next_attempt_at < now() - make_interval(secs => $2)))::int
                AS stalled,
              count(*) FILTER (WHERE status = 'FAILED'
                                 AND updated_at > now() - interval '24 hours')::int AS failed_24h
         FROM settlements
        WHERE status IN ('QUEUED', 'RUNNING', 'RETRY')
           OR (status = 'FAILED' AND updated_at > now() - interval '24 hours')`,
      [OPS_STALE_RUNNING_SECONDS, OPS_QUEUE_STALL_SECONDS],
    ),
    deps.db.query<{
      paypal: number;
      channel3: number;
      replayed: number;
      unprocessed: number;
      failing: number;
      last_received_at: Date | null;
    }>(
      `SELECT count(*) FILTER (WHERE provider = 'PAYPAL' AND received_at > now() - interval '1 hour')::int
                AS paypal,
              count(*) FILTER (WHERE provider = 'CHANNEL3' AND received_at > now() - interval '1 hour')::int
                AS channel3,
              count(*) FILTER (WHERE received_at > now() - interval '1 hour'
                                 AND (payload->>'replayed')::boolean IS TRUE)::int AS replayed,
              count(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed,
              count(*) FILTER (WHERE processed_at IS NULL AND last_error IS NOT NULL)::int
                AS failing,
              max(received_at) AS last_received_at
         FROM webhook_events`,
    ),
    deps.db.query<{ n: number }>(
      `SELECT count(DISTINCT a.entity_id)::int AS n
         FROM audit_events a JOIN bids b ON b.id = a.entity_id
        WHERE a.entity = 'bid' AND a.action = 'VOID_STUCK' AND b.status <> 'VOIDED'`,
    ),
    lastCaptureReconcile(deps.db),
  ]);

  const q = queue.rows[0]!;
  const h = hooks.rows[0]!;
  const voidStuck = stuck.rows[0]?.n ?? 0;
  const channel3Ok = !c3.outageSince && c3.consecutiveFailures < CHANNEL3_OUTAGE_FAILURES;
  const queueOk = q.stale_running === 0 && q.stalled === 0;
  // Unprocessed rows are retried every minute; ones that keep failing need a look.
  const webhooksOk = h.failing === 0;
  const reconcileStale = !!reconcile && reconcile.ageSeconds > CAPTURE_RECONCILE_STALE_HOURS * 3600;
  // Red too when the safety net itself is down: the last run could not reach PayPal, or no run
  // for over a day (D19).
  const alertsOk =
    voidStuck === 0 &&
    (reconcile?.mismatches ?? 0) === 0 &&
    (reconcile?.failed ?? 0) === 0 &&
    !reconcileStale;

  const health: OpsHealth = {
    status: 'healthy',
    checkedAt: new Date().toISOString(),
    paypal: { ...paypal, mode: deps.paypalMode },
    channel3: {
      ok: channel3Ok,
      lastOkAt: iso(c3.lastOkAt),
      lastEventAt: iso(c3.lastEventAt),
      consecutiveFailures: c3.consecutiveFailures,
      outageSince: iso(c3.outageSince),
      lastError: c3.lastError,
    },
    settlementQueue: {
      ok: queueOk,
      depth: q.queued + q.running + q.retry,
      queued: q.queued,
      running: q.running,
      retry: q.retry,
      staleRunning: q.stale_running,
      stalled: q.stalled,
      failedLast24h: q.failed_24h,
    },
    webhooks: {
      ok: webhooksOk,
      lastHour: { paypal: h.paypal, channel3: h.channel3, replayed: h.replayed },
      unprocessed: h.unprocessed,
      failing: h.failing,
      lastReceivedAt: iso(h.last_received_at),
    },
    alerts: {
      ok: alertsOk,
      voidStuck,
      lastReconcile: reconcile
        ? {
            at: reconcile.at.toISOString(),
            checked: reconcile.checked,
            matched: reconcile.matched,
            failed: reconcile.failed,
            mismatches: reconcile.mismatches,
            stale: reconcileStale,
          }
        : null,
    },
  };
  const tiles = [health.paypal, health.channel3, health.settlementQueue, health.webhooks];
  if (tiles.some((t) => !t.ok) || !alertsOk) health.status = 'degraded';
  return health;
}

async function probePayPal(
  deps: OpsHealthDeps,
): Promise<{ ok: boolean; ms: number | null; error: string | null }> {
  if (!deps.paypalToken) return { ok: false, ms: null, error: 'PayPal client not configured' };
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      deps.paypalToken(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out')),
          deps.tokenTimeoutMs ?? OPS_PAYPAL_TOKEN_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, ms: Date.now() - t0, error: null };
  } catch (err) {
    // The client's errors carry an op, status and issue code only; never a secret or token.
    return { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
