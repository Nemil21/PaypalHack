/**
 * `npm run reconcile:holds` (HF-034, D19): GET every non-captured PayPal authorization the
 * database knows about and void any that is still CREATED but not live. Runs under the same
 * advisory lock as a scheduled run would, so it never races another instance.
 *
 * Needs DATABASE_URL and the PayPal settings (environment, or the repo-root `.env` locally).
 * `--dry-run` reports without voiding. Prints counts and bid / authorization ids, never secrets.
 * Exit code 0 when nothing dead is left CREATED, 1 otherwise.
 */
import {
  auditHook,
  ConfigError,
  createDb,
  createPayPalClient,
  createPool,
  loadConfig,
  loadDotenv,
  reconcileHolds,
  runJob,
} from '@holdfast/core';

loadDotenv();

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const dryRun = process.argv.includes('--dry-run');
const pool = createPool(config, 4);
const db = createDb(pool);
const paypal = createPayPalClient(config);
let exitCode = 1;
try {
  const run = await runJob(db, {
    id: 'reconcile-holds',
    intervalMs: 0,
    run: () =>
      reconcileHolds(
        { db, paypal, audit: auditHook },
        {
          dryRun,
          onError: (err, bidId) =>
            console.error(`bid ${bidId}: ${err instanceof Error ? err.message : String(err)}`),
        },
      ),
  });
  if (!run.ran) {
    console.error('reconcile:holds is already running elsewhere; try again in a minute.');
  } else {
    const r = run.result;
    console.log(
      `reconcile:holds${dryRun ? ' (dry run)' : ''}: checked ${r.checked}, CREATED ${r.created} ` +
        `(live ${r.live}), voided ${r.voided}, failed ${r.failed}, still CREATED ${r.stillCreated.length}`,
    );
    for (const h of r.stillCreated) {
      console.log(
        `  still CREATED: bid ${h.bidId} (${h.bidStatus}) authorization ${h.authorizationId}`,
      );
    }
    exitCode = r.stillCreated.length === 0 && r.failed === 0 ? 0 : 1;
  }
} catch (err) {
  console.error(`reconcile:holds failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
process.exit(exitCode);
