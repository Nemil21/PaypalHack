# 12: Payouts, Fees & Tracking

**Priority:** P0 (payout), P1 (tracking, reports) · **Owner:** A · **Effort:** 4 h

## Purpose
Pay the brand what it earned minus our success fee, and close the loop for shoppers with tracking.

## Money math
- gross = sum of SUCCEEDED capture amounts.
- fee = round(gross × fee_bps / 10000) (default 900 bps = 9%).
- net = gross − fee.
- **Sandbox note:** we are the merchant of record. PayPal fees (about 3.49% + $0.49 per capture) come out of our side. Payouts cost $0.25.
- **Production path (README):** PayPal multiparty with `platform_fees` and delayed disbursement, where the brand is the merchant. This needs approved-partner status.

## Logic
1. `payoutBrand(listingId)`: insert a `payouts` row (id = sender_batch_id) → `pp.payout` to `brands.payout_email` with note "Holdfast: <product> cleared 240 at $219" → status PENDING (S4 proven).
2. Webhook `PAYMENT.PAYOUTSBATCH.SUCCESS` → SUCCESS → listing PAID_OUT. Alternatively, poll `GET /v1/payments/payouts/{batch_id}` every 60 s for up to 30 min.
3. **Tracking (P1):** the brand uploads a CSV or enters carrier + tracking per winner in W09 → `pp.track` per order → the shopper sees tracking on W18/M08.
4. **Reports (W09):** payouts table, per-listing statement (gross, fee, net, units, cutoff, average price) and CSV export.

## Edge cases
| Case | Handling |
|---|---|
| Payout DENIED | PAYOUT_FAILED; admin retry button; brand alert |
| Brand changed payout email after Clear | Use the email snapshot taken at Clear |
| Refund after delivery (dispute) | P2: refund the capture, claw back from the next payout; documented only |

## Acceptance criteria
- [ ] After settlement, exactly one payout is created with the correct net.
- [ ] The W09 statement numbers match the sum of capture records.
- [ ] (P1) Tracking added via API shows on the shopper's won page.

## Test plan
Unit: fee rounding. Integration: S4 pattern. Manual: check the brand's sandbox account.
