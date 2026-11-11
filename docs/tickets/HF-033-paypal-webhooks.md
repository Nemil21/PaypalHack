# HF-033: PayPal webhooks: verify, dedupe, reconcile

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-029, HF-032, HF-015
- **Spec refs:** api.md §`POST /webhooks/paypal`; features/11-settlement-workflows.md §Idempotency; data-model.md §Locking rule 6; features/16-auth-security-tenancy.md §Acceptance (bad signature → 401)

## Goal
PayPal's own events back up every money state, so a task that died after PayPal succeeded still ends correct.

## Scope
- `POST /api/webhooks/paypal`: `pp.verifyWebhook` (bad → 401); insert `webhook_events` (dedupe); 200 fast; process async.
- Handlers (all conditional updates, idempotent):
  - `PAYMENT.AUTHORIZATION.CREATED` → confirm bid HELD (backup to return URL);
  - `PAYMENT.AUTHORIZATION.VOIDED` → confirm VOIDED;
  - `PAYMENT.CAPTURE.COMPLETED` → settlement SUCCEEDED, bid CAPTURED;
  - `PAYMENT.CAPTURE.DENIED`/`DECLINED` → settlement FAILED → promote (guarded);
  - `PAYMENT.PAYOUTSBATCH.SUCCESS`/`DENIED` → payout status → PAID_OUT / PAYOUT_FAILED.
- Register the webhook on the sandbox app for the Render URL.

## Out of scope
- `CUSTOMER.DISPUTE.CREATED` (P2, README only).

## Acceptance criteria
- [ ] Bad signature → 401.
- [ ] Duplicate event id is processed once.
- [ ] Reconciliation: drop the DB write after a capture, replay the webhook → settlement SUCCEEDED, bid CAPTURED.

## Test plan
- Integration: signed fixture events; reconciliation test from 11.

## Notes & risks
- Webhooks only reach a public URL; local dev needs a tunnel or replay fixtures.
