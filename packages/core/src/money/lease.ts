import type { Queryable } from '../db.js';
import { setClause, type StatusByTable, type TransitionExtra } from './transition.js';

/** Tables whose rows are worked under a lease (D11, INV-8). */
export type LeaseTable = 'settlements' | 'settlement_runs';

/** Statuses a worker may claim from, besides an expired RUNNING lease. */
const CLAIMABLE: { [T in LeaseTable]: readonly StatusByTable[T][] } = {
  settlements: ['QUEUED', 'RETRY'],
  settlement_runs: ['PENDING'],
};

export const DEFAULT_LEASE_SECONDS = 60;

/**
 * A claimed row. `token` is the row's `attempts` after the claim: it fences renew / release, so a
 * worker whose lease expired and was taken over can no longer touch the row.
 */
export interface Lease<Row = Record<string, unknown>> {
  table: LeaseTable;
  id: string;
  token: number;
  row: Row;
}

/**
 * Claim a row for work:
 * `UPDATE … SET status='RUNNING', lease_until=now()+60s, attempts=attempts+1 WHERE id=$1 AND
 * (status IN ('QUEUED','RETRY') OR (status='RUNNING' AND lease_until < now())) RETURNING *`
 * (`'PENDING'` instead of QUEUED/RETRY for `settlement_runs`). Null when another worker holds a
 * live lease or the row is finished. Taking over is safe because PayPal request ids are reused.
 */
export async function claim<Row extends { attempts: number } = { attempts: number }>(
  q: Queryable,
  table: LeaseTable,
  id: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<Lease<Row> | null> {
  const res = await q.query(
    `UPDATE ${tableName(table)}
        SET status = 'RUNNING',
            lease_until = now() + make_interval(secs => $3),
            attempts = attempts + 1
      WHERE id = $1
        AND (status = ANY($2::text[]) OR (status = 'RUNNING' AND lease_until < now()))
      RETURNING *`,
    [id, CLAIMABLE[table], leaseSeconds],
  );
  const row = res.rows[0] as Row | undefined;
  return row ? { table, id, token: row.attempts, row } : null;
}

/** Extend a live lease. False if the lease was lost (expired and taken over, or released). */
export async function renew(
  q: Queryable,
  lease: Lease<unknown>,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  const res = await q.query(
    `UPDATE ${tableName(lease.table)}
        SET lease_until = now() + make_interval(secs => $3)
      WHERE id = $1 AND status = 'RUNNING' AND attempts = $2`,
    [lease.id, lease.token, leaseSeconds],
  );
  return res.rowCount === 1;
}

/**
 * Finish with a row: RUNNING → `to` (e.g. SUCCEEDED, RETRY, FAILED, DONE), clearing the lease,
 * only if this worker still holds it. Returns the row, or null if the lease was lost.
 */
export async function release<T extends LeaseTable, Row = Record<string, unknown>>(
  q: Queryable,
  lease: Lease<unknown> & { table: T },
  to: StatusByTable[T],
  extra: TransitionExtra = {},
): Promise<Row | null> {
  const params: unknown[] = [lease.id, lease.token, to];
  const sets = ['status = $3', 'lease_until = NULL', ...setClause(extra, params)];
  const res = await q.query(
    `UPDATE ${tableName(lease.table)} SET ${sets.join(', ')}
      WHERE id = $1 AND status = 'RUNNING' AND attempts = $2
      RETURNING *`,
    params,
  );
  return (res.rows[0] as Row | undefined) ?? null;
}

function tableName(table: LeaseTable): LeaseTable {
  if (!(table in CLAIMABLE)) throw new Error(`lease: unknown table "${String(table)}"`);
  return table;
}
