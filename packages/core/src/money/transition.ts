import type { BidStatus, ListingStatus, PayoutStatus, SettlementStatus } from '@holdfast/shared';
import type { Queryable } from '../db.js';

/** Status values from the CHECK constraints in db/migrations that `@holdfast/shared` does not export. */
export const MANDATE_STATUSES = ['ACTIVE', 'PAUSED', 'FULFILLED', 'EXPIRED'] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

export const SETTLEMENT_RUN_STATUSES = ['PENDING', 'RUNNING', 'DONE'] as const;
export type SettlementRunStatus = (typeof SETTLEMENT_RUN_STATUSES)[number];

/** Tables with a status state machine, and the statuses each allows. */
export interface StatusByTable {
  listings: ListingStatus;
  bids: BidStatus;
  mandates: MandateStatus;
  settlements: SettlementStatus;
  settlement_runs: SettlementRunStatus;
  payouts: PayoutStatus;
}
export type StatusTable = keyof StatusByTable;

const STATUS_TABLES: ReadonlySet<string> = new Set<StatusTable>([
  'listings',
  'bids',
  'mandates',
  'settlements',
  'settlement_runs',
  'payouts',
]);

/** Use as a value in `extra` to set a column to the database's `now()`. */
export const SQL_NOW: unique symbol = Symbol('SQL_NOW');

export type TransitionExtra = Record<string, unknown>;

const COLUMN = /^[a-z][a-z0-9_]*$/;
const RESERVED = new Set(['id', 'status', 'created_at', 'updated_at']);

/**
 * Build `SET status=$n, col=$m, …` from `extra`. Column names are checked against a strict
 * identifier pattern and quoted; values are always parameters (or `now()` for `SQL_NOW`).
 */
export function setClause(extra: TransitionExtra, params: unknown[]): string[] {
  const parts: string[] = [];
  for (const [col, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (!COLUMN.test(col) || RESERVED.has(col)) throw new Error(`transition: bad column "${col}"`);
    if (value === SQL_NOW) {
      parts.push(`"${col}" = now()`);
    } else {
      params.push(value);
      parts.push(`"${col}" = $${params.length}`);
    }
  }
  return parts;
}

/**
 * Conditional status update (data-model rule 1):
 * `UPDATE <table> SET status=$to, … WHERE id=$id AND status = ANY($from) RETURNING *`.
 *
 * Returns the updated row, or `null` when zero rows matched: someone else won the race (or the
 * row is not in `from`), and the caller must stop. Never write a raw `UPDATE … SET status`
 * without the `WHERE status` guard; use this.
 */
export async function transition<T extends StatusTable, Row = Record<string, unknown>>(
  q: Queryable,
  table: T,
  id: string,
  from: StatusByTable[T] | readonly StatusByTable[T][],
  to: StatusByTable[T],
  extra: TransitionExtra = {},
): Promise<Row | null> {
  if (!STATUS_TABLES.has(table)) throw new Error(`transition: unknown table "${String(table)}"`);
  const fromList = (Array.isArray(from) ? from : [from]) as string[];
  if (fromList.length === 0) throw new Error('transition: `from` must name at least one status');
  const params: unknown[] = [id, fromList, to];
  const sets = [`status = $3`, ...setClause(extra, params)];
  const res = await q.query(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
    params,
  );
  return (res.rows[0] as Row | undefined) ?? null;
}
