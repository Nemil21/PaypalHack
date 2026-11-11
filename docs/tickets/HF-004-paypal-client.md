# HF-004: PayPal REST client + `FakePayPal` stub

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 2
- **Estimate:** 3
- **Depends on:** HF-001, HF-063
- **Spec refs:** api.md §PayPal calls used; data-model.md §Locking and idempotency rule 5; features/11-settlement-workflows.md §Workflow design (error classes); spikes/paypal-spikes.mjs (S1–S4), spikes/s7-results.md (HF-063); review SUMMARY D5, D11, B4, M2, M6, M16, M26

## Goal
Port the proven spike calls into a typed client the bid, settlement and payout code all share, with fixed request ids per call type, a three-way error classification and a stub that lets every race test run offline.

## Scope
- `packages/core/paypal/client.ts`: token cached until `expires_in − 60s`; refresh once on a mid-call 401 and retry with the same request id; `Prefer: return=representation`.
- `requestId` is a required branded type with **no default** (D5/INV-4):

  | Call | `PayPal-Request-Id` |
  |---|---|
  | order create | `bid.id` (+ `invoice_id = bid.id`, `custom_id = bid.id`) |
  | authorize | `authz-<bidId>` |
  | capture | `settlement.id` |
  | void (every path) | `void-<bidId>` |
  | payout | `sender_batch_id` = payout attempt id |
  | track (HF-059b) | `track-<shipmentId>` |
- `orders.ts`:
  - `createAuthOrder({bidId, amountCents, paymentSource})`: wallet with `experience_context.return_url`; card with `verification.method=SCA_WHEN_REQUIRED` + `vault.store_in_vault=ON_SUCCESS`; `card.vault_id` + `stored_credential` with `payment_initiator: CUSTOMER` (shopper present) or `MERCHANT` (rounds auto-raise, roll); raw card only from seed/spike code paths. Returns a discriminated result `held | pending | denied | needs_approval | unknown` judged by the **body** `status` (only authorization `CREATED` = held). Reads the approval link from `rel=payer-action` (or `approve`).
  - `authorizeOrder(orderId, bidId)` with `authz-<bidId>`; on `ORDER_ALREADY_AUTHORIZED` → `GET /v2/checkout/orders/{id}` and take the existing authorization (M2).
  - `capture(authId, settlementId)`: amount taken from the settlement's bid row (INV-5), `final_capture: true`.
  - `void(authId, bidId)` with `void-<bidId>`.
  - `getAuthorization(authId)`, `getOrder(orderId)`.
- `payouts.ts`: `payout({attemptId, email, amountCents, note})`, `getPayoutBatch(batchId)` and item status.
- `verifyWebhook(headers, body)` (injectable for tests).
- Error classes (D11, B4): `TRANSIENT` (5xx, 429, timeout), `TERMINAL` (`INSTRUMENT_DECLINED`, `AUTHORIZATION_EXPIRED`, a capture GET showing the auth still CREATED after a failed capture), **`RECONCILE`** (any 422 on capture or void): GET the authorization and act on its state: CAPTURED → SUCCEEDED with the existing capture id; VOIDED → SUCCEEDED for a void, TERMINAL + alert for a capture; EXPIRED → TERMINAL. Exact issue codes from HF-063.
- Timeouts on create/authorize (M6): retry in-call with the same id up to 3 times; still unknown → `unknown`, caller sets `needs_reconcile` and the sweeper (HF-034) replays with the same id.
- `FakePayPal` (M16) behind `PAYPAL_MODE=stub`: same interface; models the authorization state machine (CREATED → CAPTURED | VOIDED | EXPIRED; one capture, one void), request-id replay, injectable latency, 5xx, timeout, 422 and decline. Used by all race tests and dev seeds.
- Test-only `PayPal-Mock-Response` header (`INSTRUMENT_DECLINED`) set only from `settlements.mock_response` when `ALLOW_MOCK_DECLINE=true` and the base is sandbox; never from request input.
- Use the **APIMatic PayPal Context Plugin** while building this client and keep evidence (note or commit trailer) for the sponsor claim (M26).

## Out of scope
- Business logic (bids, settlement). `track` call and tracking UI (HF-059b).

## Acceptance criteria
- [ ] Sandbox: card hold → capture own amount → COMPLETED; hold → void → 204 (S1 pattern).
- [ ] Sandbox: vaulted MIT hold from `vault_id` returns `held` (S2 pattern).
- [ ] Same `requestId` on capture twice returns the same capture id (S3); void twice with `void-<bidId>` → second call maps to SUCCEEDED.
- [ ] A capture 422 "already captured" maps via RECONCILE to SUCCEEDED with the original capture id, never TERMINAL (B4).
- [ ] Mock decline is TERMINAL; a simulated 503 is TRANSIENT.
- [ ] A unit test asserts every exported call sets `PayPal-Request-Id` (compile error without one).
- [ ] `FakePayPal` passes the same contract test suite as the sandbox client.
- [ ] Client secret never leaves the server; logs redact tokens.

## Test plan
- Unit: amount conversion, classification table (incl. RECONCILE), token cache expiry and 401 refresh.
- Contract suite run against `FakePayPal` (CI) and the sandbox (manual / nightly).

## Notes & risks
- Same sandbox credentials as the spikes. Use a **US** sandbox business account (IN accounts fail holds and payouts; HOLDFAST.md §6).
- PayPal keeps request ids only for a limited time; our DB is the primary dedupe.
- Wallet and card-fields holds are proven only once HF-063 passes; until then they are typed but untested.
