# HF-058: Ops / audit screen (W20), health, nightly capture reconcile

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 8
- **Estimate:** 3.5
- **Depends on:** HF-003b, HF-004, HF-030a, HF-006, HF-025
- **Spec refs:** features/15-audit-ops.md §Logic 4–5, §Acceptance criteria; api.md §Ops; screens.md §W20

## Goal
Admins can search every money event by PayPal id and see system health (the audit table itself is P0 in HF-003b).

## Scope
- `GET /api/admin/audit?brandId&entity&from&to` (+ PayPal id search); `GET /api/admin/health` (PayPal token ok, Channel3 ok, settlement queue depth, webhooks last hour). Admins come from `ADMIN_EMAILS` (D13, HF-006). Public `/healthz` is HF-048a.
- W20: search bar, events table (AG Grid, HF-025 setup), health tiles, action buttons, each confirmed and audited: verify brand (HF-011a), retry settlement (HF-030a; refused after SETTLED), replay price event (demo, HF-042a), void dangling (**calls the HF-034 sweeper**).
- Nightly capture/void reconcile: compare last-24 h settlements with PayPal GET authorization/capture; flag mismatches.

## Out of scope
- `reconcile:holds` (P0, moved to HF-034 per D19). Dispute handling (production path, README).

## Acceptance criteria
- [ ] Search by capture id finds the event.
- [ ] Admin actions are themselves audited.
- [ ] Reconcile flags a planted mismatch (stub).
- [ ] "Void dangling" runs the same code path as the HF-034 sweeper.

## Test plan
- Manual W20 search; integration on the FakePayPal stub for reconcile.

## Notes & risks
- Resolved (D19): the hold reconcile that `demo:reset` needs is P0 in HF-034; this ticket keeps only the nightly capture reconcile.
