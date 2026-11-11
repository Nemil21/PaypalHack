# HF-014a: Bid service core: `placeBid`, VAULT holds, one live bid, mandate cap

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 4
- **Estimate:** 3
- **Depends on:** HF-003a, HF-003b, HF-004, HF-006
- **Spec refs:** api.md §`POST /bids`; features/03-offer-page-held-bid.md §Logic 4, §Edge cases; features/05-mandates-rolling.md §Logic 2; data-model.md §bids, §Bid state machine, §Locking rules 3–5; spikes S1, S2

## Goal
The single internal `placeBid()` service that REST, the buyer agent, MCP, the seeder and live rounds all call to create a real PayPal hold, landing every hold through `landHold` (D1).

## Scope
- `core/bids.ts#placeBid({shopperId, listingId, amountCents, paymentMethod, mandateId?, intentId?, releaseIfCheaper=true, source, utmSource?, idempotencyKey})`:
  1. Idempotency (HF-003b, scoped per principal + request hash) → replay the original result.
  2. `isBiddable(listing, now)` from `packages/shared` (D7: `status='OPEN' AND now() < window_closes_at`) else 409 `WINDOW_CLOSED`, no PayPal call. ROUNDS accepts raises only (HF-018).
  3. One transaction: `pg_advisory_xact_lock(hash(shopper_id, listing_id))`; existing live bid → 409 `ALREADY_BID {bidId, amountCents}` (D3); if `mandateId`, `mandates.authorize()` (HF-017a hook, D12 sum incl. PENDING_APPROVAL) with `FOR UPDATE`; insert the bid PENDING_APPROVAL with `mandate_id`, `payment_method`, `public_price_at_placement`, `release_if_cheaper`, `utm_source`, DB `placed_at`. Commit.
  4. `pp.createAuthOrder` with `PayPal-Request-Id = bid.id`, `invoice_id = custom_id = bid.id` (D5).
  5. VAULT (`vault_id` + `stored_credential`: `payment_initiator=CUSTOMER` when a human is present, `MERCHANT` only for rounds auto-raise and roll) → result per HF-004 (`held / pending / denied / needs_approval`). Only authorization status `CREATED` counts as a hold (M6).
  6. `landHold(bid, authorization)` (HF-003a, D1): re-lock listing `FOR SHARE` + biddable, mandate `FOR UPDATE` + ACTIVE + cap; flip PENDING_APPROVAL→HELD; store `paypal_order_id`, `paypal_authorization_id`, `authorized_at` (= PayPal `create_time`, D6), `authorized_amount_cents` (M1). Any failed check → roll back, `voidBid` the new authorization, bid VOIDED with reason (`WINDOW_CLOSED` / `MANDATE_PAUSED` …), return 409 `WINDOW_CLOSED` with "released" copy.
  7. Audit `BID_PENDING`, `BID_HELD` with PayPal ids; SSE `bid.held` via `pg_notify` **after** landing commits.
- Outcome handling:
  - Declined / `PAYER_ACTION_REQUIRED` (3DS on vault) → bid → `HOLD_FAILED` (terminal end state per HF-002; a retry is a new bid row), 422 `HOLD_FAILED`; the idempotency record is not stored as final, so the client mints a new key to retry (M3).
  - Timeout / 5xx on create → retry with the same request id; still unknown → `needs_reconcile=true`, which the HF-034 sweeper replays with the same id (void if an authorization turns up).
- `POST /api/bids` route (Idempotency-Key required), source `OFFER_PAGE` by default, accepts `releaseIfCheaper`. Response includes `publicOffer {merchant, priceCents, url, updatedAt}` from cached `products.best_public_*`; a stale cache is refreshed asynchronously after commit (never on the money path). Server never rejects for being above it.
- Below-floor bids accepted (floor private).
- Raw `payment_source.card` (S1 style) is allowed only from server-side code: the seed (HF-045) and the labelled test-card button (HF-014b Part 1). Never from request input.

## Out of scope
- Browser CARD (card fields) and PAYPAL wallet two-step flows and `POST /bids/:id/authorize` (HF-014b). Raise (HF-018). Mandate rules themselves (HF-017a).

## Acceptance criteria
- [ ] A real sandbox vaulted MIT hold works with no shopper present; `authorized_at` and `authorized_amount_cents` are stored.
- [ ] A server-side test-card hold (seed path) lands HELD.
- [ ] Double submit with the same Idempotency-Key returns the same bid; only one PayPal order exists.
- [ ] Bid on a non-biddable listing (CLOSED window, ROUNDS, CLEARING) → `WINDOW_CLOSED`, no PayPal call.
- [ ] Second bid by the same shopper (new key, second tab) → 409 `ALREADY_BID`; the partial unique index `one_held_bid` holds under concurrency.
- [ ] Race (stub, 2 s PayPal latency): parallel `placeBid` vs Clear → no bid ends HELD on a CLEARING listing; the late hold is voided (B2).
- [ ] Race (stub): two tabs placing at once → exactly one HELD bid.
- [ ] Declined hold → `HOLD_FAILED`, bid in the declined end state, not counted by any cap.
- [ ] The bid appears on the console SSE stream within 2 s.

## Test plan
- Integration (FakePayPal stub): idempotent replay; closed listing; place vs Clear; two tabs; decline; create timeout → `needs_reconcile`.
- Integration (sandbox): vaulted MIT hold (S2 pattern); seed-path test card hold (S1 pattern); order-create replay with the same request id.

## Notes & risks
- Resolved (D7, Q#5/Q#6): new bids need `OPEN AND now() < window_closes_at`; ROUNDS accepts raises only.
- Resolved (D12, Q#19): `bids.mandate_id` is set at placement to the mandate that authorized it; offer-page bids carry none unless the shopper opts in from W13.
- Resolved (D3, Q#25): no silent re-route; a second bid returns `409 ALREADY_BID`. Lowering = cancel + new bid, losing time priority.
- Resolved (D1, B1/B2/B9): every hold lands through `landHold`; lock order listing → mandate → bids by id.
