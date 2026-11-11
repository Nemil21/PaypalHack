# HF-051: Brand agent recommendations and "Ask about this book" panel

- **Track / owner:** B brand UI
- **Priority:** P1
- **Estimate:** 4
- **Depends on:** HF-022, HF-024
- **Spec refs:** features/09-brand-agent.md §Logic 1–4, §Edge cases, §Acceptance criteria; api.md §`POST /brand-agent/ask`; screens.md §W06 (agent panel), §W07

## Goal
A code-computed recommendation ("Clear 240, cutoff $219: $54.2k vs $11.4k liquidation") explained by Claude with read-only tools.

## Scope
- `core/recommend.ts`: scan quantities 1..N with `clear()`; maximize net recovery subject to cutoff ≥ floor and cutoff ≥ (1 − maxDiscount) × public low; return `{quantity, cutoffCents, grossCents, netCents, liquidationCents, alternatives[2]}`.
- `POST /api/brand-agent/ask {listingId, question}` with read-only tools `get_book_summary`, `simulate_clear(quantity)`.
- W06 panel: recommendation card (numbers from JSON fields only), "Apply to slider", ask box + answer thread; recommendation shown in W07.
- Fallbacks: no bids → "Not enough demand yet"; Claude down → code recommendation without prose.

## Out of scope
- Nudge text (P0, HF-036).

## Acceptance criteria
- [ ] Recommendation equals the brute-force optimum on 5 fixture books.
- [ ] The agent has no tool that changes state (besides send_nudge in HF-036).
- [ ] "Apply to slider" updates W06 instantly.

## Test plan
- Unit: recommend.ts fixtures. Manual: 3 questions on the demo seed.

## Notes & risks
- The demo script (HOLDFAST.md §7 beat 5) uses the recommendation; if this stays P1, the video shows the slider instead.
- Spec question: `maxDiscount` "a brand setting" has no column in data-model.md.
