# HF-005: Pure pay-your-bid `clear()`, eligibility predicate and `loadClearInput`

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** HF-001, HF-002
- **Spec refs:** features/10-clearing-engine.md §Rules, §Acceptance criteria, §Test plan; data-model.md §Locking rule 7; review SUMMARY D3, D8, B1, B7

## Goal
The single deterministic auction function and the single "which bids count" input, used by the server Clear, `/book`, `/simulate`, the console slider, the recommender and the live-round runner, so their numbers never drift.

## Scope
- `packages/shared/auction.ts`: `clear(bids, q, floor, {eligible?})`:
  - integer-only inputs; reject `q <= 0` or non-integer `q`/amounts;
  - **per-shopper dedupe first**: keep each `shopperId`'s highest bid, return the rest as `superseded` (HF-027 marks them LOST and voids them) (D3/B1);
  - eligible = predicate passes AND amount ≥ floor; rank `amount DESC, seq ASC` (or µs `placedAt` string), then ordinal `id` compare (`a.id < b.id ? -1 : …`, never `localeCompare`);
  - winners = first `min(q, eligible)`; cutoff = lowest winning bid; gross = integer sum of winners' own bids; reserve = remaining ranked eligible; `belowFloor`; `rank` per bid.
- `packages/shared/eligibility.ts`: default predicate (D8): status HELD **and** `paypal_authorization_id IS NOT NULL`. Bids with no hold never reach Clear.
- `packages/core/clearInput.ts#loadClearInput(tx|db, listingId)`: the one query returning the eligible book in the `ClearInput` shape from HF-001; used by HF-022, HF-024 (via `/book`), HF-027, HF-036a.
- Shared fixture file `packages/shared/fixtures/books.json` run by both the server and web test suites.

## Out of scope
- Clear transaction (HF-027), fee math (`feeCents` in HF-001, payout in HF-032).

## Acceptance criteria
- [ ] Property test (fast-check, 1k random books): winners ≤ Q; every winner ≥ cutoff ≥ floor; every eligible loser ≤ cutoff; each winner's charge = their bid; **≤ 1 win per shopper**; **gross = sum of winners' amounts**.
- [ ] Ties at cutoff resolved by `seq`, then ordinal `id`.
- [ ] Fewer eligible than Q → all eligible win.
- [ ] A bid with a null authorization id is never a winner or reserve.
- [ ] Same module importable from web (no Node-only deps); shared fixtures pass in both suites.

## Test plan
- Unit + property tests (Vitest + fast-check). Integration: `loadClearInput` against seeded Postgres.

## Notes & risks
- Server and console import this same file; never re-implement in the UI (10 acceptance "identical results").
- Resolved (D3, Q#25): one live bid per shopper; `clear()` also dedupes defensively.
- Resolved (D8): no-hold bids are excluded everywhere; the seed aborts above 10% no-hold (HF-045).
