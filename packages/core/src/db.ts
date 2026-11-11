import pg from 'pg';
import type { Config } from './config.js';

/**
 * Postgres pool factory and the `db.tx(fn)` transaction helper (HF-003a).
 * The schema and migrations are HF-002 (`db/migrations`, `npm run migrate`).
 */
export function createPool(config: Pick<Config, 'DATABASE_URL'>, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: config.DATABASE_URL, max });
}

/** Anything that can run a query: a pool, a client, or a transaction. */
export type Queryable = Pick<pg.ClientBase, 'query'>;

/** A connection with an open transaction, handed to the `db.tx` callback. */
export type Tx = pg.PoolClient;

export interface Db {
  readonly pool: pg.Pool;
  /**
   * Run `fn` in one transaction on a dedicated connection: COMMIT when it resolves, ROLLBACK when
   * it throws (the error is rethrown). Never call PayPal inside `fn` (INV-1).
   */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export function createDb(pool: pg.Pool): Db {
  return {
    pool,
    async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken: unknown;
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          // The connection is unusable; drop it from the pool instead of returning it.
          broken = rollbackErr;
        }
        throw err;
      } finally {
        client.release(broken instanceof Error ? broken : undefined);
      }
    },
  };
}
