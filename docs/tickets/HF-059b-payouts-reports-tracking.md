# HF-059b: Payouts & reports (W09) and shipment tracking

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 7
- **Estimate:** 3
- **Depends on:** HF-032, HF-031, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/12-payouts-fees-tracking.md §Logic 3–4, §Acceptance criteria; api.md §`/brands/me/payouts`, §`/brands/me/reports`, §`POST /listings/:id/shipments`, §`pp.track`; screens.md §W09

## Goal
Brands see statements and add tracking that reaches PayPal and the winner.

## Scope
- `GET /brands/me/payouts`, `GET /brands/me/reports?from&to` (CSV via `Accept: text/csv`): gross (real COMPLETED captures), fee, net, units, cutoff, average price = gross_real / units captured; simulated gross shown separately if any (M9).
- `pp.track` (moved here from HF-004) with request id `track-<shipmentId>` (D5); needs `bids.paypal_order_id` + capture id from `settlements.paypal_id`.
- `POST /listings/:id/shipments {bidId, carrier, trackingNumber}` → `pp.track` → `shipments` row; bid `CAPTURED→SHIPPED` transition; `shipments.status` values; CSV upload with per-row errors.
- W09 page (built from Figma "Holdfast — v3").

## Out of scope
- Won page (HF-059a). Refund/clawback (production path).

## Acceptance criteria
- [ ] W09 statement numbers match the sum of COMPLETED capture records.
- [ ] Tracking added via API reaches PayPal (sandbox) and shows on HF-059a.
- [ ] Re-posting the same shipment doesn't call `track` twice.

## Test plan
- Integration: track call in sandbox. Manual: statement vs captures.

## Notes & risks
- Resolved (Other answers, Q#32 / user override): tracking stays in scope at P1 (HOLDFAST-SPEC §4 listed it P0; spec 12 says P1).
