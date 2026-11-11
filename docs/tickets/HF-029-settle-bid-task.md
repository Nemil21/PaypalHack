# HF-029: `settleBid` task: capture / void with lease, RECONCILE and retries

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 4
- **Estimate:** 3
- **Depends on:** HF-027, HF-004, HF-003a
- **Spec refs:** features/11-settlement-workflows.md §Workflow design (`settleBid`), §Idempotency, §Edge cases; data-model.md §Settlement state machine, §Locking rule 5

## Goal
One idempotent task that moves the money for one settlement row and can be retried, replayed or taken over after a crash without ever double-charging.

## Scope
- `packages/core/settlement/settleBid.ts` (pure function of `settlementId`, run by the HF-030a coordinator or the HF-030b Workflows adapter):
  1. Claim (D11 lease): `UPDATE settlements SET status='RUNNING', lease_until=now()+60s, attempts=attempts+1, started_at=coalesce(started_at, now()) WHERE id=$1 AND (status IN ('QUEUED','RETRY') OR (status='RUNNING' AND lease_until < now()))`. 0 rows → someone else owns it; stop.
  2. CAPTURE: assert INV-5 (`settlement.amount_cents = bid.amount_cents = bid.authorized_amount_cents`, bid's own current authorization id); `pp.capture(authId, amount, final_capture:true)` with request id = `settlement.id` (D5). VOID: `pp.void(authId)` with request id `void-<bidId>` (D4).
  3. Success is judged by the body `status`: capture `COMPLETED` or `PENDING`; void `VOIDED`. A 2xx with `DECLINED`/`FAILED` is a decline.
  4. Classes (D11): **TRANSIENT** → retry inside the task, 4 calls in total (1 s, 4 s, 16 s backoff), then `RETRY` + `error_class`; **TERMINAL** (`INSTRUMENT_DECLINED`, `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_VOIDED` on capture) → `FAILED` + `error_class`; **RECONCILE** (any capture/void 422 such as already captured / already voided) → `GET` the authorization and act on its state (captured → SUCCEEDED with the existing capture id; voided → SUCCEEDED for a VOID).
  5. On SUCCEEDED: store `paypal_id`, `finished_at`; bid WON→CAPTURED or LOST/VOIDING→VOIDED; audit `*_REQUESTED`/`*_SUCCEEDED` with the PayPal id; `pg_notify` `settlement.updated`. After commit, call `mandates.onCaptured(bidId)` (HF-017a) for captures.
  6. On a terminal capture failure, in one transaction: bid WON→CAPTURE_FAILED (conditional, so only one path wins), call `promoteWithin(tx, failedBidId)` (HF-031, D9), then void the failed bid's authorization via `voidBid(…, 'CAPTURE_FAILED')`; "already voided/expired" counts as success.
- Render-level retries are disabled; this task is the only retry owner.
- Test hook: `bids.test_decline` adds the `PayPal-Mock-Response` decline header, honoured only when `DEMO_MODE=true`, `ALLOW_MOCK_DECLINE=true` and the base is sandbox; never from request input.

## Out of scope
- Fan-out and ordering (HF-030a/030b), promotion selection (HF-031).

## Acceptance criteria
- [ ] Every winner charged exactly their own bid (INV-5 asserted in code); every loser voided.
- [ ] Re-running a SUCCEEDED settlement is a no-op.
- [ ] Race test on the stub (from old HF-047): kill the worker after RUNNING; after the 60 s lease a second worker takes over and returns the same capture id (same request id).
- [ ] Race test on the stub: capture succeeds, DB write dropped, task re-runs and gets an already-captured 422 → RECONCILE → SUCCEEDED with the original capture id, **no promotion**.
- [ ] Injected decline → FAILED (TERMINAL), CAPTURE_FAILED, exactly one promotion, and the failed authorization is voided.
- [ ] A transient failure exhausts 4 calls → `RETRY`, not `FAILED`; no promotion.

## Test plan
- Unit (stub): class mapping per PayPal response; lease takeover.
- Integration (sandbox): capture, void, mock decline, idempotent replay (S3 pattern), using HF-063's recorded issue codes.

## Notes & risks
- Resolved (D11, Q#13): 4 calls in total; RECONCILE class; 60 s lease.
- Resolved (D4): every void uses `void-<bidId>`; no VOID settlement rows outside Clear.
- A `PAYMENT.CAPTURE.DENIED` after SETTLED (PENDING capture later failing) only audits and flags; clawback is out of scope and stated in the README.
- `test_decline` must be set only by `demo:decline` / admin (HF-046).
