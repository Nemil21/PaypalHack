# HF-027: Clear transaction (`POST /listings/:id/clear`) with hold-age guard

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-005, HF-003, HF-008
- **Spec refs:** features/10-clearing-engine.md §Hold-age guard, §Clear transaction, §Edge cases, §Acceptance criteria; api.md §`POST /listings/:id/clear`; data-model.md §Locking rule 2, §Listing state machine

## Goal
Lock the book, run the auction once, and persist winners, losers and settlement rows atomically — the brand-only money decision.

## Scope
- Route guarded to brand OWNER/MANAGER (never an agent, never VIEWER); body `{quantity, expectedGrossCents}`, Q > 0.
- One transaction:
  1. `UPDATE listings SET status='CLEARING' WHERE id=$1 AND status IN ('OPEN','ROUNDS') RETURNING *` → 0 rows = 409 `STATE_CONFLICT`.
  2. Hold-age guard: oldest HELD bid's authorization older than 66 h → ROLLBACK, 409 `HOLDS_TOO_OLD`.
  3. Read HELD bids; run `clear()`; `gross ≠ expectedGrossCents` → ROLLBACK, 409 `STATE_CONFLICT` with new numbers.
  4. Winners HELD→WON, others HELD→LOST (conditional).
  5. Insert settlements: CAPTURE(bid.amount) per winner, VOID per loser (`settlement.id` = PayPal-Request-Id); mark which losers are reserve.
  6. Save `cutoff_cents`, `cleared_quantity`, `gross_cents`, payout-email snapshot; audit `LISTING_CLEARED` with a hash of the full ranked list.
- After COMMIT: start the settlement run (HF-030); 202 `{status, cutoffCents, grossCents, winners, losers, workflowRunId}`; SSE `listing.status`.

## Out of scope
- Settlement execution (HF-029/030). Modal (HF-028).

## Acceptance criteria
- [ ] Concurrent `place_bid` during Clear is rejected with `WINDOW_CLOSED`.
- [ ] Clear is refused when the oldest hold is > 66 h.
- [ ] Changed book → 409 with new numbers; nothing persisted.
- [ ] Clear with 300 seeded bids < 2 s.

## Test plan
- Integration: 300-bid Clear timing; race test (parallel place_bid + Clear); hold-age guard with backdated bids.

## Notes & risks
- Spec question: data-model locking rule 2 says `WHERE status='OPEN'`, while 10 says `IN ('OPEN','ROUNDS')`. Implement 10.
- Hold age should use the authorization time of the *current* hold (raised bids have fresh holds).
- Spec question: reserve size: 11 says losers "beyond Q + 10% buffer" are voided immediately. Confirm the buffer is 10% of Q (rounded up?) and whether a minimum applies.
