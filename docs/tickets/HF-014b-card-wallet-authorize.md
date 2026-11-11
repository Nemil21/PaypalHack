# HF-014b: Browser CARD (card fields) and PAYPAL wallet holds, `POST /bids/:id/authorize`

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 5
- **Estimate:** 3
- **Depends on:** HF-014a, HF-063
- **Spec refs:** api.md §`POST /bids` (CARD, PAYPAL), §`POST /bids/:id/authorize`, §`GET /bids/return`; features/03-offer-page-held-bid.md §Logic 4, §Edge cases (abandon, window closes while approving); data-model.md §Bid state machine; `docs/_sources/paypal-js-sdk-v6-setup.md`

Merges the former HF-015 (wallet approval flow) as the PAYPAL variant.

## Goal
Shoppers hold a bid from the browser with a card or their PayPal account, through one shared authorize-and-land path, with no dangling hold when the window closes meanwhile.

## Scope
**Part 1 (fallback, build first):** labelled "Use sandbox test card" button behind `DEMO_TEST_CARD` (on in `DEMO_MODE`): `POST /api/bids {paymentMethod: 'TEST_CARD'}` makes the server place an S1-style hold with PayPal's public test card through HF-014a's server-side card path. No card data comes from the browser. README limits state it.

**Part 2 (full; S7 in HF-063 decides build order, not inclusion):**
- Browser CARD: `POST /api/bids {paymentMethod: 'CARD'}` creates an `intent: AUTHORIZE` order with no card data, `payment_source.card.attributes.verification.method=SCA_WHEN_REQUIRED` and `attributes.vault.store_in_vault=ON_SUCCESS` → `201 {bidId, orderId, status: PENDING_APPROVAL}`. The browser submits JS SDK v6 card fields to PayPal (3DS if needed), then calls `POST /api/bids/:id/authorize`.
- PAYPAL wallet (ex-HF-015): order with `payment_source.paypal.experience_context {return_url, cancel_url, user_action: CONTINUE, shipping_preference: NO_SHIPPING}` → `201 {bidId, orderId, status: PENDING_APPROVAL, approveUrl}` where `approveUrl` is read from `links[rel=payer-action]`. `GET /api/bids/return?token=` finds the bid by order id and runs the shared authorize path, then 302 `/bids/:id?held=1`.
- Shared `authorizeAndLand(bid)` used by `/authorize`, `/return` and the HF-034 cron:
  1. Bid must be PENDING_APPROVAL (already HELD → return it; ABANDONED → don't authorize, W21).
  2. **Check biddable first**: if the listing no longer accepts bids, don't authorize; mark ABANDONED (`WINDOW_CLOSED`), W21 "Window closed. Nothing was held."
  3. `pp.authorizeOrder` with `PayPal-Request-Id = authz-<bidId>` (D5, M2); on `ORDER_ALREADY_AUTHORIZED`, GET the order and use its authorization.
  4. Assert `authorization.amount == bid.amount_cents` and `custom_id == bid.id`; mismatch → void + audit `AMOUNT_MISMATCH`.
  5. `landHold` (D1). If Clear/cancel/expiry won the race during authorize, the new authorization is voided (`void-<bidId>`). For CARD, read `vault.id` from the response into `shoppers.paypal_vault_id`.
  6. Replacement case: when the bid has `replaces_bid_id` (a wallet raise from HF-018), `landHold` runs the raise swap instead of a plain PENDING→HELD.
- Cancel URL → bid stays PENDING_APPROVAL; HF-034 GETs the order after 30 min (approved + still biddable → authorize and land; otherwise ABANDONED).
- Wallet bids have no vault: they can't auto-raise, roll or use MCP VAULT; raises return `approveUrl`.
- Audit each step.

## Out of scope
- Offer-page UI (HF-019). Webhook backup for missed returns (HF-033; the HF-034 order GET is the primary backstop, M18).

## Acceptance criteria
- [ ] Part 1: the test-card button lands a real sandbox hold HELD.
- [ ] Browser card-fields hold lands HELD; card data never reaches our API; the vault id is stored.
- [ ] Wallet hold with the US sandbox personal account ends HELD.
- [ ] Return / authorize replay (refresh, double click) does not authorize twice.
- [ ] Window closed before return → no authorization call, W21.
- [ ] Race (stub): Clear commits during authorize → the new authorization is voided; nothing dangles (B2).
- [ ] Wallet raise return completes the swap; old hold VOIDING(`REPLACED`).

## Test plan
- Manual (sandbox browser): test-card button; card fields (incl. a 3DS test card); wallet approve, cancel, window-closed variants.
- Integration (stub): authorize replay; `ORDER_ALREADY_AUTHORIZED`; amount mismatch; late landing.

## Notes & risks
- Card fields, wallet approve-then-authorize and authorize replay are unproven; HF-063 (S7) runs them first (B8, M19).
- Resolved (B8): CARD returns PENDING_APPROVAL, not 201 HELD; api.md updated.
- Resolved (user override): §5 made the wallet path conditional on S7 (else P1); it stays P0 here. If S7 fails, Part 1 carries the demo while Part 2 continues.
