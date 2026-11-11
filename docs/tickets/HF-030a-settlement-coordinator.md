# HF-030a: Settlement coordinator (in-process) + outbox kick + admin retry

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 5
- **Estimate:** 2.5
- **Depends on:** HF-029
- **Spec refs:** features/11-settlement-workflows.md §Workflow design (ordering trick), §Edge cases (Workflows unavailable), §Acceptance criteria; api.md §Ops `POST /admin/listings/:id/retry-settlement`, §`GET /listings/:id/settlement`

## Goal
After Clear, run every settlement in an order that keeps reserve holds alive for promotion, and only then settle and pay out — once. This is the fallback that ships first and stays the default runner (`SETTLEMENT_RUNNER=inprocess`); HF-030b adds Render Workflows on the same functions.

## Scope
- `settleListing(listingId)` coordinator (D9), one per listing (single owner via advisory lock / the `settlement_runs` row):
  - **Phase 1:** CAPTURE tasks for winners + VOID tasks for below-floor losers, concurrency ≤ 10 (p-limit). Promotions run inline in the failure transaction (`promoteWithin`, HF-031); loop until no CAPTURE row is QUEUED/RUNNING/RETRY.
  - **Phase 2:** VOID tasks for the remaining reserve bids.
  - **Phase 3:** "done" = every row terminal (`SUCCEEDED`, `CANCELLED`, `FAILED`+TERMINAL) **and** every WON bid has a SUCCEEDED capture **and** every CAPTURE_FAILED bid has a promotion outcome. Then conditional `CLEARING→SETTLED`; only the winner of that transition calls `payoutBrand` (HF-032).
- Picks up the `settlement_runs` outbox row written by HF-027; HF-034 re-kicks CLEARING listings with QUEUED or stale-RUNNING rows every minute.
- `POST /api/admin/listings/:id/retry-settlement`: admin only (`ADMIN_EMAILS`), audited, limited to `RETRY` and stale-RUNNING rows; refused once the listing is SETTLED.
- `GET /api/listings/:id/settlement`: counts by status + rows, using the `SettlementView` payload in `packages/shared` (HF-035 builds against it).
- Coordinator code lives in `packages/core` so HF-030b can reuse it.

## Out of scope
- Render Workflows adapter (HF-030b). Promotion internals (HF-031). W08 UI (HF-035).

## Acceptance criteria
- [ ] 300 bids settle in < 2 min in sandbox.
- [ ] Race test on the stub (from old HF-047): one injected decline → promotion → listing becomes SETTLED only after the promoted capture SUCCEEDED; the payout is created exactly once.
- [ ] Reserve voids start only after no CAPTURE row is open.
- [ ] Killing the process mid-run then restarting produces no duplicate captures (verified by capture ids) and finishes via the outbox kick.
- [ ] Admin retry after SETTLED → 409.

## Test plan
- Integration (stub): 50 bids, 1 decline; chained declines; kill-and-resume.
- Integration (sandbox): 50 bids, 1 decline (S3 pattern) through the in-process runner.

## Notes & risks
- Resolved (D9, Q#10/Q#11): promotion is inline; no "am I the last task?" check.
- PayPal rate limits: one coordinator per listing gives a global cap of 10.
