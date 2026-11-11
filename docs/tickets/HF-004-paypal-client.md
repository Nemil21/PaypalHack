# HF-004: PayPal REST client (orders, payments, payouts, webhooks verify)

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-001
- **Spec refs:** api.md §PayPal calls used; data-model.md §Locking and idempotency rule 5; features/11-settlement-workflows.md §Workflow design (error classes); spikes/paypal-spikes.mjs (S1–S4)

## Goal
Port the proven spike calls into a typed client the bid, settlement and payout code all share, with explicit idempotency ids and error classification.

## Scope
- `apps/api/src/paypal/client.ts`: `pp.token` cached until `expires_in − 60s`; every call takes an explicit `requestId` (no random default, unlike the spike); `Prefer: return=representation`.
- `orders.ts`: `createAuthOrder({bidId, amountCents, paymentSource})` (wallet with `experience_context.return_url`, card + `attributes.vault.store_in_vault: ON_SUCCESS`, `card.vault_id` + `stored_credential {MERCHANT, UNSCHEDULED, SUBSEQUENT}`), `authorizeOrder(orderId)`, `capture(authId, amountCents, requestId)` with `final_capture: true`, `void(authId, requestId)`, `track(orderId, …)`.
- `payouts.ts`: `payout({payoutId, email, amountCents, note})`, `getPayoutBatch(batchId)`.
- `verifyWebhook(headers, body)`.
- Error classifier → `TRANSIENT` (5xx, 429, timeout), `TERMINAL` (`INSTRUMENT_DECLINED`, `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_VOIDED`, other 4xx).
- Test-only option to add `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}`; never enabled from request input.
- Cents ↔ `"229.00"` conversion in `packages/shared`.

## Out of scope
- Business logic (bids, settlement). Track UI (HF-059).

## Acceptance criteria
- [ ] Sandbox: card hold → capture own amount → COMPLETED; hold → void → 204 (S1 pattern).
- [ ] Sandbox: vaulted MIT hold from `vault_id` returns CREATED (S2 pattern).
- [ ] Same `requestId` on capture twice returns the same capture id (S3).
- [ ] Mock decline is classified TERMINAL; a simulated 503 is TRANSIENT.
- [ ] Client secret never leaves the server; logs redact tokens.

## Test plan
- Unit: amount conversion, error classification, token cache expiry.
- Integration (sandbox): S1/S2/S3 idempotency cases against the client.

## Notes & risks
- Request ids: order create = `bid.id`; capture/void = `settlement.id`; payout `sender_batch_id` = `payout.id`.
- Use a **US** sandbox business account (IN accounts fail holds and payouts; HOLDFAST.md §6).
- Wallet (PayPal account) holds are not yet proven in sandbox; only card holds are (S1/S2).
