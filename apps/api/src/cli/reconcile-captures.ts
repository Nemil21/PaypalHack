/**
 * `npm run reconcile:captures` (HF-058): compare every settlement that finished in the last 24 h
 * with PayPal (GET authorization, GET order for the capture) and flag disagreements as
 * `RECONCILE_MISMATCH` audit rows. The nightly job does the same; this runs it now, under the same
 * advisory lock, so it never races a scheduled run. It never captures or voids.
 *
 * Needs DATABASE_URL and the PayPal settings (environment, or the repo-root `.env` locally).
 * `--hours=N` widens or narrows the window. Prints counts and settlement / PayPal ids, never secrets.
 * Exit code 0 when everything matched, 1 otherwise.
 */
import {
  ConfigError,
  CRON_JOB_IDS,
  createDb,
  createPayPalClient,
  createPool,
  loadConfig,
  loadDotenv,
  reconcileCaptures,
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

const hoursArg = process.argv.find((a) => a.startsWith('--hours='));
const windowHours = hoursArg ? Number(hoursArg.slice('--hours='.length)) : undefined;
if (windowHours !== undefined && !(windowHours > 0)) {
  console.error('--hours must be a positive number.');
  process.exit(1);
}
const pool = createPool(config, 4);
const db = createDb(pool);
const paypal = createPayPalClient(config);
let exitCode = 1;
try {
  const run = await runJob(db, {
    id: CRON_JOB_IDS.captureReconcile,
    intervalMs: 0,
    run: () =>
      reconcileCaptures(
        { db, paypal },
        {
          windowHours,
          onError: (err, settlementId) =>
            console.error(
              `settlement ${settlementId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
        },
      ),
  });
  if (!run.ran) {
    console.error('reconcile:captures is already running elsewhere; try again in a minute.');
  } else {
    const r = run.result;
    console.log(
      `reconcile:captures: checked ${r.checked}, matched ${r.matched}, ` +
        `mismatches ${r.mismatches.length}, failed ${r.failed}`,
    );
    for (const m of r.mismatches) {
      console.log(
        `  ${m.reason}: settlement ${m.settlementId} (${m.action} ${m.settlementStatus}) ` +
          `authorization ${m.authorizationId ?? '–'} is ${m.actual.authorizationStatus ?? '–'}`,
      );
    }
    exitCode = r.mismatches.length === 0 && r.failed === 0 ? 0 : 1;
  }
} catch (err) {
  console.error(`reconcile:captures failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
process.exit(exitCode);
