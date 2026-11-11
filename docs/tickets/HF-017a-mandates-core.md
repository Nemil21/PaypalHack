# HF-017a: Mandates core: `authorize()`, cap, pause fan-out, `onCaptured`

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 5
- **Estimate:** 2
- **Depends on:** HF-003a, HF-014a
- **Spec refs:** features/05-mandates-rolling.md §Logic 1–3, 6–7, §Edge cases, §Acceptance criteria; data-model.md §mandates, §Locking rule 3

## Goal
Hard, code-enforced limits that every money path (offer page, agent, MCP, live rounds, roll) passes through, with no race that lets a shopper exceed the cap.

## Scope
- `core/mandates.ts#authorize(tx, mandateId, {newHoldCents, replacedBidId?, productId})`: `SELECT … FOR UPDATE`; ACTIVE and not expired; `new ≤ max_price` else `ABOVE_MANDATE_MAX`; live holds per D12 = `SUM(amount_cents) WHERE mandate_id=$1 AND status IN ('PENDING_APPROVAL','HELD','WON','LOST') AND id <> $replacedBidId`; `live + new ≤ total_hold_cap` else `MANDATE_EXCEEDED`; product in the allowed list. The PENDING_APPROVAL bid row is inserted in the **same transaction** as this check (HF-014a step 3), then committed before the PayPal call.
- Re-check inside `landHold` (HF-003a): mandate re-locked, must be ACTIVE and within cap; else the new hold is voided (`MANDATE_PAUSED`).
- `bids.mandate_id` wiring in `placeBid` and raise; `mandates.authorize` is only called when `mandate_id` is set.
- Pause / revoke → PAUSED → fan-out `voidBid` over **HELD** bids only (WON/LOST owned by a running settlement are left alone). Audit `MANDATE_PAUSED`.
- `mandates.onCaptured(tx, bidId)` hook, called by HF-029 after a successful capture: mandate FULFILLED when its quantity is met; void the mandate's other HELD bids (`void_reason=FULFILLED`).
- Create with no vaulted method → mandate ACTIVE with `needs_payment_method=true`; money tools fall back to confirm-required.

## Out of scope
- REST API and W17/M09 form (HF-017b). Auto-roll (HF-053). Intents/move rule (HF-052).

## Acceptance criteria
- [ ] Race (stub): 10 parallel places across **10 fixture listings** against one cap → the extras get `MANDATE_EXCEEDED`; total live holds never exceed the cap.
- [ ] Race (stub): a pause while a hold is in flight → the late hold is voided at landing.
- [ ] Pausing voids all HELD bids under the mandate within 1 min; WON/LOST untouched.
- [ ] `onCaptured` marks the mandate FULFILLED and voids its other HELD bids.
- [ ] Raise within max succeeds when cap = old max (replaced bid excluded).

## Test plan
- Unit: cap maths incl. replaced-bid exclusion and LOST/PENDING inclusion.
- Integration (stub): parallel cap test; pause vs in-flight hold.
- Integration (sandbox): pause voids real holds.

## Notes & risks
- Per-path assertions (agent, MCP, rounds) live in HF-039, HF-044a/b and HF-038b.
- HF-031 must skip reserve bids whose mandate is PAUSED or FULFILLED (D10).
- Resolved (D12, Q#19): cap sum and `bids.mandate_id` as above.
- Resolved (HF-002 columns, Q#16): `mandates.needs_payment_method`, `mandates.notify_every_action` exist.
- Resolved (Other answers, Q#32): `authorize()` is P0.
