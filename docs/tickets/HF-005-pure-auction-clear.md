# HF-005: Pure pay-your-bid `clear()` with property tests

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 1
- **Depends on:** HF-001
- **Spec refs:** features/10-clearing-engine.md §Rules, §Acceptance criteria, §Test plan; data-model.md §Locking rule 7

## Goal
The single deterministic auction function used by the server Clear, the console slider, the recommender and the live-round runner.

## Scope
- `packages/shared/auction.ts`: `clear(bids, q, floor)` exactly as in 10: eligible = amount ≥ floor; sort `amount DESC, placedAt ASC, id ASC`; winners = first `min(q, eligible)`; cutoff = lowest winning bid; gross = sum of winners' own bids; reserve = remaining ranked; belowFloor.
- Reject `q <= 0`.
- Export helper `rank(bids)` for grid rank column and nudges.

## Out of scope
- DB access, Clear transaction (HF-027), fee math (HF-032).

## Acceptance criteria
- [ ] Property test (fast-check, 1k random books): winners ≤ Q; every winner ≥ cutoff ≥ floor; every eligible loser ≤ cutoff; each winner's charge = their bid.
- [ ] Ties at cutoff resolved by earlier `placedAt`, then `id`.
- [ ] Fewer eligible than Q → all eligible win.
- [ ] Same module importable from web (no Node-only deps).

## Test plan
- Unit + property tests (Vitest + fast-check).

## Notes & risks
- Server and console must import this same file; never re-implement in the UI (10 acceptance "identical results").
