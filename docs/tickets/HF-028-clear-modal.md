# HF-028: Clear confirmation modal (W07), 409 handling and role gating

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** HF-027, HF-024
- **Spec refs:** features/08-brand-console.md §Layout 7–8, §Edge cases, §Acceptance criteria; features/10-clearing-engine.md §Edge cases; screens.md §W07; features/01-brand-onboarding.md §Acceptance (VIEWER)

## Goal
The brand confirms exact money numbers with a typed confirm before Clear; stale books are caught and re-confirmed in one click.

## Scope
- `useClear()` hook (reused by HF-061 M10): one `Idempotency-Key` per user action, reused on retry.
- Summary: quantity, cutoff, gross (sum of winners' bids), winners, losers; money table gross / fee (labelled "estimated; final on captured amount", shared `feeCents`) / net / vs liquidation; "Only 230 eligible bids will clear" above the input when eligible < Q.
- D14 copy only: "Each winner is charged their own bid (lowest $219, average $226). Everyone else's hold is released. Your bank may show it as pending for a few days." Pre-capture wording "will be charged". Use the shared copy helpers from HF-007.
- Type-to-confirm `CLEAR <Q>`; Confirm disabled until typed; submitting state.
- 409 handling (M12):
  - `BOOK_CHANGED` → show "Book changed: new gross $54.0k" and a one-click "Confirm $54.0k"; the typed confirm stays valid if Q is unchanged.
  - `NOT_CLEARABLE` with status CLEARING / SETTLED / PAID_OUT → go to W08 (a lost success response).
  - `HOLDS_TOO_OLD` → message + "Release all" (HF-012b cancel, allowed from ROUNDS).
- During ROUNDS_ACTIVE the primary action is "Stop rounds & clear": call `rounds/stop` (book freezes, D7), re-simulate, then confirm.
- Success → W06 switches to W08.
- VIEWER: Clear hidden/disabled, read-only (seeded VIEWER via `DEMO_MODE` login).

## Out of scope
- M10 slide-to-confirm (HF-061, P1).

## Acceptance criteria
- [ ] Modal shows exact money numbers and requires the typed confirm.
- [ ] Book change while open → one-click confirm of the new numbers succeeds.
- [ ] A retried Clear whose first response was lost lands on W08, not "book changed".
- [ ] During rounds, "Stop rounds & clear" clears without a 409 loop.
- [ ] VIEWER cannot Clear (UI and API).
- [ ] No copy anywhere says winners are charged one uniform price.

## Test plan
- Manual: clear against seed; force 409 by streaming a bid while the modal is open; clear during rounds.

## Notes & risks
- Resolved (D14, Q#1): pay-your-bid copy above; 08 §Layout 7 and W07 updated in the spec.
- The demo pauses `sim:stream` while the modal is open (HF-046).
