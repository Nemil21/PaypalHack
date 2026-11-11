# HF-014: Bid service: `POST /bids` with card and vaulted holds

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 4
- **Depends on:** HF-003, HF-004, HF-006, HF-008
- **Spec refs:** api.md §`POST /bids`; features/03-offer-page-held-bid.md §Logic 4, §Edge cases; data-model.md §bids, §Bid state machine, §Locking rules 4–5; spikes S1, S2

## Goal
The single internal `placeBid()` service that REST, the buyer agent, MCP, the seeder and live rounds all call to create a real PayPal hold.

## Scope
- `core/bids.ts#placeBid({shopperId, listingId, amountCents, paymentMethod, intentId?, source, idempotencyKey})`:
  1. Idempotency replay → original result.
  2. Listing must be biddable (OPEN, inside window) else 409 `WINDOW_CLOSED`.
  3. Mandate check via `mandates.authorize()` when a mandate applies (hook; implemented in HF-017).
  4. Insert bid PENDING_APPROVAL (DB `placed_at`).
  5. `pp.createAuthOrder` with `PayPal-Request-Id = bid.id`, `custom_id = bid.id`.
  6. CARD (`store_in_vault: ON_SUCCESS`, save `shoppers.paypal_vault_id`) or VAULT (`vault_id` + stored_credential MIT) → authorization CREATED → PENDING_APPROVAL→HELD; store order + authorization ids.
  7. Audit `BID_PENDING`, `BID_HELD` with PayPal ids; SSE `bid.held`.
- `POST /api/bids` route (Idempotency-Key), source `OFFER_PAGE` by default; response includes `publicOffer {merchant, priceCents, url}` from Channel3 (refreshed if > 10 min old). Server never rejects for being above it.
- Below-floor bids accepted (floor private). Hold declined → 422 `HOLD_FAILED`, bid not HELD.
- Second bid by the same shopper on the same listing → route to raise (HF-018) once that exists.

## Out of scope
- PAYPAL wallet approval redirect (HF-015). Card fields UI (HF-019).

## Acceptance criteria
- [ ] A real sandbox card hold makes the bid HELD and stores `paypal_authorization_id`.
- [ ] A vaulted MIT hold works with no shopper present.
- [ ] Double submit with the same Idempotency-Key returns the same bid; only one PayPal order exists.
- [ ] Bid on a non-OPEN listing → `WINDOW_CLOSED`, no PayPal call.
- [ ] The bid appears on the console SSE stream within 2 s.

## Test plan
- Integration (sandbox): test card hold (S1 pattern), vaulted MIT hold (S2 pattern).
- Integration: idempotent replay; closed listing.

## Notes & risks
- Spec question: "check the listing is OPEN" — once `window_closes_at` passes, the listing stays OPEN until Clear/expiry (no transition), so bids would still be accepted. Proposed: also require `now < window_closes_at`. And during ROUNDS: are brand-new bids accepted, or only raises? (19 is silent.)
- Spec question: for a bid without an intent, which mandate applies (bids have `intent_id`, not `mandate_id`)? Proposed: the shopper's ACTIVE mandate whose `allowed_product_ids` include the product.
- Spec question: 03 "shopper bids twice → second becomes a raise"; what if the second amount is lower than the first?
- PayPal card fields (JS SDK v6) send card data straight to PayPal; the server only receives a token/order reference. Confirm the card-fields flow in HF-019 doesn't pass raw card data through our API.
