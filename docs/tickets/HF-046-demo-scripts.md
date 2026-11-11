# HF-046: Demo scripts: sim:stream, SIM round agents, demo:decline, demo:reset

- **Track / owner:** D integrations & demo
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-045, HF-036, HF-038, HF-030
- **Spec refs:** features/17-demo-seeding.md §Seed script 6, §Demo script hooks, §Acceptance criteria; features/19-live-rounds.md §Test plan; HOLDFAST-SPEC.md §13 (SIM agents raise after a nudge)

## Goal
Make the recording reliable: a live-looking book, SIM agents that react to nudges, one deterministic decline, and a clean reset.

## Scope
- `npm run sim:stream`: 1 SIM bid every 2–4 s.
- SIM round agents: ~20 SIM shoppers with mandates react to nudges via the HF-038 rule (labelled SIM).
- `npm run demo:decline`: flags one winner so its capture sends `PayPal-Mock-Response INSTRUMENT_DECLINED`.
- `npm run demo:reset`: voids all holds (sweeper), verifies none left, reseeds.

## Out of scope
- Price-drop replay (HF-042).

## Acceptance criteria
- [ ] Reset leaves no dangling sandbox holds.
- [ ] Decline produces exactly one promotion in W08.
- [ ] SIM raises appear in the rounds feed with SIM chips.

## Test plan
- Run seed → rounds → clear → reset twice.

## Notes & risks
- The decline flag must only be settable by the script / admin, never by request input.
