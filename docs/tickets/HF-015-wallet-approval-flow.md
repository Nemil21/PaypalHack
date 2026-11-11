# HF-015: PayPal wallet approval flow and return URL

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-014
- **Spec refs:** api.md §`POST /bids` (PAYPAL), §`GET /bids/return`; features/03-offer-page-held-bid.md §Logic 4, §Edge cases (abandon, window closes while approving); data-model.md §Bid state machine

## Goal
Shoppers paying with their PayPal account approve once in PayPal and come back to a HELD bid, with no hold left behind if the window closed meanwhile.

## Scope
- PAYPAL path of `placeBid`: order with `payment_source.paypal.experience_context.return_url/cancel_url` → 201 `{bidId, status: PENDING_APPROVAL, approveUrl}`.
- `GET /api/bids/return?token=` → find bid by order id → `pp.authorizeOrder` → PENDING_APPROVAL→HELD → 302 `/bids/:id?held=1`.
- If the listing is no longer biddable on return: authorize, then immediately void (settlement-style request id), mark VOIDED, 302 to W21 "Window closed, your $229 was released".
- Cancel URL → leave PENDING_APPROVAL (abandon cron in HF-034).
- Audit each step.

## Out of scope
- `PAYMENT.AUTHORIZATION.CREATED` webhook backup (HF-033).

## Acceptance criteria
- [ ] Manual: wallet hold with the US sandbox personal account ends HELD.
- [ ] No hold is left behind when the window closed during approval.
- [ ] Return replay (refresh) does not authorize twice.

## Test plan
- Manual (sandbox browser): approve, cancel, window-closed variants.
- Integration: return handler with mocked PayPal.

## Notes & risks
- Wallet holds are **not yet proven** in sandbox (HOLDFAST.md §6). Do this ticket early; the demo can fall back to card holds plus one wallet hold (HOLDFAST-SPEC §11).
- Use `transition(PENDING_APPROVAL→HELD)` so the return URL and the webhook can't double-apply.
