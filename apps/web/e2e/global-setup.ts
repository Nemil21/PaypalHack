import pg from 'pg';
// @ts-expect-error: plain ESM module without type declarations.
import { migrate } from '../../../db/migrate.mjs';

/**
 * Fresh schema for every E2E run. The FakePayPal stub numbers its authorizations from 1 in each
 * server process, so holds left by an earlier run would collide with new ones (`landHold`
 * refuses an authorization that belongs to another bid). Local databases only.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) return;
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`E2E_DATABASE_URL must be a local database (got host ${host}); it is wiped.`);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
  await migrate({ connectionString: url });
}
