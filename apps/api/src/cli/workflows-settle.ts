/**
 * `npm run workflows:settle -- <listingId>`: the HF-030b smoke, run from the web service's Render
 * Shell after a Clear. Starts (or finds) the listing's `settleListing` task run on the workflow
 * service, waits until the listing leaves CLEARING or the run ends, then prints the run id and
 * what settled: counts, promotions and capture ids. Ids and counts only; no secrets.
 */
import { createWorkflowsClient } from '@renderinc/sdk/workflows';
import {
  ConfigError,
  MissingFeatureConfigError,
  createDb,
  createPool,
  loadConfig,
  loadDotenv,
  loadSettlementView,
  requireKeys,
} from '@holdfast/core';
import { createWorkflowsSettlement } from '../settlement-workflows.js';

loadDotenv();

const listingId = process.argv[2];
if (!listingId) {
  console.error('usage: npm run workflows:settle -- <listingId>');
  process.exit(2);
}

let exitCode = 1;
let pool: ReturnType<typeof createPool> | undefined;
try {
  const config = loadConfig(process.env);
  const sdk = createWorkflowsClient({
    token: requireKeys(config, 'Render Workflows', 'RENDER_API_KEY').RENDER_API_KEY,
  });
  pool = createPool(config, 2);
  const db = createDb(pool);
  const run = (
    await pool.query(`SELECT id FROM settlement_runs WHERE listing_id = $1`, [listingId])
  ).rows[0] as { id: string } | undefined;
  if (!run) throw new Error(`no settlement run for listing ${listingId}: clear it first`);

  const runner = createWorkflowsSettlement(config, db, { sdk });
  const kicked = await runner.start({ runId: run.id, listingId });
  console.log(JSON.stringify({ kicked }, null, 2));

  const deadline = Date.now() + 10 * 60_000;
  let status = 'CLEARING';
  let renderStatus = 'pending';
  for (;;) {
    const row = (
      await pool.query(
        `SELECT l.status, r.workflow_run_id FROM listings l
           JOIN settlement_runs r ON r.listing_id = l.id WHERE l.id = $1`,
        [listingId],
      )
    ).rows[0] as { status: string; workflow_run_id: string | null };
    status = row.status;
    if (row.workflow_run_id) renderStatus = (await sdk.getTaskRun(row.workflow_run_id)).status;
    if (status !== 'CLEARING' || !['pending', 'running'].includes(renderStatus)) break;
    if (Date.now() > deadline) throw new Error('timed out after 10 minutes');
    await new Promise((r) => setTimeout(r, 3_000));
  }

  const view = await loadSettlementView(pool, listingId, null);
  const captures = (
    await pool.query(
      `SELECT b.id AS bid_id, s.amount_cents, s.paypal_id, b.unit_root_bid_id <> b.id AS promoted
         FROM settlements s JOIN bids b ON b.id = s.bid_id
        WHERE s.listing_id = $1 AND s.action = 'CAPTURE' AND s.status = 'SUCCEEDED'
        ORDER BY s.created_at, s.id`,
      [listingId],
    )
  ).rows;
  console.log(
    JSON.stringify(
      {
        listingId,
        listingStatus: status,
        workflowRunId: view?.workflowRunId ?? null,
        renderStatus,
        counts: view?.counts,
        unfilledUnits: view?.unfilledUnits,
        capturedCents: view?.capturedCents,
        payout: view?.payout
          ? { status: view.payout.status, batch: view.payout.paypalBatchId }
          : null,
        captures,
      },
      null,
      2,
    ),
  );
  exitCode = status === 'CLEARING' ? 1 : 0;
} catch (err) {
  if (err instanceof ConfigError || err instanceof MissingFeatureConfigError) {
    console.error(err.message);
  } else {
    // SDK errors carry the HTTP status and task slug, never the API key.
    console.error(`workflows:settle failed: ${(err as Error).message}`);
  }
} finally {
  await pool?.end();
}
process.exit(exitCode);
