# 12: Payouts, Fees & Tracking

**Priority:** P0 (payout), P1 (tracking, reports) · **Owner:** A · **Effort:** 4 h

## Purpose
Pay the brand what it earned minus our success fee, and close the loop for shoppers with tracking.

## Money math
- gross = sum of COMPLETED **real** capture amounts (never simulated or no-hold bids; D8). Store `gross_real` and, only if simulated bids are ever settled, `gross_simulated`; the console and README show both.
- gross 0 → no payout; the listing stays SETTLED.
- fee = round(gross × fee_bps / 10000) (default 900 bps = 9%).
- net = gross − fee.
- **Sandbox note:** we are the merchant of record. PayPal fees (about 3.49% + $0.49 per capture) come out of our side. Payouts cost $0.25.
- **Production path (README):** PayPal multiparty with `platform_fees` and delayed disbursement, where the brand is the merchant. This needs approved-partner status.

## Logic
1. `payoutBrand(listingId)` runs once, after the conditional `CLEARING→SETTLED`: insert a `payouts` attempt row (id = `sender_batch_id`; unique per listing `WHERE status <> 'FAILED'`) → `pp.payout` to `listings.payout_email_snapshot` with note "Holdfast: <product>, 240 units cleared, each at the winner's own bid (average $226)" → status PENDING (S4 proven). A timeout → `PENDING_UNKNOWN`, resolved by polling by attempt id. The ≈ $50k payout is funded by the captured winners' money (checked in spike S7, HF-063); pre-fund the sandbox business account as a backstop.
2. The HF-034 cron polls `GET /v1/payments/payouts/{batch_id}` every minute and reads the **item** status: SUCCESS → listing PAID_OUT; DENIED or `UNCLAIMED` → PAYOUT_FAILED (`payout.updated` over SSE). The `PAYMENT.PAYOUTSBATCH.*` webhooks are a second path. A retry inserts a new attempt with a new `sender_batch_id`.
3. **Tracking (P1):** the brand uploads a CSV or enters carrier + tracking per winner in W09 → `pp.track` per order → the shopper sees tracking on W18/M08.
4. **Reports (W09):** payouts table, per-listing statement (gross, fee, net, units, cutoff, average price) and CSV export.

## Edge cases
| Case | Handling |
|---|---|
| Payout DENIED / item UNCLAIMED | PAYOUT_FAILED; admin retry (new attempt id); brand alert |
| Brand changed payout email after Clear | Use the email snapshot taken at Clear |
| Refund after delivery (dispute) | P2: refund the capture, claw back from the next payout; documented only |

## Acceptance criteria
- [ ] After settlement, exactly one payout is created with the correct net.
- [ ] The W09 statement numbers match the sum of capture records.
- [ ] (P1) Tracking added via API shows on the shopper's won page.

## Test plan
Unit: fee rounding. Integration: S4 pattern. Manual: check the brand's sandbox account.
