# HF-018: Raise bid: atomic `landHold` swap

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 3.5
- **Depends on:** HF-003a, HF-014a, HF-017a
- **Spec refs:** api.md §`POST /bids/:id/raise`; features/05-mandates-rolling.md §Logic 4; features/19-live-rounds.md §Logic 4–5; features/10-clearing-engine.md §Rules 3; data-model.md §Locking rule 3

## Goal
Shoppers and agents raise a held bid without ever being unheld, and without any moment where two of their bids are live.

## Scope
- `core/bids.ts#raiseBid(bidId, amountCents, actor, idempotencyKey)`:
  1. Old bid HELD; listing raisable per D7 (`isRaisable` from `packages/shared`): `(status='OPEN' AND now() < window_closes_at) OR (status='ROUNDS' AND now() < rounds_end_at)`, else 409 `WINDOW_CLOSED`.
  2. Minimum raise: max($1, 1% of current bid) else `VALIDATION_ERROR`.
  3. If `release_if_cheaper` is on and the new amount > `products.best_public_price_cents` → 422 `PRICE_DROPPED` before any hold.
  4. One transaction: if `mandate_id` is set, `mandates.authorize` with the old bid excluded (D12); insert the new bid PENDING_APPROVAL with `replaces_bid_id = old.id` (`UNIQUE(replaces_bid_id)`: a concurrent second raise fails here with 409 `STATE_CONFLICT`, before PayPal). The new bid inherits `release_if_cheaper`, `mandate_id`, `intent_id`, `source`, `payment_method` and the nudge-mute flag; `placed_at` = now, `raise_count + 1`.
  5. Hold: VAULT (CIT if the shopper is present, MIT for rounds auto-raise) if the shopper has a vault; wallet-only shoppers get `{status: PENDING_APPROVAL, approveUrl}` and the swap completes in HF-014b's authorize path.
  6. `landHold` swap (D1): under the listing lock, old HELD→VOIDING (`REPLACED`) and new PENDING_APPROVAL→HELD in one transaction. Any 0-row step (Clear, a watcher void, a cancel, a pause or a parallel raise won) → roll back, void the **new** authorization, 409; the old bid stands if still HELD.
  7. After commit, `voidBid(old)` with `void-<oldBidId>`; failures stay VOIDING for the HF-034 sweeper.
  8. Declined new hold → 422 `HOLD_FAILED`, old bid untouched; copy "Couldn't raise. Your $229 bid still stands."
- `POST /api/bids/:id/raise` (Idempotency-Key). Audit `BID_RAISED`; SSE / internal event `bid.raised` (consumed by HF-036b soft close and HF-025 flash).
- Agent-initiated raises capped (M11): at most once per round and 3 times per listing; agents never raise above the public price when `release_if_cheaper` is on. Manual raises are uncapped.
- `warnSeveralHolds` from the 2nd raise: "Each raise places a new hold; old holds can show as pending at your bank for a few days."

## Out of scope
- Raise UI (HF-019 "already bid" state, HF-038a/b). Auto-raise runner (HF-038b).

## Acceptance criteria
- [ ] Raise in sandbox: new hold HELD, old hold VOIDED with `REPLACED`.
- [ ] Declined new hold leaves the old bid HELD.
- [ ] Mandate cap = old max: a raise within max succeeds (replaced bid excluded).
- [ ] Raised bid ranks by the raise time.
- [ ] Race (stub): raise vs Clear → never two HELD bids for one shopper; Clear never ranks both; no double capture.
- [ ] Race (stub): two concurrent raises of one bid → exactly one succeeds; the loser gets 409 and holds nothing.
- [ ] Raise during ROUNDS after `rounds_end_at` → `WINDOW_CLOSED`.

## Test plan
- Unit: minimum-raise rule; cap maths; field inheritance.
- Integration (stub): raise vs Clear; double raise; swap failure voids the new hold.
- Integration (sandbox): raise success; raise with mock decline.

## Notes & risks
- Resolved (D3, Q#17): the new bid carries `replaces_bid_id` (UNIQUE); `replaced_by_bid_id` is dropped.
- Resolved (D7, Q#6): ROUNDS accepts raises only, until `rounds_end_at`.
- Resolved (D1, B1): atomic swap; the old bid leaves the book in the same transaction the new one enters it.
