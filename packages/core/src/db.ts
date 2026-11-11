import pg from 'pg';
import type { Config } from './config.js';

/**
 * Postgres pool factory. Repository code (transition, landHold, audit) lands in HF-003a/b;
 * the schema and migrations are HF-002 (`db/migrations`, `npm run migrate`).
 */
export function createPool(config: Pick<Config, 'DATABASE_URL'>, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: config.DATABASE_URL, max });
}
