# PayPal webhook fixtures (HF-033)

Replay bodies for `POST /api/webhooks/paypal`. Webhooks only reach a public URL, so local dev and CI
replay these through the stub verifier (`FakePayPal`, `paypal-transmission-sig: fake-valid-signature`).

| File | Resource | Source |
|---|---|---|
| `webhooks/payment.capture.completed.json` | capture `90Y08719AU802670V` on authorization `32L18808C7119720N` | **recorded**: `GET /v2/payments/captures/{id}` in the sandbox, Nov 11 2026 17:15 UTC (a $219 test-card hold, captured) |
| `webhooks/payment.authorization.voided.json` | authorization `6P562205412054447` | **recorded**: `GET /v2/payments/authorizations/{id}` after a void, same run |
| `webhooks/payment.capture.denied.json` | the recorded capture with `status: DECLINED` | derived (the sandbox can't be made to send a denial on demand) |
| `webhooks/payment.payoutsbatch.success.json`, `…denied.json` | payout batch header, `sender_batch_id` = `<payout id>:<attempt>` | schema-derived (PayPal's webhook event docs); tests substitute the attempt |

The `resource` objects are what PayPal puts in the event; the envelopes (`WH-…` ids, `links`) are
synthesized in PayPal's shape, because a sandbox delivery to a local machine is impossible and simulator
events can't be verified. The payee email is redacted. Replace with a live delivery after the manual
Render check (HF-033 test plan, HF-048a).

Mapping the handlers rely on: capture → `supplementary_data.related_ids.authorization_id`, authorization →
its own `id`, both with `custom_id` = `invoice_id` = bid id as the fallback.
