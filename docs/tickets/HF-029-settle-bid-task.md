# HF-029: `settleBid` task: capture / void with retries

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-027, HF-004
- **Spec refs:** features/11-settlement-workflows.md §Workflow design (`settleBid`), §Idempotency, §Edge cases; data-model.md §Settlement state machine, §Locking rule 5

## Goal
One idempotent task that moves the money for one settlement row and can be retried or replayed without ever double-charging.

## Scope
- `apps/workflows/settleBid.ts` (pure function of `settlementId`, runnable by Render Workflows or the in-process runner):
  1. Conditional QUEUED/FAILED→RUNNING, attempts + 1.
  2. CAPTURE: `pp.capture(authId, bid.amount, final_capture:true)`, request id = settlement id. VOID: `pp.void(authId)`, same rule.
  3. Success → SUCCEEDED (+ `paypal_id`); bid WON→CAPTURED or LOST/VOIDING→VOIDED; audit with PayPal id; SSE `settlement.updated`. Capture PENDING counts as success.
  4. TRANSIENT → retry with backoff 1 s, 4 s, 16 s (max 3); TERMINAL (`INSTRUMENT_DECLINED`, `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_VOIDED`) → FAILED + `error_code`, bid WON→CAPTURE_FAILED, enqueue `promoteNext` (HF-031).
- Test hook: per-bid flag that adds the `PayPal-Mock-Response` decline (used by `demo:decline`, HF-046).

## Out of scope
- Fan-out/ordering (HF-030), promotion logic (HF-031).

## Acceptance criteria
- [ ] Every winner charged exactly their bid; every loser voided.
- [ ] Re-running a SUCCEEDED settlement is a no-op; re-running a RUNNING one after a crash returns the same capture id (same request id).
- [ ] Injected decline → FAILED, CAPTURE_FAILED, promotion enqueued once.

## Test plan
- Integration (sandbox): capture, void, mock decline, idempotent replay (S3 pattern).

## Notes & risks
- Spec question: "max 3 attempts" vs backoff list of three *retries* (1 s, 4 s, 16 s) — 3 or 4 total calls? Either is safe because the request id is reused.
- Risk: PayPal webhook `PAYMENT.CAPTURE.DENIED` (HF-033) and this task could both trigger a promotion; guard with the conditional WON→CAPTURE_FAILED transition so only the winner of the race enqueues.
