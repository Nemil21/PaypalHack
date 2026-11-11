# HF-003a: Money primitives: `landHold`, `transition`, `lockBids`, `voidBid` / `voidKey`, lease, `emit`

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** HF-002, HF-001
- **Spec refs:** data-model.md §Locking and idempotency rules 1–5; features/16-auth-security-tenancy.md §Concurrency; review SUMMARY D1, D2, D4, D5, D7, D11, B1, B2, B9; X-cross-cutting INV-1…INV-4, INV-8

## Goal
The small set of race-safe primitives every money path uses, merged first (target **CP1, 06:30 PST / 20:00 IST Nov 11**) so bid, Clear, settlement and sweeper work can start against one implementation instead of each building its own.

## Scope
All in `packages/core`:
- `db.tx(fn)` transaction helper (pg pool).
- `transition(table, id, from: Status|Status[], to, extra?)` → `UPDATE … SET status=$to WHERE id=$id AND status = ANY($from) RETURNING *`; returns null on zero rows (caller stops). Table names are a TS union and statuses the per-table enums from HF-002 (no SQL from free strings).
- `lockListing(tx, listingId, mode)`: `FOR SHARE` for bid landing, conditional `UPDATE … WHERE status IN ('OPEN','ROUNDS')` for Clear / Cancel / Expire (D2).
- `lockBids(tx, listingId)`: `SELECT … FROM bids WHERE listing_id=$1 AND status='HELD' ORDER BY id FOR UPDATE`.
- Lock order, documented and enforced by helper order: **listing → mandate → bids by id**.
- `landHold({bidId, authorizationId, authorizedAt, authorizedAmountCents, replacesBidId?})` (D1), the only way a bid becomes HELD:
  1. Called after the PayPal authorization succeeded (INV-1: never inside a transaction during the PayPal call; the bid row is PENDING_APPROVAL meanwhile).
  2. One short transaction: lock listing `FOR SHARE` and re-check `isBiddable` (new bid) or `isRaisable` (raise) from `packages/shared` (D7); if `mandate_id` is set, lock the mandate `FOR UPDATE` and re-check ACTIVE and the cap (D12, via a hook HF-017a implements); for a raise, flip old HELD→VOIDING (`void_reason=REPLACED`); flip new PENDING_APPROVAL→HELD storing `paypal_authorization_id`, `authorized_at`, `authorized_amount_cents`; assert `authorized_amount_cents = amount_cents` (INV-5).
  3. If any check fails or touches 0 rows: ROLLBACK, void the **new** authorization (`void-<bidId>`), mark the new bid VOIDED with a reason (`WINDOW_CLOSED`, `MANDATE_PAUSED`, …).
  4. Emits `bid.held` (and `bid.raised` for a swap) via `emit` inside the transaction.
- `voidKey(bidId)` = `void-<bidId>` (D4, D5) and `voidBid(bidId, reason, actor)`: flips HELD→VOIDING in a transaction, calls `pp.void(authId, voidKey)` outside it, then VOIDING→VOIDED; records `void_reason`, `void_request_id`, `void_attempts`; "already voided" (RECONCILE) = success; retries ×3 with backoff; leaves VOIDING for the sweeper (HF-034) on persistent failure. No VOID settlement rows outside Clear (D4).
- Lease helper (D11): `claim(table, id, leaseSeconds=60)` → `UPDATE … SET status='RUNNING', lease_until=now()+60s WHERE id=$1 AND (status IN ('QUEUED','RETRY') OR (status='RUNNING' AND lease_until < now()))`; `renew` / `release`.
- `emit(tx, listingId, event: ListingEvent)`: `pg_notify('listing_events', {listingId, type, ids})` inside the business transaction, so it fires on COMMIT and is dropped on ROLLBACK. HF-008 owns the LISTEN side and SSE.

## Out of scope
- Audit, tenancy helpers, generic idempotency, webhook dedupe (HF-003b). PayPal HTTP (HF-004; until it lands, use its interface with the `FakePayPal` contract). Mandate cap rules themselves (HF-017a).

## Acceptance criteria
- [ ] Two concurrent `transition(bid, HELD→VOIDING)` calls: exactly one succeeds.
- [ ] `landHold` on a listing that left OPEN (Clear/Cancel/Expire committed) voids the new authorization with `void-<bidId>` and marks the bid VOIDED `WINDOW_CLOSED`; nothing is HELD (B2).
- [ ] Raise swap: after `landHold` with `replacesBidId`, exactly one HELD bid exists for the shopper and the old one is VOIDING `REPLACED`; a second swap of the same old bid fails `UNIQUE(replaces_bid_id)` (B1).
- [ ] `landHold` while the mandate is PAUSED or over cap voids the new authorization (B9).
- [ ] Race test on the stub: `landHold` vs Clear's listing lock, 50 iterations, never leaves a HELD bid on a CLEARING listing.
- [ ] `voidBid` twice on the same bid sends one key `void-<bidId>` and ends VOIDED once.
- [ ] An expired lease is claimable by a second worker; a live lease is not.
- [ ] An `emit` inside a rolled-back transaction delivers nothing.

## Test plan
- Integration (real Postgres + `FakePayPal` stub): races above with parallel connections.

## Notes & risks
- Every later ticket uses `transition()` / `landHold()` / `voidBid()`; review for raw `UPDATE … SET status` without the `WHERE status=` guard or any other path to HELD.
- Resolved (D7, Q#5/Q#6): new bids need `status='OPEN' AND now() < window_closes_at`; ROUNDS accepts raises only, until `rounds_end_at`.
- Resolved (D4, Q#14): one void key per bid on every path; no VOID settlement rows outside Clear.
