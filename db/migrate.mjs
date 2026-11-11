#!/usr/bin/env node
// Holdfast migration runner (HF-002).
//
// Applies db/migrations/*.sql in filename order. Idempotent: applied files are
// recorded in schema_migrations with a sha256 checksum and skipped on re-run; an
// applied file whose contents changed is an error (write a new migration instead).
// Each file runs in its own transaction, and the whole run holds an advisory lock,
// so two concurrent deploys never apply the same file twice.
//
// Usage:   DATABASE_URL=postgres://... npm run migrate
// Library: import { migrate } from '@holdfast/db/migrate.mjs'
//
// Run it only from Render's preDeployCommand (HF-048a), never at app boot.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(here, 'migrations');

// Arbitrary constant; any process migrating this database takes the same lock.
const LOCK_KEY = 4_870_002;

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      return { name, sql, checksum };
    }),
  );
}

/**
 * Apply pending migrations.
 * @param {{ connectionString?: string, client?: pg.Client, dir?: string, log?: (msg: string) => void }} opts
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function migrate({ connectionString, client, dir, log = () => {} } = {}) {
  const own = !client;
  if (own) {
    if (!connectionString) throw new Error('migrate: DATABASE_URL is not set');
    client = new pg.Client({ connectionString });
    await client.connect();
  }

  const applied = [];
  const skipped = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name        text PRIMARY KEY,
          checksum    text NOT NULL,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
      const done = new Map(rows.map((r) => [r.name, r.checksum]));

      for (const m of await listMigrations(dir)) {
        const prior = done.get(m.name);
        if (prior !== undefined) {
          if (prior !== m.checksum) {
            throw new Error(
              `migrate: ${m.name} was already applied but its contents changed; add a new migration instead`,
            );
          }
          skipped.push(m.name);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
            m.name,
            m.checksum,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          err.message = `migrate: ${m.name} failed: ${err.message}`;
          throw err;
        }
        applied.push(m.name);
        log(`applied ${m.name}`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    if (own) await client.end();
  }
  return { applied, skipped };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  migrate({ connectionString: process.env.DATABASE_URL, log: (msg) => console.log(`[migrate] ${msg}`) })
    .then(({ applied, skipped }) => {
      console.log(`[migrate] done: ${applied.length} applied, ${skipped.length} already up to date`);
    })
    .catch((err) => {
      // Never print the connection string; pg error messages do not include it.
      console.error(err.message);
      process.exit(1);
    });
}
