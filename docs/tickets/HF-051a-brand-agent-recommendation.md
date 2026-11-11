# HF-051a: Brand agent recommendation card (code-only)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 7
- **Estimate:** 1
- **Depends on:** HF-022, HF-024
- **Spec refs:** features/09-brand-agent.md §Logic 1–2, §Edge cases, §Acceptance criteria; screens.md §W06 (agent panel), §W07

## Goal
A code-computed recommendation ("Clear 240, cutoff $219: $54.2k vs $11.4k liquidation") on W06 and W07, with no model call. First P1 ticket to pick up.

## Scope
- `core/recommend.ts`: scan quantities 1..min(qty, eligible) with `clear()` over `loadClearInput` (D8). Objective: maximize net recovery subject to cutoff ≥ max(floor, (1 − `brands.max_discount_bps`/10000) × public low). Return `{quantity, cutoffCents, grossCents, netCents, liquidationCents, alternatives[2]}`.
- Seed `max_discount_bps = 2200` (HF-045) so $279 × 0.78 ≈ $218 gives 240 at $219.
- W06 recommendation card (numbers from JSON fields only), "Apply to slider" (HF-024 slider store); recommendation shown in W07 (HF-028).
- No bids → "Not enough demand yet".

## Out of scope
- Claude "Ask" panel and prose explanation (HF-051b).

## Acceptance criteria
- [ ] Recommendation equals the brute-force optimum on 5 fixture books, including books where the discount constraint binds and where it doesn't.
- [ ] "Apply to slider" updates W06 instantly.
- [ ] Changing the floor never leaks into shopper-facing output (recommendation is brand-only).

## Test plan
- Unit: recommend.ts fixtures.

## Notes & risks
- Under pay-your-bid every eligible bid is ≥ floor > liquidation, so net rises with Q unless the discount constraint binds; the objective above is what makes "240 at $219" reproducible.
- Resolved (D17 / HF-002): `brands.max_discount_bps` exists in the frozen schema.
- Demo beat 5 (HOLDFAST.md §7) uses this card.
