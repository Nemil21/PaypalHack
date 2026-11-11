# HF-061: Brand mobile alert and clear approval (M10)

- **Track / owner:** B brand UI
- **Priority:** P1
- **Estimate:** 2
- **Depends on:** HF-028, HF-054
- **Spec refs:** screens.md §M10; features/08-brand-console.md §Screens; features/13-notifications.md (brand_window_closing)

## Goal
The brand gets "Window closes in 6 h · $61k held" on their phone and can review and clear with slide-to-confirm.

## Scope
- M10 screen: mini KPIs, compact curve, recommendation card (if HF-051 shipped), "Review & clear" sheet with W07 numbers and slide-to-confirm.
- States: open, clearing progress, done.

## Out of scope
- Native app (PWA only).

## Acceptance criteria
- [ ] Same numbers and same Clear API as W07 (including 409 handling).

## Test plan
- Manual on a phone.

## Notes & risks
- Spec question: 08 is P0 but M10 depends on push (13, now P1); ticketed P1.
