# HF-027: Clear transaction (`POST /listings/:id/clear`) with D2 locks, outbox, reserve and hold-age release

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 3
- **Estimate:** 3.5
- **Depends on:** HF-003a, HF-005
- **Spec refs:** features/10-clearing-engine.md §Hold-age guard, §Clear transaction, §Edge cases, §Acceptance criteria; api.md §`POST /listings/:id/clear`; data-model.md §Locking rule 2, §Listing state machine

## Goal
Lock the book, run the auction once, and persist winners, losers and settlement rows atomically — the brand-only money decision. Money-spine ticket; built on fixture bids on the FakePayPal stub.

## Scope
- Route guarded to brand OWNER/MANAGER (never an agent, never VIEWER); body `{quantity, expectedGrossCents}`; validate `1 ≤ Q ≤ listing.quantity` (zod + DB). Requires an `Idempotency-Key`.
- One transaction (D2, same lock order as Cancel and Expire):
  1. `UPDATE listings SET status='CLEARING' WHERE id=$1 AND status IN ('OPEN','ROUNDS') RETURNING *` → 0 rows = 409 `STATE_CONFLICT {reason:'NOT_CLEARABLE', status}`.
  2. `SELECT … FROM bids WHERE listing_id=$1 AND status='HELD' ORDER BY id FOR UPDATE` — the price watcher, cancel, pause and raise now wait for Clear and then see WON/LOST.
  3. Build the Clear input with the shared `loadClearInput` / eligibility predicate (D8: bids with `paypal_authorization_id IS NULL` never enter). Per-shopper dedupe keeps each shopper's highest bid (D3).
  4. Hold age (D6) uses `bids.authorized_at`: holds ≥ 66 h old are excluded from eligibility, voided (`void_reason=HOLD_AGED`) and audited. Refuse (409 `HOLDS_TOO_OLD`) only if a would-be winner is stale.
  5. Run `clear()`; `gross ≠ expectedGrossCents` → ROLLBACK, 409 `STATE_CONFLICT {reason:'BOOK_CHANGED', numbers: {cutoffCents, grossCents, winners, bookVersion}}` so the modal can offer one-click "Confirm $X" (M12).
  6. INV-5: refuse if any winner's `authorized_amount_cents ≠ amount_cents`, before any money moves.
  7. Batched conditional updates: `UPDATE bids SET status='WON' WHERE id = ANY($1) AND status='HELD'` (assert rowcount = |winners|), same for LOST. Any 0-row / short update → ROLLBACK and 409.
  8. One multi-row settlement INSERT: CAPTURE(`bid.amount_cents`) per winner with `unit_root_bid_id = bid.id`; VOID per loser. Reserve (D10) = **every loser at or above the floor** (`is_reserve = true`); below-floor losers' VOIDs run at once. Copy `listings.demo_decline_rank` onto that rank's CAPTURE (`bids.test_decline`, honoured only with `DEMO_MODE`).
  9. Save `cutoff_cents`, `cleared_quantity`, `gross_cents`, `payout_email_snapshot`; audit `LISTING_CLEARED` with the **full ranked list** in `data`.
  10. Insert the `settlement_runs` outbox row (B6).
- After COMMIT: kick the coordinator (HF-030a; HF-034 re-kicks within 1 min if this process dies); 202 `{status, cutoffCents, grossCents, winners, losers, runId}`; `pg_notify` `listing.status`.

## Out of scope
- Settlement execution (HF-029/030a), promotion (HF-031). Modal (HF-028).

## Acceptance criteria
- [ ] Concurrent `place_bid` during Clear is rejected with `WINDOW_CLOSED`, and a hold in flight when Clear committed is voided by `landHold` (D1) with audit.
- [ ] Race tests on the FakePayPal stub (from old HF-047): Clear vs shopper cancel, vs watcher void, vs mandate pause, vs raise → either the other side waits and sees WON/LOST, or Clear returns 409; never a winner without a live hold, never two winners for one shopper.
- [ ] A ≥ 66 h hold among losers is released (`HOLD_AGED`) and Clear succeeds; a stale winner → 409 `HOLDS_TOO_OLD`.
- [ ] Changed book → 409 `BOOK_CHANGED` with new numbers; nothing persisted.
- [ ] Q > `listing.quantity` → 422.
- [ ] A no-hold bid in the table is never a winner or a settlement row.
- [ ] Killing the process right after COMMIT → settlement starts within 1 min via the outbox kick.
- [ ] Clear with 300 seeded bids < 2 s.

## Test plan
- Integration on the stub: 300-bid Clear timing; parallel races above; outbox recovery; hold-age with backdated `authorized_at`.

## Notes & risks
- Resolved (D2, Q#4): lock `WHERE status IN ('OPEN','ROUNDS')`; data-model locking rule 2 updated to match.
- Resolved (D6, Q#15): hold age uses `authorized_at` of the bid's own current hold.
- Resolved (D10, Q#12): reserve = every loser at or above the floor; no buffer math.
- Resolved (D8): eligibility decision made; HF-045 no longer a dependency.
- Depends on HF-003a and HF-005 only; events go out via `pg_notify` with the HF-001 `ListingEvent` contract (HF-008 is the listener).
