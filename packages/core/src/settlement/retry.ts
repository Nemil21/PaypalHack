import type { ListingStatus } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Db } from '../db.js';
import type { Actor } from '../money/deps.js';
import { markKicked, type KickSettlement } from './outbox.js';

/**
 * `POST /api/admin/listings/:id/retry-settlement` (HF-030a, api.md §Ops). Admin only (the route
 * checks `ADMIN_EMAILS`); audited. It only touches rows the coordinator would pick up anyway:
 * RETRY rows become due now, and RUNNING rows whose lease already expired are left claimable.
 * FAILED rows are never reopened. Refused once the listing left CLEARING (SETTLED and later).
 */

export type RetrySettlementOutcome =
  | {
      ok: true;
      listingId: string;
      runId: string;
      /** RETRY rows made due now. */
      retried: number;
      /** RUNNING rows with an expired lease (claimable by the next pass). */
      staleRunning: number;
      /** False when a coordinator holds a live lease on the run: it picks the rows up itself. */
      kicked: boolean;
    }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'STATE_CONFLICT'; reason: 'NOT_CLEARING'; status: ListingStatus };

export async function retrySettlement(
  deps: { db: Db; kickSettlement?: KickSettlement },
  input: { listingId: string; actor: Actor },
): Promise<RetrySettlementOutcome> {
  const out = await deps.db.tx(async (tx) => {
    const listing = (
      await tx.query(`SELECT status FROM listings WHERE id = $1 FOR UPDATE`, [input.listingId])
    ).rows[0] as { status: ListingStatus } | undefined;
    if (!listing) return { ok: false as const, code: 'NOT_FOUND' as const };
    const run = (
      await tx.query(
        `SELECT id, status, lease_until < now() AS lease_expired
           FROM settlement_runs WHERE listing_id = $1 FOR UPDATE`,
        [input.listingId],
      )
    ).rows[0] as { id: string; status: string; lease_expired: boolean | null } | undefined;
    if (listing.status !== 'CLEARING' || !run) {
      return {
        ok: false as const,
        code: 'STATE_CONFLICT' as const,
        reason: 'NOT_CLEARING' as const,
        status: listing.status,
      };
    }
    const retried = await tx.query(
      `UPDATE settlements SET next_attempt_at = now()
        WHERE listing_id = $1 AND status = 'RETRY'`,
      [input.listingId],
    );
    const stale = (
      await tx.query(
        `SELECT count(*)::int AS n FROM settlements
          WHERE listing_id = $1 AND status = 'RUNNING' AND lease_until < now()`,
        [input.listingId],
      )
    ).rows[0] as { n: number };
    // A live coordinator polls for due rows itself; otherwise reopen the run for a kick.
    const live = run.status === 'RUNNING' && run.lease_expired === false;
    if (run.status === 'DONE') {
      // Defensive: DONE is only written after SETTLED, but never strand a CLEARING listing.
      await tx.query(`UPDATE settlement_runs SET status = 'PENDING' WHERE id = $1`, [run.id]);
    }
    await audit(tx, {
      actorType: 'ADMIN',
      actorId: input.actor.id ?? null,
      listingId: input.listingId,
      entity: 'listing',
      entityId: input.listingId,
      action: 'SETTLEMENT_RETRY_REQUESTED',
      data: {
        runId: run.id,
        retried: retried.rowCount ?? 0,
        staleRunning: stale.n,
        coordinatorLive: live,
      },
    });
    return {
      ok: true as const,
      listingId: input.listingId,
      runId: run.id,
      retried: retried.rowCount ?? 0,
      staleRunning: stale.n,
      kicked: !live,
    };
  });

  if (out.ok && out.kicked && deps.kickSettlement) {
    await markKicked(deps.db.pool, out.runId);
    await deps.kickSettlement({ runId: out.runId, listingId: out.listingId });
  }
  if (out.ok && !deps.kickSettlement) return { ...out, kicked: false };
  return out;
}
