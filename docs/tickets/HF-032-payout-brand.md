# HF-032: `payoutBrand`: fee math, payout, PAID_OUT / PAYOUT_FAILED

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-030
- **Spec refs:** features/12-payouts-fees-tracking.md §Money math, §Logic 1–2, §Edge cases, §Acceptance criteria; api.md §`pp.payout`; data-model.md §payouts; spike S4

## Goal
Pay the brand exactly once, net of the 9% fee, as soon as settlement finishes.

## Scope
- gross = sum of SUCCEEDED capture amounts; fee = `round(gross × fee_bps / 10000)`; net = gross − fee.
- Insert `payouts` row (id = `sender_batch_id`, unique per listing) → `pp.payout` to the payout-email snapshot taken at Clear, note "Holdfast: <product> cleared N" → PENDING.
- Poll `GET /v1/payments/payouts/{batch_id}` every 60 s for up to 30 min (webhook path in HF-033) → SUCCESS → listing SETTLED→PAID_OUT; DENIED → PAYOUT_FAILED.
- `POST /api/admin/...` retry for PAYOUT_FAILED (re-uses same payout id).
- Audit `PAYOUT_CREATED`, `PAYOUT_SUCCEEDED/FAILED` with batch id.

## Out of scope
- Reports, statements, CSV, tracking (HF-059, P1).

## Acceptance criteria
- [ ] After settlement, exactly one payout is created with the correct net.
- [ ] Re-running `payoutBrand` does not create a second batch.
- [ ] Brand's sandbox account shows the payout (manual).

## Test plan
- Unit: fee rounding.
- Integration: S4 pattern.

## Notes & risks
- Sandbox: we are merchant of record; PayPal fees (~3.49% + $0.49) come out of our side (README honest limits).
- Spec question: the payout note example says "cleared 240 at $219", which implies a single price; under pay-your-bid use units + average or cutoff wording.
