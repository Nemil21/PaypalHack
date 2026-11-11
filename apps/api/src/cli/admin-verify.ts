/**
 * `npm run admin:verify <domain>`: approve a PENDING brand (HF-011a). Needs only DATABASE_URL
 * (from the environment, or the repo-root `.env` locally). Prints the outcome, never secrets.
 */
import { createDb, createPool, loadDotenv } from '@holdfast/core';
import { adminVerify } from '../admin-verify.js';

loadDotenv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('admin:verify needs DATABASE_URL (set it in the environment or .env).');
  process.exit(1);
}

const pool = createPool({ DATABASE_URL: url }, 1);
let exitCode = 1;
try {
  const outcome = await adminVerify(createDb(pool), process.argv.slice(2));
  (outcome.exitCode === 0 ? console.log : console.error)(outcome.message);
  exitCode = outcome.exitCode;
} catch (err) {
  // pg errors name the failing step, not the connection string.
  console.error(`admin:verify failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
process.exit(exitCode);
