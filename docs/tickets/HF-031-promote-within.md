# HF-031: `promoteWithin(tx, failedBidId)`: inline promotion at the promoted bidder's own bid

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 2
- **Depends on:** HF-029, HF-030a
- **Spec refs:** features/11-settlement-workflows.md §Workflow design (`promoteWithin`), §Acceptance criteria; data-model.md §bids.promotion_count, §Bid state machine (LOST→WON); features/10-clearing-engine.md §Rules 7

## Goal
When a winner's capture fails terminally, the next reserve bidder wins that unit at their own bid, at most 3 times per unit — inside the same transaction that records the failure (D9), so SETTLED can never fire before the replacement exists.

## Scope
- `promoteWithin(tx, failedBidId)` function (not a separate task), called by HF-029 in the failure transaction:
  1. `SELECT … FROM listings WHERE id=$1 FOR UPDATE`.
  2. Unit = `unit_root_bid_id` of the failed bid (D10). If `count(CAPTURE rows WHERE unit_root_bid_id=$root) ≥ 4` (1 + 3 promotions) → audit `UNFILLED_UNIT`; stop.
  3. Pick the next reserve: LOST, `is_reserve`, at or above the floor, its VOID settlement QUEUED, ordered by rank, `FOR UPDATE SKIP LOCKED LIMIT 1`. Skip (D10) if `release_if_cheaper` is on and its amount is now above the public price, if its mandate is PAUSED or FULFILLED, or if `authorized_at` is ≥ 66 h old.
  4. Claim its VOID row conditionally `QUEUED→CANCELLED`; 0 rows → loop to the next candidate.
  5. Bid LOST→WON (conditional); set `unit_root_bid_id` = root and `promotion_count`.
  6. Insert a CAPTURE settlement at **that bidder's own bid** (`unit_root_bid_id` = root); the coordinator runs it in phase 1.
  7. Audit `PROMOTED {fromBidId, toBidId, root}`; timeline entry "A unit opened up. You won at your bid of $219. Charged $219." (D14, D18 in-app; email in HF-054b).
  8. Reserve empty → audit `UNFILLED_UNIT`.
- If a promoted bid's capture also fails, its cancelled VOID row is re-opened `CANCELLED→QUEUED` (don't insert a new one; `unique(bid_id, action)`).

## Out of scope
- Notification delivery beyond in-app (HF-054a/b, P1).

## Acceptance criteria
- [ ] One injected decline → exactly one promotion, charged at the promoted bidder's own bid.
- [ ] No promoted bidder is ever charged more than their bid.
- [ ] Race test on the stub (from old HF-047): a unit is promoted at most 3 times; the 4th failure leaves it UNFILLED.
- [ ] Race test on the stub: two simultaneous failures never promote the same reserve bid (SKIP LOCKED + conditional claim); a reserve VOID task and a promotion racing on one row → exactly one wins.
- [ ] Skip rules: a paused-mandate or over-public-price reserve bid is never promoted.

## Test plan
- Integration (stub): 50 bids, 1 decline; 3 chained declines on one unit; parallel failures.
- Integration (sandbox): 1 decline end to end.

## Notes & risks
- Resolved (D10, Q#10): unit id = `unit_root_bid_id` (original winner's bid id); cap 3 promotions.
- Resolved (D10, Q#11): new `CANCELLED` settlement status; rows are never deleted.
- Resolved (D14): a reserve loser sees "Not won — on the reserve list" until their hold is VOIDED.
- `demo:decline` (HF-046) must check eligible > Q so a reserve exists.
