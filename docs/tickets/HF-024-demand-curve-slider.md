# HF-024: Demand curve (AG Charts) and quantity slider

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 3
- **Depends on:** HF-023
- **Spec refs:** features/08-brand-console.md §Layout 3–4, §Edge cases, §Acceptance criteria; features/10-clearing-engine.md §Acceptance (identical results)

## Goal
The brand drags a slider and instantly sees cutoff, gross and recovery, computed by the same code the server will run.

## Scope
- AG Charts step line: x = price, y = bids at or above; second series held $; markers for floor (brand only), public low, projected cutoff; hover "120 bids ≥ $229 · $27.5k held".
- Slider range **1…min(quantity, eligible)** with the clamp tooltip from 08 §Edge cases (`clear()` rejects Q ≤ 0).
- While dragging: rank once per book change and use prefix sums; on release call shared `clear()` from `packages/shared` for the exact numbers. Updates the cutoff marker, KPIs and the grid's "Would win?" column.
- Owns the slider store (zustand or context) `{quantity, clearResult}`; HF-025, HF-028, HF-037a/b and HF-051a read it. HF-028 sends `clearResult.gross` as `expectedGrossCents`.
- `setSliderQuantity()` for "Apply to slider" (HF-051a) and the target-quantity input for rounds (HF-037a).
- `recoveryMultiple = grossCents / liquidationCents`, with `liquidationCents = winners × liquidation_quote_cents`, defined in `packages/shared` (same as `/simulate`).

## Out of scope
- Clear modal (HF-028).

## Acceptance criteria
- [ ] Slider recomputes cutoff and gross exactly as the server does (shared code + test against `/simulate`).
- [ ] Slider update < 50 ms on a 300-bid book; prefix-sum path stays smooth at 5k bids.
- [ ] Curve updates live as bids arrive.
- [ ] AG Charts step interpolation, crossLines and the second series render with no watermark under the licence key.

## Test plan
- Unit: curve builder; prefix-sum vs `clear()` parity; parity test client vs `/simulate`.
- Manual: 300-bid seed performance.

## Notes & risks
- 5k+ bids: the curve is computed server-side (HF-022).
