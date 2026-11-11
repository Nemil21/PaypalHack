/**
 * `npm run demo:audit-check` (HF-050b rehearsal; the check is HF-046's): after a demo run on the
 * sandbox, GET every `CAPTURE_SUCCEEDED` / `VOID_SUCCEEDED` authorization and `PAYOUT_SUCCEEDED`
 * batch at PayPal and check it matches the audit row, and that every `*_REQUESTED` row has an
 * outcome. See `../demo/audit-check.ts`.
 *
 *   npm run demo:audit-check                     # every listing
 *   npm run demo:audit-check -- --listing aurel-a7   # one listing by slug or id (the rehearsal's A7)
 *
 * Exits 1 on any mismatch, on an unknown `--listing`, and when no SUCCEEDED row was found: after
 * a demo Clear there are always captures and voids to check, so zero means the wrong listing or
 * database, not a pass.
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
import { findDemoListing } from '../demo/listing.js';

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
  let listingIds: string[] | undefined;
  if (values.listing) {
    const listing = await findDemoListing(pool, values.listing);
    if (!listing) throw new Error(`listing not found: ${values.listing}`);
    listingIds = [listing.id];
    console.log(
      `demo:audit-check: listing ${listing.slug ?? listing.id} (${listing.id}, ${listing.status})`,
    );
  }
  const result = await checkAuditAgainstPayPal(createDb(pool), createPayPalClient(config), {
    listingIds,
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
  if (result.succeeded === 0) {
    console.error(
      'FAIL: no CAPTURE / VOID / PAYOUT SUCCEEDED rows found; a cleared demo listing always has ' +
        'some. Check --listing and DATABASE_URL.',
    );
  } else {
    console.log(
      result.ok
        ? 'OK: every audit row matches PayPal'
        : `FAIL: ${result.mismatches.length} mismatch(es)`,
    );
  }
  exitCode = result.ok && result.succeeded > 0 ? 0 : 1;
} catch (err) {
  console.error(`demo:audit-check failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
process.exit(exitCode);
