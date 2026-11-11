# 11: Settlement Workflows (Render Workflows: Capture, Void, Promote)

**Priority:** P0 · **Owner:** A · **Effort:** 8 h

## Purpose
After Clear, move the money reliably: charge each winner their own bid, release each loser, replace failed winners, then pay the brand. It must survive crashes and retries without double-charging.

## Workflow design
- Render Workflows run `settleListing(listingId)`. It fans out one task per settlement row (cap concurrency at 10 to respect PayPal rate limits).
- Task `settleBid(settlementId)`:
  1. Conditional update QUEUED/FAILED→RUNNING, attempts+1.
  2. CAPTURE: `pp.capture(authId, bid.amount, final_capture:true)` with `PayPal-Request-Id = settlementId`. The capture equals the hold, so nothing is left to release.
     VOID: `pp.void(authId)` with the same rule.
  3. Success → SUCCEEDED; bid CAPTURED / VOIDED; audit with the PayPal ID.
  4. Error:
     - transient (5xx, 429, timeout) → retry with backoff (1 s, 4 s, 16 s), max 3;
     - `INSTRUMENT_DECLINED`, `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_VOIDED` → FAILED terminal → bid CAPTURE_FAILED → enqueue `promoteNext(listingId, unitId)`.
- Task `promoteNext(listingId, unitId)`:
  1. Lock the listing row.
  2. If this unit already has **3 promotions**, stop: audit `UNFILLED_UNIT`; the unit returns to the brand.
  3. Take the next reserve bid (rank order) whose status is LOST, amount ≥ floor, and whose VOID settlement is still QUEUED.
  4. Flip that VOID settlement to cancelled and the bid LOST→WON.
  5. Insert a CAPTURE settlement **at that bidder's own bid** and run `settleBid`. Notify: "A unit opened up. You won at your bid of $219."
  6. If the reserve is empty → audit `UNFILLED_UNIT`.
- **Ordering trick:** run all CAPTUREs first, and start VOIDs for reserve bids only after captures finish. Reserve holds then stay alive for promotion. Non-reserve losers (beyond Q + 10% buffer) are voided immediately.
- When all settlements are terminal → listing SETTLED → `payoutBrand(listingId)` (12). Gross = sum of successful captures.

## Idempotency
- A retried task re-sends the same `PayPal-Request-Id`, so PayPal returns the original result (proven in S3).
- The `unique(bid_id, action)` constraint prevents duplicate rows.
- PayPal webhooks (`PAYMENT.CAPTURE.COMPLETED`) reconcile in case the task died after PayPal succeeded but before the DB write.

## Screens
W08 Settlement live view (progress bars: captured / voided / failed / promoted; live log), M10 (brand alert "Clearing done").

## Edge cases
| Case | Handling |
|---|---|
| Worker crash mid-task | Workflow retries; same request ID → no double charge |
| Capture PENDING (eCheck-like) | Treat as success for clearing; webhook finalizes |
| Authorization expired (> 3-day honor period, card) | Terminal fail → promote. Made rare by the 48 h + 6 h + 6 h timeline and the 66 h hold-age guard (10) |
| 3 promotions failed for one unit | Unit unsold; brand notified; payout covers actual captures |
| All reserves exhausted | Fewer units sold; brand notified |
| Render Workflows unavailable | Fallback: in-process queue with the same task code (feature flag) |

## Acceptance criteria
- [ ] 300 bids settle in < 2 min in sandbox.
- [ ] One injected decline (`PayPal-Mock-Response`) results in exactly one promotion, charged at the promoted bidder's own bid.
- [ ] No promoted bidder is ever charged more than their bid; a unit is promoted at most 3 times.
- [ ] Killing the worker mid-run then resuming produces no duplicate captures (verified by capture IDs).
- [ ] Every winner charged exactly their bid; every loser voided.

## Test plan
Integration in sandbox: the S3 pattern via Workflows (50 bids, 1 decline). Chaos test: kill during run. Reconciliation test: drop DB write, replay webhook.
