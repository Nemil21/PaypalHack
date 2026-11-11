/**
 * `npm run demo:audit-check` (HF-050b rehearsal; the check is HF-046's): after a demo run on the
 * sandbox, GET every `CAPTURE_SUCCEEDED` / `VOID_SUCCEEDED` authorization and `PAYOUT_SUCCEEDED`
 * batch at PayPal and check it matches the audit row, and that every `*_REQUESTED` row has an
 * outcome. See `../demo/audit-check.ts`.
 *
 *   npm run demo:audit-check                     # every listing
 *   npm run demo:audit-check -- --listing <uuid> # one listing (the rehearsal's A7)
 *
 * Sandbox only: in stub mode a new process's FakePayPal has none of the holds, so it refuses (the
 * stub check runs inside the HF-046 integration test against that process's call log). Needs
 * DATABASE_URL and the PayPal settings. Prints ids and problems, never secrets.
 */
import { parseArgs } from 'node:util';
import {
  ConfigError,
  createDb,
  createPayPalClient,
  createPool,
  loadConfig,
  loadDotenv,
} from '@holdfast/core';
import { checkAuditAgainstPayPal } from '../demo/audit-check.js';

loadDotenv();

const { values } = parseArgs({ options: { listing: { type: 'string' } } });

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

if (config.PAYPAL_MODE === 'stub') {
  console.error(
    'demo:audit-check needs the sandbox: a new stub process has no holds to GET. ' +
      'The stub check runs in apps/api/src/demo/demo-scripts.test.ts.',
  );
  process.exit(1);
}

const pool = createPool(config, 2);
let exitCode = 1;
try {
  const result = await checkAuditAgainstPayPal(createDb(pool), createPayPalClient(config), {
    listingIds: values.listing ? [values.listing] : undefined,
  });
  console.log(
    `demo:audit-check: ${result.succeeded} SUCCEEDED row(s) checked at PayPal, ` +
      `${result.requested} REQUESTED row(s) checked for an outcome`,
  );
  for (const m of result.mismatches) {
    console.error(
      `  ${m.action} ${m.auditId ?? '-'} (${m.requestId ?? 'no request id'}): ${m.problem}`,
    );
  }
  console.log(
    result.ok
      ? 'OK: every audit row matches PayPal'
      : `FAIL: ${result.mismatches.length} mismatch(es)`,
  );
  exitCode = result.ok ? 0 : 1;
} catch (err) {
  console.error(`demo:audit-check failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
process.exit(exitCode);
