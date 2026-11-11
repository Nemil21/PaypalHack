# HF-012b: Listings API: async cancel (OPEN or ROUNDS) and quantity increase

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 2
- **Depends on:** HF-012a, HF-004, HF-008, HF-003a
- **Spec refs:** features/02-listing-creation.md §Logic 6, §Edge cases; api.md §`/cancel`, §`PATCH /listings/:id`; data-model.md §State machines (Listing), §Locking rules 2, 5, 8

## Goal
A brand can cancel a live listing and release every hold, safely and at ~300-bid scale; and can raise quantity after publish, as feature 02 allows.

## Scope
**Cancel (M7):**
- `POST /api/listings/:id/cancel` (OWNER/MANAGER) → one transaction with D2 locking: conditional `UPDATE listings SET status='CANCELLED' WHERE id=$1 AND status IN ('OPEN','ROUNDS')` (0 rows → 409 `STATE_CONFLICT`), then `SELECT … FOR UPDATE` the HELD bids, move them HELD→VOIDING (`void_reason=LISTING_CANCELLED`), and mark PENDING_APPROVAL bids ABANDONED. Commit, return **202**.
- Voids run on the in-process runner at concurrency ≤ 10 via `voidBid` (HF-003a) with `PayPal-Request-Id = void-<bidId>` (D4; no VOID settlement rows). Progress streams over SSE (`listing.status`, `bid.voided`).
- Holds still landing are voided by `landHold` (D1), since the listing is no longer biddable.

**Quantity increase:**
- `PATCH /api/listings/:id {quantity}` (OWNER/MANAGER, Idempotency-Key): only while `status='OPEN'`, only upward (`new > current`), floor and window stay locked → else `VALIDATION_ERROR` / `STATE_CONFLICT`. Audit `LISTING_QUANTITY_RAISED`; SSE `listing.updated`.

## Out of scope
- Clear (HF-027). Lowering quantity or changing floor/window (spec forbids).

## Acceptance criteria
- [ ] Cancel from OPEN and from ROUNDS both work; from CLEARING → 409.
- [ ] Cancel over 300 held bids (stub) returns 202 fast; all bids reach VOIDED, each with an audit row and PayPal id.
- [ ] Race (stub, 2 s PayPal latency): a cancel racing 5 in-flight `placeBid`s leaves zero HELD bids.
- [ ] A void that fails is retried by the HF-034 sweeper (bid stays VOIDING, not HELD).
- [ ] PATCH quantity up on OPEN works; down, or on ROUNDS, is refused.

## Test plan
- Integration (FakePayPal stub): cancel with 300 bids; cancel vs place race; PATCH rules.
- Integration (sandbox): cancel with 2 holds created directly with the HF-004 client (S1 pattern).

## Notes & risks
- Resolved (Other answers, Q#8): cancel is allowed from ROUNDS; data-model state table updated.
- Resolved (D4, Q#14): void id `void-<bidId>` on every path; no VOID settlement rows outside Clear.
- Resolved (user override, Q#23): the summary said "no PATCH on listings in P0"; the quantity increase from feature 02 stays in scope here, sequenced after create/publish.
