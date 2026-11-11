# HF-034: Crons: window expiry, abandoned approvals, dangling-hold sweeper

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-027, HF-016
- **Spec refs:** data-model.md §Listing state machine (EXPIRED), §Locking rule 8; features/03-offer-page-held-bid.md §Edge cases (abandon 30 min); features/10-clearing-engine.md §Hold-age guard; README.md §Tech stack (Render cron)

## Goal
No hold outlives its listing and no listing outlives PayPal's 3-day card-hold guarantee.

## Scope
- Every minute: OPEN/ROUNDS listings past `clear_deadline_at` → EXPIRED, void all HELD bids (`void_reason=WINDOW_EXPIRED`).
- Every 5 min: PENDING_APPROVAL bids older than 30 min → ABANDONED (no hold exists).
- Nightly (and on demand for demo reset): bids HELD on EXPIRED/CANCELLED/SETTLED listings → void.
- Render cron definitions; each run audited as `SYSTEM`.

## Out of scope
- Nightly reconcile against PayPal (HF-058, P1). Auto-roll (HF-053, P1).

## Acceptance criteria
- [ ] Listing past its clear deadline → EXPIRED and every hold voided with PayPal ids audited.
- [ ] Abandoned approval → ABANDONED after 30 min.
- [ ] Sweeper finds and voids a planted dangling hold.

## Test plan
- Integration with backdated timestamps.

## Notes & risks
- Spec question: `clear_deadline_at` = "rounds end (or window close) + 6 h" — must be recomputed when rounds start/stop (HF-036).
