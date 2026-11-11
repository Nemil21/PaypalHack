# HF-054b: Notifications: email, web push, M11 set

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 8
- **Estimate:** 2.5
- **Depends on:** HF-054a
- **Spec refs:** features/13-notifications.md §Channels; api.md §`POST /notifications/subscribe`; screens.md §M06, §M07, §M11

## Goal
The same notifications reach the shopper's inbox and phone, and the M11 board shows them on mobile.

## Scope
- Email fan-out via Resend (console-logged when no key / local), reusing HF-054a templates and dedupe.
- Web push: service worker, VAPID keys, `POST /notifications/subscribe`; HTTPS on Render; iOS requires an installed PWA (16.4+).
- M11 notification board; M06/M07 push entry points (price drop, raise nudge).
- Brand `brand_window_closing` push (used by HF-061).

## Out of scope
- Brand notification preferences UI beyond a toggle list.

## Acceptance criteria
- [ ] A push arrives on a phone for `price_drop_released` from the deployed URL.
- [ ] Email for `won` renders D14 copy (console log in demo).
- [ ] M11 lists the same items as the in-app bell.

## Test plan
- Manual: phone push (Android Chrome + installed iOS PWA). Unit: email rendering.

## Notes & risks
- Kept in scope (P1) by user override (§5 proposed P2). Push on a phone is the riskiest piece; build last within the ticket.
