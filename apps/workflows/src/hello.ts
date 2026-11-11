/**
 * Render Workflows hello-world (HF-048a): proves a task run sees the shared env and reaches
 * Postgres over Render's private network. HF-030b builds the settlement adapter on this path.
 *
 * The result is stored by Render and shown in the run view, so it reports which keys are
 * present, never their values.
 */

export interface Queryable {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

/** Keys the settlement tasks will need on the workflow service (HF-030b). */
export const EXPECTED_KEYS = [
  'DATABASE_URL',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_API_BASE',
] as const;

export interface HelloResult {
  ok: true;
  node: string;
  service: string | null;
  /** Presence only: true when the key is set and non-empty. */
  env: Record<(typeof EXPECTED_KEYS)[number], boolean>;
  flags: { NODE_ENV: string | null; PAYPAL_MODE: string | null; SETTLEMENT_RUNNER: string | null };
  /** One row read from Postgres: the first applied migration. */
  db: { firstMigration: string; appliedAt: string };
}

export async function hello(
  db: Queryable,
  env: Record<string, string | undefined>,
): Promise<HelloResult> {
  const { rows } = await db.query(
    'SELECT name, applied_at FROM schema_migrations ORDER BY name LIMIT 1',
  );
  const row = rows[0] as { name: string; applied_at: Date | string } | undefined;
  if (!row) throw new Error('hello: schema_migrations is empty; run `npm run migrate` first');

  const flag = (k: string) => env[k]?.trim() || null;
  return {
    ok: true,
    node: process.version,
    service: flag('RENDER_SERVICE_NAME'),
    env: Object.fromEntries(EXPECTED_KEYS.map((k) => [k, !!env[k]?.trim()])) as HelloResult['env'],
    flags: {
      NODE_ENV: flag('NODE_ENV'),
      PAYPAL_MODE: flag('PAYPAL_MODE'),
      SETTLEMENT_RUNNER: flag('SETTLEMENT_RUNNER'),
    },
    db: {
      firstMigration: row.name,
      appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : row.applied_at,
    },
  };
}
