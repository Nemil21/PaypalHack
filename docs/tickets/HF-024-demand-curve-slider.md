# HF-024: Demand curve (AG Charts) and quantity slider

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-023
- **Spec refs:** features/08-brand-console.md §Layout 3–4, §Edge cases, §Acceptance criteria; features/10-clearing-engine.md §Acceptance (identical results)

## Goal
The brand drags a slider and instantly sees cutoff, gross and recovery, computed by the same code the server will run.

## Scope
- AG Charts step line: x = price, y = bids at or above; second series held $; markers for floor (brand only), public low, projected cutoff; hover "120 bids ≥ $229 · $27.5k held".
- Slider 0…quantity clamped to qualifying bids (≥ floor) with tooltip; client-side `clear()` from `packages/shared` (no network), updates cutoff marker, KPIs and the grid's "Would win?" column.
- Expose `setSliderQuantity()` for "Apply to slider" (HF-051) and target-quantity input for rounds (HF-037).

## Out of scope
- Clear modal (HF-028).

## Acceptance criteria
- [ ] Slider recomputes cutoff and gross exactly as the server does (shared code + test against `/simulate`).
- [ ] Slider update < 50 ms on a 300-bid book.
- [ ] Curve updates live as bids arrive.

## Test plan
- Unit: curve builder; parity test client vs `/simulate`.
- Manual: 300-bid seed performance.

## Notes & risks
- 5k+ bids: compute curve server-side (already in HF-022).
