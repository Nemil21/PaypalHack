# HF-021: My bids (W14 / M03) and bid detail timeline (W15 / M04)

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-016, HF-007
- **Spec refs:** screens.md §W14, §W15, §M03, §M04, §M06; features/15-audit-ops.md §Logic 3, §Acceptance criteria; features/06-price-watcher.md §Screens

## Goal
Shoppers see every bid and a friendly timeline of everything that happened to it, including price-drop releases and won/lost results.

## Scope
- W14/M03: tabs Live / Won / Released; bid cards (product, your bid, status pill, time left, "below likely clearing" hint, source chip e.g. "via Claude Desktop"); swipe-to-cancel on mobile with confirm.
- W15/M04: summary; vertical timeline from audit events (Held → Price checked → Below-cutoff nudge → Raised → Won at your bid $229 / Released) with times and plain reasons; money box (held, charged, released); sticky Raise / Cancel bar.
- Price-drop release shown as a timeline event + M06-style sheet (old vs new price, "Hold released", affiliate "Buy at Best Buy $219").
- Won state shows "You won at your bid of $X" (no tracking; P1).

## Out of scope
- Notification bell (HF-054, P1). Tracking (HF-059, P1). Bryntum Gantt (HF-060, P1).

## Acceptance criteria
- [ ] Timeline shows held → (signals) → won/lost → captured/voided, with times.
- [ ] Money copy follows held / charged / released rule.
- [ ] Works at 375 px.

## Test plan
- Manual against seeded bids in each state.

## Notes & risks
- Spec question: W18 copy "You got it at $219; you bid $229" and the 13 `won` template ("$10 released") describe uniform-price clearing, which contradicts pay-your-bid. Use "You won at your bid of $229" (HOLDFAST-SPEC §3.8) until confirmed.
