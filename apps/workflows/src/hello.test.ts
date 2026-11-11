import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs module without type declarations
import { migrate } from '@holdfast/db/migrate.mjs';
import { hello, type Queryable } from './hello.js';
import { TASKS, helloTask } from './tasks.js';

const SECRET = 'sk-live-should-never-appear';

function fakeDb(rows: unknown[]): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return { sql, query: async (q) => (sql.push(q), { rows }) };
}

describe('hello (Workflows hello-world)', () => {
  it('reads one row from schema_migrations and reports key presence, not values', async () => {
    const db = fakeDb([{ name: '0001_init.sql', applied_at: new Date('2026-11-11T12:00:00Z') }]);
    const result = await hello(db, {
      DATABASE_URL: `postgres://u:${SECRET}@host/db`,
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: SECRET,
      PAYPAL_API_BASE: '  ',
      NODE_ENV: 'production',
      SETTLEMENT_RUNNER: 'inprocess',
      RENDER_SERVICE_NAME: 'holdfast-workflows',
    });
    expect(db.sql).toEqual([
      'SELECT name, applied_at FROM schema_migrations ORDER BY name LIMIT 1',
    ]);
    expect(result).toMatchObject({
      ok: true,
      service: 'holdfast-workflows',
      env: {
        DATABASE_URL: true,
        PAYPAL_CLIENT_ID: true,
        PAYPAL_CLIENT_SECRET: true,
        PAYPAL_API_BASE: false,
      },
      flags: { NODE_ENV: 'production', PAYPAL_MODE: null, SETTLEMENT_RUNNER: 'inprocess' },
      db: { firstMigration: '0001_init.sql', appliedAt: '2026-11-11T12:00:00.000Z' },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('fails clearly when migrations have not run', async () => {
    await expect(hello(fakeDb([]), {})).rejects.toThrow(/schema_migrations is empty/);
  });

  it('registers the task as `hello`', () => {
    expect(helloTask.name).toBe(TASKS.hello);
    expect(TASKS.hello).toBe('hello');
  });
});

// Runs the registered task body against a freshly migrated database.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!TEST_DATABASE_URL)('hello task against Postgres', () => {
  const dbName = `holdfast_test_wf_${randomBytes(4).toString('hex')}`;
  let url = '';
  let previous: string | undefined;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(TEST_DATABASE_URL!);
    u.pathname = `/${dbName}`;
    url = u.toString();
    await migrate({ connectionString: url });
    previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('reads the first applied migration', async () => {
    const ctx = { metadata: { taskRunId: 'trn-test' }, run: async () => undefined } as never;
    const result = await helloTask.func(ctx);
    expect(result.db.firstMigration).toBe('0001_init.sql');
    expect(result.env.DATABASE_URL).toBe(true);
    expect(result.taskRunId).toBe('trn-test');
  });
});
