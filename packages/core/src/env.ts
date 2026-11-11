import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

/**
 * Load the repo-root `.env` into `process.env` if one exists, walking up from `startDir`.
 * Variables already set in the environment win (Render sets them directly; no `.env` there).
 * Returns the path loaded, or null. Never logs values.
 */
export function loadDotenv(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate, override: false, quiet: true });
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
