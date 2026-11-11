# HF-037: Live rounds console controls (W06)

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-036, HF-023
- **Spec refs:** features/19-live-rounds.md §Screens, §User stories; screens.md §W06

## Goal
The brand starts rounds, watches raises arrive and expected revenue climb, and stops them.

## Scope
- "Start live rounds" control with target quantity (prefilled from slider), confirm.
- Round timer (round N, ends in mm:ss, overall rounds end), Stop button.
- Raises feed from SSE `bid.raised` / `round.nudged` (bid label, old → new amount, source, SIM chip).
- KPI "expected gross" refresh on each raise; banner "Rounds ended — press Clear within 6 h".

## Out of scope
- Bryntum phase timeline (HF-060, P1).

## Acceptance criteria
- [ ] Brand can start/stop rounds; agents cannot (API rejects agent actors).
- [ ] Raises appear live and gross updates.
- [ ] After rounds end, a 6 h Clear countdown is shown.

## Test plan
- Manual with SIM round agents (HF-046).

## Notes & risks
- Only brand users start rounds or Clear; the brand agent never does.
