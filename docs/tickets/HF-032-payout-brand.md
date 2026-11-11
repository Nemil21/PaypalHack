# HF-032: `payoutBrand`: fee math, attempts, PENDING_UNKNOWN, PAID_OUT / PAYOUT_FAILED

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 2
- **Depends on:** HF-030a, HF-004
- **Spec refs:** features/12-payouts-fees-tracking.md §Money math, §Logic 1–2, §Edge cases, §Acceptance criteria; api.md §`pp.payout`; data-model.md §payouts, §Listing state machine; spike S4; HF-063 (S7 payout)

## Goal
Pay the brand exactly once, net of the 9% fee, from the money actually captured, as soon as settlement finishes.

## Scope
- Called only by the winner of the conditional `CLEARING→SETTLED` transition (HF-030a).
- Gross = sum of **COMPLETED real captures** only (no PENDING captures, never simulated money); fee = shared `feeCents` (HF-022); net = gross − fee. Gross 0 (every capture failed) → no payout; listing stays SETTLED with "nothing to pay".
- `payouts` row (unique `listing_id WHERE status <> 'FAILED'`) with `attempt`; `sender_batch_id` = `PayPal-Request-Id` = `<payout.id>:<attempt>` (D5).
- `pp.payout` to `listings.payout_email_snapshot` taken at Clear; note "Holdfast: <product>, 240 units cleared, average $226.00" (D14, Q#3) → PENDING.
- Poll from the HF-034 minute cron (not an in-process timer) for PENDING payouts < 30 min old: `GET /v1/payments/payouts/{batch_id}` + the item `transaction_status`. SUCCESS → listing SETTLED→PAID_OUT; DENIED/FAILED/RETURNED → PAYOUT_FAILED; `UNCLAIMED` → PAYOUT_FAILED with "brand payout email is not a PayPal account". `pg_notify` `payout.updated`.
- Ambiguous timeout or duplicate-batch error → `PENDING_UNKNOWN`, resolved by the next poll (or the HF-033 PAYOUTSBATCH webhook); re-POST the same id after an ambiguous timeout. Mint `attempt + 1` only after GET confirms DENIED/FAILED.
- Admin retry for PAYOUT_FAILED (new attempt); listing transitions `SETTLED→PAYOUT_FAILED` and `PAYOUT_FAILED→PAID_OUT`.
- Audit `PAYOUT_REQUESTED`, `PAYOUT_SUCCEEDED/FAILED` with batch id.

## Out of scope
- Reports, statements, CSV (HF-059b, P1). Shipment tracking (HF-059b).

## Acceptance criteria
- [ ] After settlement, exactly one payout is created with the correct net of real COMPLETED captures.
- [ ] Re-running `payoutBrand` does not create a second batch.
- [ ] A DENIED payout can be retried and succeeds on attempt 2.
- [ ] A crash after POST but before saving the batch id resolves via `PENDING_UNKNOWN` and the poll.
- [ ] A ~$50k payout funded by the captured winners' money reaches SUCCESS (manual, sandbox).

## Test plan
- Unit: fee rounding; status mapping.
- Integration (stub): attempts, PENDING_UNKNOWN, UNCLAIMED.
- Integration (sandbox): S4 pattern at full size after a large capture batch.

## Notes & risks
- Funding: the payout is funded by the captured winners' money sitting in the same sandbox business account (same sandbox credentials); no separate pre-funding is planned. HF-063 proves a ~$50k payout right after a large capture batch; if per-item limits apply, split into N items in one batch.
- Sandbox: we are merchant of record; PayPal fees (~3.49% + $0.49) come out of our side (README honest limits).
- Resolved (D14, Q#3): payout note uses units + average, not a single price.
