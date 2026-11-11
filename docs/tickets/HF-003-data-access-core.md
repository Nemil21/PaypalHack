# HF-003: Data-access core: conditional transitions, tenancy helper, audit, idempotency

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-002
- **Spec refs:** data-model.md §Locking and idempotency rules 1, 4, 6; features/15-audit-ops.md §Logic 1–2; features/16-auth-security-tenancy.md §Multi-tenancy rules, §Concurrency

## Goal
Shared primitives that make every state change race-safe, tenant-scoped and audited in the same transaction.

## Scope
- `db.tx(fn)` transaction helper (pg pool).
- `transition(table, id, from: string|string[], to, extra?)` → `UPDATE … SET status=$to WHERE id=$id AND status = ANY($from) RETURNING *`; returns null on zero rows (caller stops).
- `forBrand(brandId)` repository wrapper: every brand-side query is filtered by the session's `brand_id`, never the request body.
- `audit(tx, {actorType, actorId, brandId, entity, entityId, action, paypalId?, data?})` writing `audit_events` inside the caller's transaction. Actor types per data-model.
- Client idempotency helper: look up by `Idempotency-Key`; replay returns the original result.
- Webhook dedupe helper: `insert into webhook_events … on conflict do nothing` → boolean "first time".

## Out of scope
- Ops UI over the audit log (HF-058, P1).

## Acceptance criteria
- [ ] Two concurrent `transition(bid, HELD→VOIDING)` calls: exactly one succeeds.
- [ ] `forBrand(A)` cannot read a listing of brand B (returns not found).
- [ ] An audit row is rolled back if its transaction rolls back.
- [ ] Replaying a webhook event id returns "duplicate".

## Test plan
- Integration (real Postgres): parallel transition race; cross-tenant read; tx rollback.

## Notes & risks
- Every later ticket must use `transition()`; review for raw `UPDATE … SET status` without the `WHERE status=` guard.
- Audit is append-only (no UPDATE/DELETE grants), so corrections are new rows.
