# HF-060: Bryntum Gantt: W08 settlement fan-out first, then the order-status timeline

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 8
- **Estimate:** 3
- **Depends on:** HF-035, HF-020 (part 2 only)
- **Spec refs:** README.md §Designs (Bryntum Gantt); HOLDFAST-SPEC.md §5 (order status); HOLDFAST.md §4; screens.md §W06, §W08, §W09, §W15

## Goal
A Bryntum Gantt that makes settlement visible (part 1), then one order-status timeline across the console, payouts and the shopper's bid detail (part 2).

## Scope
- **Part 1 (build first, ≈ 2 h): W08 live settlement Gantt.** One row per settlement, start/end from `settlements.started_at` / `finished_at` (RUNNING → SUCCEEDED/FAILED), a dependency arrow from a failed capture to its promotion (`unit_root_bid_id`), payout as the final milestone; updates from the W08 event stream (HF-035).
- **Part 2: order-status timeline** (window → price watch → rounds → lock → capture fan-out → payout → shipping) with a "Now" marker, shared component fed from listing timestamps + audit events, placed on W06, W09 and the shopper bid detail (W15, now in HF-020). Degrades to a vertical list at 375 px.
- Gantt trial package (`@bryntum/gantt@npm:@bryntum/gantt-trial`), lazy-loaded chunk.

## Out of scope
- Editing tasks in the Gantt.

## Acceptance criteria
- [ ] W08 Gantt shows each settlement with real times, the decline → promotion arrow and the payout milestone during the demo decline.
- [ ] Order timeline renders with real timestamps and a Now marker on W06, W09 and W15.
- [ ] Works at 375 px or degrades to a vertical list.
- [ ] Trial notice checked on video and lasts to Dec 21.

## Test plan
- Manual on seed data and during `demo:decline`.

## Notes & risks
- Resolved (user override, Q#30): full scope kept at P1; §5's narrowing becomes the build order (W08 first).
- Name Bryntum as a sponsor only once part 1 ships (HF-049).
