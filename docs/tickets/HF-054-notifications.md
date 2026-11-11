# HF-054: Notifications: `notify()`, in-app list, email, web push, M11 set

- **Track / owner:** C shopper & agents
- **Priority:** P1
- **Estimate:** 4
- **Depends on:** HF-003, HF-021
- **Spec refs:** features/13-notifications.md (all); api.md §`/notifications/*`; screens.md §M06, §M07, §M11, §W14 (bell)

## Goal
Every money event reaches shoppers and brands in plain words (trimmed to P1 for the hackathon).

## Scope
- `notify(recipient, template, payload)` inserting `notifications` and fanning out; dedupe on entity + template.
- Templates from 13 (bid_held, price_drop_released, below_clearing, bid_rolled, won, lost, payment_failed, shipped, brand_*).
- In-app bell + list with unread counts and mark-as-read; `GET /notifications`, `POST /notifications/:id/read`.
- Email via Resend (console log in demo); web push (VAPID, `POST /notifications/subscribe`); M11 board.
- Wire calls into P0 code paths that currently only audit (price drop, promotion, nudges, won/lost, payout).

## Out of scope
- Brand notification preferences UI beyond a toggle list.

## Acceptance criteria
- [ ] Each template fires once per event.
- [ ] In-app list shows unread counts and mark-as-read.
- [ ] A push arrives on a phone for `price_drop_released`.

## Test plan
- Unit: template rendering. Integration: event → notification row. Manual: phone push.

## Notes & risks
- Spec question: the `won` template ("You got it at $219 (you bid $229). $10 released.") contradicts pay-your-bid; fix copy before shipping.
- Never put card or PayPal ids in notification text; links use signed short-lived tokens.
