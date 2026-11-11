# HF-061: Brand mobile alert and clear approval (M10)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 9
- **Estimate:** 2
- **Depends on:** HF-028, HF-054b
- **Spec refs:** screens.md §M10; features/08-brand-console.md §Screens; features/13-notifications.md (brand_window_closing)

## Goal
The brand gets "Window closes in 6 h · $61k held" on their phone and can review and clear with slide-to-confirm.

## Scope
- Part 1 (no push needed): responsive `/brand/listings/:id` M10 screen with mini KPIs, compact curve, recommendation card (HF-051a), "Review & clear" sheet with W07 numbers and slide-to-confirm on the shared `useClear()` hook (HF-028); "Stop rounds & clear" during ROUNDS.
- Part 2: `brand_window_closing` push (HF-054b) deep-links to M10.
- States: open, rounds, clearing progress, done.

## Out of scope
- Native app (PWA only).

## Acceptance criteria
- [ ] Same numbers and same Clear API as W07, including `BOOK_CHANGED` / `NOT_CLEARABLE` 409 handling with one-click confirm.
- [ ] Push opens M10 on a phone.

## Test plan
- Manual on a phone.

## Notes & risks
- Resolved (user override, Q#31): kept at P1 (§5 proposed P2); part 1 doesn't wait for push.
