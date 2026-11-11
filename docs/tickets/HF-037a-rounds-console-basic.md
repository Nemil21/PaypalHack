# HF-037a: Live rounds console basic: start/stop, timer, confirm copy

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1
- **Depends on:** HF-036a, HF-023
- **Spec refs:** features/19-live-rounds.md §Screens, §User stories; screens.md §W06

## Goal
The brand starts rounds from the console, advances or stops them, and sees the round state and Clear countdown.

## Scope
- "Start live rounds" control with target quantity (prefilled from the slider) and confirm copy: "Starting rounds closes bidding to new bids. Rounds end by {roundsEndAt}. Clear by {clearDeadlineAt}."
- Round header: round N, "ends in mm:ss" (from `round_ends_at`), overall rounds end; "Next round" and "Stop" buttons.
- Inline target-quantity edit calling `PATCH /listings/:id/rounds`.
- KPI "expected gross" refetch on `round.*` and `bid.raised` (debounced, via HF-023).
- Banner after `round.ended`: "Rounds ended. Press Clear by {clearDeadlineAt}."
- Controls hidden/disabled for VIEWER.

## Out of scope
- Raises feed, extension display, raise flash (HF-037b). Bryntum phase timeline (HF-060).

## Acceptance criteria
- [ ] OWNER/MANAGER can start, advance and stop rounds; VIEWER sees state but no controls; the API rejects agent actors.
- [ ] Timer and banner update from SSE without reload.
- [ ] Driven end to end by the HF-036a fixture replay script.

## Test plan
- Manual with `npm run dev:rounds-replay`, then with SIM round agents (HF-045/HF-038b).

## Notes & risks
- Only brand users start rounds or Clear; the brand agent never does.
- During ROUNDS the Clear button reads "Stop rounds & clear" (HF-028).
