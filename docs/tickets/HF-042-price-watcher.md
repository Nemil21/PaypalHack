# HF-042: Price watcher: Channel3 webhook, auto-void, labelled replay

- **Track / owner:** D integrations & demo
- **Priority:** P0
- **Estimate:** 4
- **Depends on:** HF-009, HF-016
- **Spec refs:** features/06-price-watcher.md §Logic 1–8, §Edge cases, §Acceptance criteria; api.md §`POST /webhooks/channel3`; features/17-demo-seeding.md §Demo script hooks (`demo:price-drop`)

## Goal
When an authorized store sells the exact product below a bid, release that bid (if the shopper opted in) within 60 s and point them to the cheaper offer.

## Scope
- `POST /api/webhooks/channel3` (`offer.price.changed`): verify signature; `webhook_events` dedupe; 200 fast; async processing.
- Match gate (HF-009) → else audit `PRICE_IGNORED` with reason.
- Update `products.best_public_price_cents` if lower.
- For each HELD bid on that product with `release_if_cheaper` and `amount_cents > newPrice`: HELD→VOIDING → `pp.void` → VOIDED `void_reason=PRICE_DROP`; audit (actor WATCHER) with the cheaper offer + affiliate link in `data`; SSE `bid.voided` (console toast).
- `POST /api/admin/replay-price-event` + `npm run demo:price-drop`: replays a fixture through the same path, marked "replayed event (demo)" in audit and UI.
- Channel3-outage banner flag on affected listings.

## Out of scope
- Re-bid lower under mandate ("keep me in under the new price"): needs intents (P1, HF-052).
- Email/push notification (HF-054, P1); the shopper sees the release + link in W15/M06 and W21 (HF-020/021).

## Acceptance criteria
- [ ] A real or replayed price event voids exactly the bids above the new price, within 60 s.
- [ ] Bids with "Release if cheaper" off are untouched.
- [ ] Non-matching offers are ignored and audited with a reason.
- [ ] WON bids during CLEARING are not voided.

## Test plan
- Unit: selection query.
- Integration: post fixture webhook → voids in sandbox. Manual: demo beat 4.

## Notes & risks
- S5 (Channel3 webhook reaches Render) is untested; build the replay path first.
- Spec question: with notifications (13) at P1, the 06 acceptance "shopper notification includes the cheaper offer link" is met in-app only (timeline/M06/W21). Confirm.
