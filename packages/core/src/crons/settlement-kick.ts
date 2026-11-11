import type { Db, Queryable } from '../db.js';
import {
  markKicked,
  SETTLEMENT_KICK_STALE_SECONDS,
  type KickSettlement,
  type SettlementRunRef,
} from '../settlement/outbox.js';

/**
 * Settlement kick (HF-034, B6). Re-runs `settleListing` (HF-030a) for:
 * - unstarted `settlement_runs` (PENDING, never kicked or kicked > 30 s ago): a crash between
 *   Clear's COMMIT and the coordinator starting;
 * - RUNNING runs whose lease expired (a coordinator died);
 * - CLEARING listings with a QUEUED settlement older than 60 s or a RUNNING one whose lease
 *   expired, unless a coordinator holds a live lease on the run. A DONE run on such a listing is
 *   reopened (defensive; DONE is only written after SETTLED).
 *
 * Kicking twice is safe: `settleListing` claims the run under a lease (a second kick is `BUSY`)
 * and settlement rows reuse their PayPal request ids.
 */

/** A QUEUED settlement older than this on a CLEARING listing means nobody is running it. */
export const STALE_QUEUED_SECONDS = 60;

export async function settlementKickTargets(
  q: Queryable,
  opts: { staleSeconds?: number; staleQueuedSeconds?: number } = {},
): Promise<SettlementRunRef[]> {
  const staleRun = opts.staleSeconds ?? SETTLEMENT_KICK_STALE_SECONDS;
  const staleQueued = opts.staleQueuedSeconds ?? STALE_QUEUED_SECONDS;
  // Reopen DONE runs on listings that are still CLEARING with work left.
  await q.query(
    `UPDATE settlement_runs r SET status = 'PENDING', lease_until = NULL
       FROM listings l
      WHERE l.id = r.listing_id AND l.status = 'CLEARING' AND r.status = 'DONE'
        AND EXISTS (SELECT 1 FROM settlements s
                     WHERE s.listing_id = l.id AND s.status IN ('QUEUED', 'RUNNING', 'RETRY'))`,
  );
  const res = await q.query(
    `SELECT r.id, r.listing_id
       FROM settlement_runs r JOIN listings l ON l.id = r.listing_id
      WHERE (r.status = 'PENDING'
             AND (r.kicked_at IS NULL OR r.kicked_at < now() - make_interval(secs => $1)))
         OR (r.status = 'RUNNING' AND r.lease_until < now())
         OR (l.status = 'CLEARING'
             AND r.status <> 'DONE'
             AND NOT (r.status = 'RUNNING' AND r.lease_until >= now())
             AND EXISTS (SELECT 1 FROM settlements s
                          WHERE s.listing_id = l.id
                            AND ((s.status = 'QUEUED'
                                  AND s.created_at < now() - make_interval(secs => $2))
                                 OR (s.status = 'RUNNING' AND s.lease_until < now()))))
      ORDER BY r.created_at, r.id`,
    [staleRun, staleQueued],
  );
  return (res.rows as Array<{ id: string; listing_id: string }>).map((r) => ({
    runId: r.id,
    listingId: r.listing_id,
  }));
}

export interface KickSettlementsResult {
  kicked: number;
  failed: number;
}

/** One kick pass. `kick` may be fire-and-forget (the in-process runner) or awaited (tests). */
export async function kickSettlements(
  deps: { db: Pick<Db, 'pool'>; kick: KickSettlement },
  opts: {
    staleSeconds?: number;
    staleQueuedSeconds?: number;
    onError?: (err: unknown, run: SettlementRunRef) => void;
  } = {},
): Promise<KickSettlementsResult> {
  const runs = await settlementKickTargets(deps.db.pool, opts);
  const out: KickSettlementsResult = { kicked: 0, failed: 0 };
  for (const run of runs) {
    try {
      await markKicked(deps.db.pool, run.runId);
      await deps.kick(run);
      out.kicked++;
    } catch (err) {
      out.failed++;
      opts.onError?.(err, run);
    }
  }
  return out;
}
