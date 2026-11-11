# HF-060: Bryntum Gantt order-status timeline

- **Track / owner:** B brand UI
- **Priority:** P1
- **Estimate:** 3
- **Depends on:** HF-023, HF-021, HF-035
- **Spec refs:** README.md §Designs (Bryntum Gantt); HOLDFAST-SPEC.md §5 (order status); HOLDFAST.md §4

## Goal
One order-status timeline (window → price watch → signal → lock → capture fan-out → payout → shipping) with a "Now" marker on the console, settlement view, payouts and the shopper's bid detail.

## Scope
- Shared Bryntum Gantt component fed from listing timestamps + audit events.
- Placements: W06, W08, W09, W15.

## Out of scope
- Editing tasks in the Gantt.

## Acceptance criteria
- [ ] Phases render with real timestamps and a Now marker.
- [ ] Works at 375 px or degrades to a vertical list.

## Test plan
- Manual on seed data.

## Notes & risks
- Spec question: the Gantt is "in scope" per the README Designs section and HOLDFAST docs, but no feature file or priority covers it. Ticketed P1; confirm whether it's P0 for the Bryntum sponsor prize.
- Bryntum licence/trial needed.
