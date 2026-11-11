# HF-058: Ops / audit screen (W20), health, nightly reconcile

- **Track / owner:** A money
- **Priority:** P1
- **Estimate:** 4
- **Depends on:** HF-003, HF-004, HF-030
- **Spec refs:** features/15-audit-ops.md §Logic 4–5, §Acceptance criteria; api.md §Ops; screens.md §W20

## Goal
Admins can search every money event by PayPal id and see system health (the audit table itself is already P0 in HF-003).

## Scope
- `GET /api/admin/audit?brandId&entity&from&to` (+ PayPal id search); `GET /api/admin/health` (PayPal token ok, Channel3 ok, queue depth, webhooks last hour).
- W20: search bar, events table (AG Grid), health tiles, action buttons (verify brand, retry settlement, replay price event — demo, void dangling), each confirmed and audited.
- Nightly reconcile: compare last-24 h settlements with PayPal GET authorization/capture; flag mismatches.

## Out of scope
- Dispute handling (P2).

## Acceptance criteria
- [ ] Search by capture id finds the event.
- [ ] Admin actions are themselves audited.
- [ ] Reconcile flags a planted mismatch.

## Test plan
- Manual W20 search; integration for reconcile.

## Notes & risks
- Spec question: the reconcile job's priority isn't stated, yet 17's acceptance ("check the PayPal sandbox for leftover authorizations via the reconcile job") depends on it. Until then, `demo:reset` uses the sweeper (HF-034).
