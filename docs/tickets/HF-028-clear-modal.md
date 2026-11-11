# HF-028: Clear confirmation modal (W07) and role gating

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-027, HF-024
- **Spec refs:** features/08-brand-console.md §Layout 7–8, §Edge cases, §Acceptance criteria; features/10-clearing-engine.md §Edge cases; screens.md §W07; features/01-brand-onboarding.md §Acceptance (VIEWER)

## Goal
The brand confirms exact money numbers with a typed confirm before Clear; stale books are caught and re-reviewed.

## Scope
- Summary: quantity, cutoff, gross (sum of winners' bids), winners, losers; money table gross / fee / net / vs liquidation; "fewer eligible than Q" note.
- Plain-English line consistent with pay-your-bid (see spec question).
- Type-to-confirm `CLEAR 240`; Confirm disabled until typed; submitting state.
- 409 `STATE_CONFLICT` → re-simulate, show "Book changed: new gross $54.0k", re-review; 409 `HOLDS_TOO_OLD` → message + "Release all" (cancel window).
- Success → W06 switches to W08.
- VIEWER: Clear hidden/disabled, read-only.

## Out of scope
- M10 slide-to-confirm (HF-061, P1).

## Acceptance criteria
- [ ] Modal shows exact money numbers and requires the typed confirm.
- [ ] Book change while open → 409 path shows new numbers.
- [ ] VIEWER cannot Clear (UI and API).

## Test plan
- Manual: clear against seed; force 409 by streaming a bid while the modal is open.

## Notes & risks
- Spec question: 08 §Layout 7 ("Holds above $219 are charged $219; the rest released") and W07 ("Winners are charged $219") describe uniform pricing and contradict pay-your-bid. Proposed copy: "Each winner is charged their own bid (lowest $219); everyone else's hold is released."
