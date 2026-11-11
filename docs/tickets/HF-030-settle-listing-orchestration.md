# HF-030: `settleListing` orchestration on Render Workflows (+ in-process fallback)

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 4
- **Depends on:** HF-029
- **Spec refs:** features/11-settlement-workflows.md §Workflow design (ordering trick), §Edge cases (Workflows unavailable), §Acceptance criteria; api.md §Ops `POST /admin/listings/:id/retry-settlement`; HOLDFAST.md §6 (S3 Workflows half)

## Goal
Fan out one task per settlement after Clear, in an order that keeps reserve holds alive for promotion, and finish with SETTLED.

## Scope
- `settleListing(listingId)`:
  - immediately: CAPTURE tasks for winners + VOID tasks for non-reserve losers (beyond Q + buffer);
  - after all captures (and their promotions) are terminal: VOID tasks for remaining reserve bids;
  - concurrency cap 10;
  - when all settlement rows are terminal: CLEARING→SETTLED; gross = sum of SUCCEEDED captures; trigger `payoutBrand` (HF-032).
- Render Workflows task definitions + trigger from HF-027; run id returned as `workflowRunId`.
- Feature flag `SETTLEMENT_RUNNER=inprocess`: same task code on an in-process queue.
- `POST /api/admin/listings/:id/retry-settlement` re-enqueues FAILED-transient / QUEUED rows (admin, audited).
- `GET /api/listings/:id/settlement`: counts by status + rows (for W08).

## Out of scope
- Promotion internals (HF-031). W08 UI (HF-035).

## Acceptance criteria
- [ ] 300 bids settle in < 2 min in sandbox.
- [ ] Killing the worker mid-run then resuming produces no duplicate captures (verified by capture ids).
- [ ] Reserve voids start only after captures finish.
- [ ] Flag switch to in-process produces the same results.

## Test plan
- Integration (sandbox, Render): 50 bids, 1 decline (S3 via Workflows). Chaos: kill during run.

## Notes & risks
- S3's Render Workflows half has **not** been run yet; do a 10-bid smoke on Render first and keep the in-process fallback ready.
- PayPal rate limits: keep concurrency ≤ 10.
