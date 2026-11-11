# HF-003b: Audit pairs, tenancy helpers, generic idempotency, webhook dedupe

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 3
- **Estimate:** 2.5
- **Depends on:** HF-003a
- **Spec refs:** data-model.md §Locking and idempotency rules 4, 6; features/15-audit-ops.md §Logic 1–2; features/16-auth-security-tenancy.md §Multi-tenancy rules; review SUMMARY M3, M14

## Goal
Tenant scoping, a complete audit trail around PayPal calls, and one idempotency mechanism for every mutating route.

## Scope
All in `packages/core`:
- `forBrand(brandId)` repository wrapper: every brand-side query is filtered by the session's `brand_id`, never the request body. `forShopper(shopperId)` counterpart for bids, mandates, agent conversations (HF-016/020/039 "another shopper's bid → 404").
- `audit(tx, {actorType, actorId, brandId, entity, entityId, action, paypalId?, requestId?, data?})` writing `audit_events` inside the caller's transaction. PayPal calls run outside transactions (INV-1), so write `*_REQUESTED` (with the request id) before the call and `*_SUCCEEDED` / `*_FAILED` (with the PayPal id) after. Reconcile (HF-034) fills gaps.
- Generic idempotency (M3) on the `idempotency_keys` table:
  - scope = principal (shopper, brand user, MCP token, agent action) + key; another principal's key never replays;
  - insert first `IN_PROGRESS` (`on conflict do nothing`); a replay while IN_PROGRESS → `409 IN_PROGRESS`, never a second PayPal call;
  - store `request_hash`; same key with a different body → `422 IDEMPOTENCY_MISMATCH`;
  - store DONE responses; **don't store retryable failures** (`HOLD_FAILED`, `PAYPAL_ERROR`): the row is deleted so a retry with a new key/method can succeed; the client mints a new key after a terminal failure.
- `idempotent()` Fastify route helper / middleware (HF-006 wires it into mutating routes; exempt `/api/webhooks/*`, `/mcp` handles keys per tool call, OAuth callback).
- Webhook dedupe (M14): `insert into webhook_events … on conflict do nothing`; process when the row is new **or** `processed_at IS NULL`; set `processed_at` after successful processing. Helper `pendingWebhookEvents(olderThan=2min)` for the HF-034 cron.

## Out of scope
- Ops UI over the audit log (HF-058, P1). Money primitives (HF-003a).

## Acceptance criteria
- [ ] `forBrand(A)` cannot read a listing of brand B (returns not found); `forShopper(A)` cannot read shopper B's bid.
- [ ] An audit row is rolled back if its transaction rolls back; `*_REQUESTED` exists even when the process dies after the PayPal call.
- [ ] Shopper B replaying shopper A's key gets a fresh result, never A's bid.
- [ ] Same key, different body → 422 `IDEMPOTENCY_MISMATCH`; same key while in progress → 409 `IN_PROGRESS`.
- [ ] After a `HOLD_FAILED`, a retry with a new key succeeds; a replay of a DONE key returns the stored response with no PayPal call.
- [ ] A webhook row with `processed_at IS NULL` is reprocessed on redelivery; one with `processed_at` set returns "duplicate".

## Test plan
- Integration (real Postgres): cross-tenant reads; tx rollback; idempotency matrix; webhook crash/redelivery.

## Notes & risks
- Audit is append-only (HF-002 trigger), so corrections are new rows.
- Audit completeness (every PayPal call has a REQUESTED and a SUCCEEDED/FAILED row) is checked in the HF-046 rehearsal.
