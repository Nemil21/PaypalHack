# 11: Settlement Workflows (Render Workflows: Capture, Void, Promote)

**Priority:** P0 (coordinator and Workflows adapter) · **Owner:** A · **Effort:** 8 h

## Purpose
After Clear, move the money reliably: charge each winner their own bid, release each loser, replace failed winners, then pay the brand. It must survive crashes and retries without double-charging.

Build order: the **in-process coordinator** first (HF-030a; the default), then the **Render Workflows adapter** over the same `packages/core` tasks (HF-030b; smoke-tested with 10 bids on Render, used for the recording if green).

## Workflow design
- `settleListing(listingId)` is a **coordinator** kicked from the `settlement_runs` outbox (written in the Clear transaction; a 1-minute cron re-kicks any run not DONE). Concurrency is capped at 10 to respect PayPal rate limits. Order (D9):
  1. captures for every winner, plus VOIDs for non-reserve losers (below the floor);
  2. promotions, until no CAPTURE is open;
  3. reserve VOIDs (`is_reserve`), so reserve holds stay alive for promotion;
  4. `CLEARING→SETTLED` as a conditional update, only when no CAPTURE is open **and** every WON bid has a SUCCEEDED capture, so the payout runs exactly once;
  5. `payoutBrand(listingId)` (12). Gross = sum of COMPLETED real captures.
- Task `settleBid(settlementId)`:
  1. Claim: conditional update QUEUED/RETRY→RUNNING (or take over a RUNNING row whose 60 s `lease_until` expired), attempts+1.
  2. CAPTURE: `pp.capture(authId, bid.amount, final_capture:true)` with `PayPal-Request-Id = settlementId`. A trigger asserts the amount equals the bid and the authorized amount (INV-5). VOID: `pp.void(authId)` with `PayPal-Request-Id = void-<bidId>`.
  3. Success is judged by the response body `status` → SUCCEEDED; bid CAPTURED / VOIDED; audit `*_REQUESTED` / `*_SUCCEEDED` with the PayPal ID; after a capture, `mandates.onCaptured(bidId)`.
  4. Error (`error_class`, D11; 4 calls in total with 1 s, 4 s, 16 s backoff; Render-level retries off):
     - `TRANSIENT` (5xx, 429, timeout) → RETRY;
     - `RECONCILE` (any capture/void 422, e.g. already captured or voided) → `GET` the authorization and act on its real state; never treated as a decline (B4);
     - `TERMINAL` (`INSTRUMENT_DECLINED`, `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_VOIDED`) → FAILED → bid CAPTURE_FAILED → void that authorization (`CAPTURE_FAILED`) → `promoteWithin(tx, failedBidId)` **in the same transaction**.
- Function `promoteWithin(tx, failedBidId)` (inline, not an async task; D9, D10):
  1. Unit = the failed bid's `unit_root_bid_id`. If this unit already has **3 promotions**, stop: audit `UNFILLED_UNIT`; the unit returns to the brand.
  2. Select the next reserve bid in rank order with `FOR UPDATE SKIP LOCKED`: status LOST, amount ≥ floor, reserve VOID still QUEUED. Skip it if `release_if_cheaper` is on and its amount is now above the public price, if its mandate is paused or fulfilled, or if its hold is ≥ 66 h old.
  3. Claim its VOID settlement QUEUED→CANCELLED and flip the bid LOST→WON with the same `unit_root_bid_id`.
  4. Insert a CAPTURE settlement **at that bidder's own bid**; the coordinator runs it. The shopper sees "A unit opened up. You won at your bid of $219. Charged $219."
  5. If the reserve is empty → audit `UNFILLED_UNIT`.

## Screens
W08 Settlement live view (progress bars: captured / voided / failed / promoted; live log; "Cleared $X · Captured $Y"), M10 (brand alert "Clearing done").

## Edge cases
| Case | Handling |
|---|---|
| Worker crash mid-task | Lease expires, another worker takes over; same request ID → no double charge |
| Crash between Clear COMMIT and run start | `settlement_runs` outbox + 1-min cron kick |
| Capture replay returns 422 "already captured" | RECONCILE: GET the authorization; counted as success, no promotion |
| Capture PENDING (eCheck-like) | Treat as success for clearing; webhook finalizes |
| Authorization expired (> 3-day honor period, card) | Terminal fail → promote. Made rare by the 48 h + 6 h + 6 h timeline and the 66 h hold-age guard (10) |
| 3 promotions failed for one unit | Unit unsold; brand notified; payout covers actual captures |
| All reserves exhausted | Fewer units sold; brand notified |
| Render Workflows unavailable or misbehaving | The in-process coordinator (default) runs the same task code; the README says which one ran |

## Acceptance criteria
- [ ] 300 bids settle in < 2 min in sandbox.
- [ ] One injected decline (`PayPal-Mock-Response`) results in exactly one promotion, charged at the promoted bidder's own bid.
- [ ] No promoted bidder is ever charged more than their bid; a unit is promoted at most 3 times.
- [ ] Killing the worker mid-run then resuming produces no duplicate captures (verified by capture IDs).
- [ ] SETTLED and the payout happen only after the promoted capture succeeds; the payout runs once.
- [ ] Every winner charged exactly their bid; every loser voided.

## Test plan
Integration on the `FakePayPal` stub (crash takeover, already-captured 422, decline → promotion), then in sandbox: the S3 pattern via the coordinator and via Workflows (50 bids, 1 decline). Chaos test: kill during run. Reconciliation test: drop DB write, replay webhook.
