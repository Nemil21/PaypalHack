# HF-033: PayPal webhooks: verify, dedupe, reconcile

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** HF-029, HF-032, HF-014b, HF-031, HF-034 (sequencing: after the money spine)
- **Spec refs:** api.md §`POST /webhooks/paypal`; features/11-settlement-workflows.md §Idempotency; data-model.md §Locking rule 6; features/16-auth-security-tenancy.md §Acceptance (bad signature → 401)

## Goal
PayPal's own events back up every money state, so a task that died after PayPal succeeded still ends correct. Kept P0 by the user (the review proposed P1, M18); built after the money spine.

## Scope
- Part 1 (fallback, ships in HF-034, listed here for traceability): the HF-034 cron GETs PENDING_APPROVAL wallet/card-fields orders and payout batches, so nothing depends on webhooks for correctness.
- Part 2 (full feature):
  - `POST /api/webhooks/paypal`: injected verifier (real `verify-webhook-signature` in deployed envs, stub in tests); bad signature → 401; insert `webhook_events`; 200 fast; process async; dedupe on `processed_at IS NOT NULL` (M14), and reprocess rows where `processed_at IS NULL`.
  - Mapping: by `supplementary_data.related_ids.authorization_id` (or `custom_id` = bid id) → bid → settlement.
  - Handlers (conditional updates only, idempotent, never start a second promotion):
    - `PAYMENT.CAPTURE.COMPLETED` → settlement `QUEUED|RUNNING|RETRY|FAILED → SUCCEEDED`, bid WON→CAPTURED;
    - `PAYMENT.CAPTURE.DENIED`/`DECLINED` → before SETTLED: same path as a terminal failure (conditional WON→CAPTURE_FAILED guards the race with HF-029); after SETTLED or on a SUCCEEDED row: audit + flag only;
    - `PAYMENT.AUTHORIZATION.VOIDED` → confirm VOIDED; for a HELD bid we didn't void → bid VOIDED (`void_reason=EXPIRED`), removed from the book;
    - `PAYMENT.PAYOUTSBATCH.SUCCESS`/`DENIED` → resolve the payout (incl. `PENDING_UNKNOWN`) by `sender_batch_id`.
  - `PAYMENT.AUTHORIZATION.CREATED` is **not** handled (wrong event for a missed wallet return; HF-034 GETs the order instead).
  - Register the webhook on the sandbox app for the Render URL (HF-048a); `PAYPAL_WEBHOOK_ID` env.

## Out of scope
- `CUSTOMER.DISPUTE.CREATED` (P2, README only).

## Acceptance criteria
- [ ] Bad signature → 401 with the real verifier.
- [ ] Race test on the stub (from old HF-047): a duplicate event id is processed once; out-of-order events (VOIDED before CAPTURE.COMPLETED, DENIED after COMPLETED) leave states correct.
- [ ] Reconciliation: drop the DB write after a capture, deliver the webhook (fixture body using real sandbox ids) → settlement SUCCEEDED, bid CAPTURED, no promotion.
- [ ] A crash during async processing leaves the event reprocessable.
- [ ] One manual end-to-end check on Render with a real capture.

## Test plan
- Integration: fixture bodies with real sandbox auth/capture ids through the stub verifier; reconciliation test from 11.
- Manual: Render end to end.

## Notes & risks
- Webhooks only reach a public URL; local dev uses replay fixtures.
- Simulator events can't be verified via the API; each app allows at most 10 webhooks.
- Resolved (user override of M18): stays P0 after the spine; fallback (cron GET) ships first in HF-034. HF-014b dependency kept because the order-mapping handlers cover card-fields/wallet orders.
