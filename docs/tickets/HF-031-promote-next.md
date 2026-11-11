# HF-031: `promoteNext`: replace a failed winner at the promoted bidder's own bid

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-030
- **Spec refs:** features/11-settlement-workflows.md §`promoteNext`, §Acceptance criteria; data-model.md §bids.promotion_count, §Bid state machine (LOST→WON); features/10-clearing-engine.md §Rules 7

## Goal
When a winner's capture fails, the next reserve bidder wins that unit at their own bid, at most 3 times per unit.

## Scope
- `promoteNext(listingId, unitId)` task:
  1. Lock the listing row.
  2. If the unit already has 3 promotions → audit `UNFILLED_UNIT`; stop.
  3. Next reserve bid in rank order with status LOST, amount ≥ floor, VOID settlement still QUEUED.
  4. Cancel that VOID settlement; bid LOST→WON (conditional).
  5. Insert CAPTURE settlement at **that bidder's own bid**; run `settleBid`. Audit `PROMOTED`; message "A unit opened up. You won at your bid of $219." (in-app/audit; email is P1).
  6. Reserve empty → audit `UNFILLED_UNIT`.
- Increment `promotion_count` along the unit chain.

## Out of scope
- Notifications delivery (HF-054, P1).

## Acceptance criteria
- [ ] One injected decline results in exactly one promotion, charged at the promoted bidder's own bid.
- [ ] No promoted bidder is ever charged more than their bid.
- [ ] A unit is promoted at most 3 times; the 4th failure leaves it unfilled.
- [ ] Two simultaneous failures never promote the same reserve bid twice.

## Test plan
- Integration (sandbox): 50 bids, 1 decline; 3 chained declines on one unit.

## Notes & risks
- Spec question: there is no `units` table; `unitId` and the 3-promotion cap need a definition. Proposed: unit id = the original winner's bid id; each promoted bid stores the chain root and count.
- Spec question: settlement statuses are `QUEUED/RUNNING/SUCCEEDED/FAILED`; "flip that VOID settlement to cancelled" needs a `CANCELLED` value (or delete the row). Confirm.
