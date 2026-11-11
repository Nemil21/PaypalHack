-- HF-030b: Render Workflows settlement adapter. Additive and nullable, so the in-process runner
-- (the default) is unaffected.
--   workflow_run_id  the Render task run id of the latest `settleListing` run (`workflowRunId`)
--   workflow_starts  how many runs were started; run 1 uses idempotencyKey = listing id, a resume
--                    after a killed or finished-but-not-done run uses `<listing id>:<n>`
ALTER TABLE settlement_runs
  ADD COLUMN workflow_run_id text,
  ADD COLUMN workflow_starts int NOT NULL DEFAULT 0 CHECK (workflow_starts >= 0);
