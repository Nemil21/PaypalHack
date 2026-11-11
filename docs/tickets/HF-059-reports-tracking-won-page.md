# HF-059: Payouts & reports (W09), shipment tracking, won page (W18 / M08)

- **Track / owner:** A money
- **Priority:** P1
- **Estimate:** 4
- **Depends on:** HF-032
- **Spec refs:** features/12-payouts-fees-tracking.md §Logic 3–4, §Acceptance criteria; api.md §`/brands/me/payouts`, §`/brands/me/reports`, §`POST /listings/:id/shipments`, §`pp.track`; screens.md §W09, §W18, §M08

## Goal
Brands see statements and add tracking; winners see their receipt and shipping progress.

## Scope
- `GET /brands/me/payouts`, `GET /brands/me/reports?from&to` (CSV via `Accept: text/csv`): gross, fee, net, units, cutoff, average price.
- `POST /listings/:id/shipments {bidId, carrier, trackingNumber}` → `pp.track` → `shipments` row; CSV upload with per-row errors.
- W09 page; W18/M08: "You won at your bid of $X", receipt (charged, capture id), tracking progress.

## Out of scope
- Refund/clawback (P2).

## Acceptance criteria
- [ ] W09 statement numbers match the sum of capture records.
- [ ] Tracking added via API shows on the shopper's won page.

## Test plan
- Integration: track call in sandbox. Manual: statement vs captures.

## Notes & risks
- Spec question: HOLDFAST-SPEC §4 lists tracking as P0 ("PayPal tracking per capture") while 12 says P1; ticketed P1 per docs/spec.
- Spec question: W18 copy "You got it at $219; you bid $229" contradicts pay-your-bid.
