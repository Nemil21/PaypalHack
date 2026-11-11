# HF-063: PayPal spike pack S7 (card fields, wallet, replays, ~$50k payout funded by captures)

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 1
- **Estimate:** 2
- **Depends on:** none
- **Spec refs:** review SUMMARY M15, B4, B8, M2, M4, M6, M19; X-cross-cutting §What the sandbox has and hasn't proven; spikes/paypal-spikes.mjs (S1–S4); docs/first-principles/01-paypal-primitives.md

## Goal
Run every PayPal call on the demo path that the spikes have not proven, once, in the sandbox, before the money code depends on it. Record the exact responses and issue codes so HF-004's classifier and the CP1 fallback decisions rest on evidence.

## Scope
Extend `spikes/` (new `spikes/paypal-s7.mjs` plus a tiny static page for the browser flows). Use the **same PayPal sandbox app and credentials** as `spikes/paypal-spikes.mjs` and the same US sandbox business account. Each step writes its request ids, HTTP status, body `status` and any `issue` code to `spikes/s7-results.md`.

1. **Card fields (JS SDK v6) + authorize + vault:** create an AUTHORIZE order with `payment_source.card.attributes.verification.method=SCA_WHEN_REQUIRED` and `vault.store_in_vault=ON_SUCCESS`; submit test card in the browser card fields; server `authorizeOrder` with `authz-<id>`; read `vault.id` from the authorize response.
2. **Wallet approve + authorize:** create a wallet AUTHORIZE order, read the `rel=payer-action` link, approve as the sandbox buyer, return, authorize. Confirm whether wallet orders can vault.
3. **Replays:** order create with the same `PayPal-Request-Id` (+ `invoice_id`), authorize twice with the same id (record `ORDER_ALREADY_AUTHORIZED` or replay), void twice with the same id, void twice with different ids, capture twice with the same and with different ids. Record every issue code (`AUTHORIZATION_ALREADY_CAPTURED`, already-voided, etc.).
4. **Vault:** a second MIT hold from one `vault_id` (`stored_credential` MERCHANT/UNSCHEDULED/SUBSEQUENT) and a CIT vault hold (`payment_initiator: CUSTOMER`).
5. **Mock `AUTHORIZATION_EXPIRED`:** check whether `PayPal-Mock-Response` supports it on capture; record the response.
6. **Volume:** a 300-hold run spread over 4–5 sandbox test cards at concurrency ≤ 20; record failures, rate limits and latency.
7. **Large payout funded by captured winners' money:** capture a batch of holds from step 6 totalling **≥ ~$50k** (e.g. 220 × $229) into the sandbox business account, confirm the balance, then send a **~$50k** `POST /v1/payments/payouts` to the brand sandbox email, then `GET` the batch and the item until terminal. Record batch/item statuses (`SUCCESS`, `UNCLAIMED`, `PENDING`) and timings. Void the remaining holds afterwards.
8. Write a one-page result table: pass/fail per step and the fallback chosen.

## Out of scope
- Production client code (HF-004 ports the patterns). Render Workflows smoke (HF-048a/HF-030b). Channel3 (HF-009).

## Acceptance criteria
- [ ] `spikes/s7-results.md` lists steps 1–7 with request ids, statuses and issue codes.
- [ ] Card-fields flow result recorded: pass → HF-014b builds card fields after the test-card button; fail → the labelled "Use sandbox test card" button (HF-019 Part 1) is the demo path at CP1 and card fields continue in HF-014b Part 2.
- [ ] Wallet result recorded, including whether it vaults; decides HF-014b ordering (card first or wallet first).
- [ ] Void-twice and capture-twice responses recorded and handed to HF-004's RECONCILE mapping.
- [ ] A ≈ $50k payout succeeded from a balance funded only by captures made in this spike, with the batch and item `GET` results recorded.
- [ ] All holds created by the spike are voided or captured; none left CREATED (checked by GET).

## Test plan
- Run once end to end in the sandbox; re-run steps that fail once before declaring a fallback.

## Notes & risks
- Results feed **CP1 (06:30 PST / 20:00 IST Nov 11)**: card fields fail → test-card button first; wallet fails → wallet stays in HF-014b but is built after the card path.
- Payout funding comes from the captured winners' money in the sandbox business balance, exactly like the demo (no separate pre-funding assumed). If the balance is short, capture more holds rather than switching accounts.
- Use a **US** sandbox business account (IN accounts fail holds and payouts; HOLDFAST.md §6).
- Never log the client secret or card numbers; the raw test card is only used server-side in spike/seed code.
