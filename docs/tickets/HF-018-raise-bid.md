# HF-018: Raise bid (new hold first, then release)

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-017, HF-016
- **Spec refs:** api.md §`POST /bids/:id/raise`; features/05-mandates-rolling.md §Logic 4; features/19-live-rounds.md §Logic 4–5; features/10-clearing-engine.md §Rules 3; data-model.md §Locking rule 3

## Goal
Shoppers and agents can raise a held bid without ever being unheld, and without a cap on raises.

## Scope
- `core/bids.ts#raiseBid(bidId, amountCents, actor, idempotencyKey)`:
  1. Old bid must be HELD; listing OPEN or ROUNDS.
  2. Minimum raise: max($1, 1% of current bid) else `VALIDATION_ERROR`.
  3. `mandates.authorize` with the old hold excluded.
  4. Place the new hold (new bid row, same shopper/listing/intent, `placed_at` = now, raise_count + 1, link old↔new).
  5. If declined → 422 `HOLD_FAILED`, old bid untouched; copy "Couldn't raise. Your $229 bid still stands."
  6. Old bid HELD→VOIDING → `pp.void` → VOIDED `void_reason=REPLACED`; retry on failure; nightly sweeper is backstop.
- `POST /api/bids/:id/raise` (Idempotency-Key). Audit `BID_RAISED`; SSE `bid.raised`.
- Return copy hint and `warnSeveralHolds` once `raise_count ≥ 5`.

## Out of scope
- Raise UI (offer page "already bid" state in HF-019; M07 sheet in HF-038).

## Acceptance criteria
- [ ] Raise in sandbox: new hold HELD, old hold VOIDED with `REPLACED`.
- [ ] Declined new hold leaves the old bid HELD.
- [ ] Mandate cap = old max: raise to a new amount within max succeeds (replaced hold excluded).
- [ ] Raised bid ranks by the raise time.

## Test plan
- Unit: minimum-raise rule; cap math.
- Integration (sandbox): raise success; raise with mock decline.

## Notes & risks
- A raise during CLEARING must fail: the conditional HELD→VOIDING update on the old bid guards the race; check listing status inside the same transaction.
- Spec question: during ROUNDS, `placeBid`'s "listing is OPEN" check would block the new hold of a raise; raises must accept ROUNDS.
