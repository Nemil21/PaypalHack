# HF-022: Book and simulate API

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 4
- **Estimate:** 2
- **Depends on:** HF-005, HF-003b, HF-006
- **Spec refs:** api.md §`GET /listings/:id/book`, §`GET /listings/:id/simulate`; features/08-brand-console.md §Layout 2–4; features/10-clearing-engine.md §Rules; features/12-payouts-fees-tracking.md §Money math

## Goal
The brand-only read model behind the console: stats, demand curve and the exact numbers Clear would produce, computed from exactly the input Clear will use.

## Scope
- Both endpoints read through the shared `loadClearInput(tx, listingId)` / eligibility predicate from HF-005 (D8): HELD bids with a real `paypal_authorization_id`, one per shopper (D3). The same function is used by HF-024's slider, the HF-036a rounds runner and HF-027 Clear.
- `GET /api/listings/:id/book` (`forBrand`):
  - `listing`: the richer payload as a zod schema in `packages/shared`: product title and image, slug, `status`, `phase` (`listingPhase()`), `windowOpensAt/ClosesAt`, `roundsEndAt`, `roundEndsAt`, `currentRound`, `targetQuantity`, `clearDeadlineAt`, `priceWatch`, `liquidationQuoteCents`, `feeBps`, `oldestHoldAuthorizedAt` (D6: from `bids.authorized_at`).
  - `stats`: `liveBids`, `heldCents`, `simulatedHeldCents` (SIM bids with real holds, for "incl. $X simulated"), `bestPublicPriceCents`, `releasedByPriceWatch`.
  - `curve`: `[ {priceCents, bidsAtOrAbove, heldAtOrAboveCents} ]` computed server-side.
  - `bids`: **exactly** the `loadClearInput` rows (id, amountCents, `rank` from the server ordering, `placedAtUs` as an epoch-µs string, source, isSimulated, shopperLabel, status, `belowFloor`). Display-only rows (PENDING_APPROVAL, VOIDING) go in a separate `pending` array if needed.
  - `bookVersion` (max `updated_at` over the Clear input) for a cheap staleness check.
- `GET /api/listings/:id/simulate?quantity=` → `clear()` on the Clear input: `cutoffCents`, winners, `grossCents`, `feeCents`, `netCents`, `liquidationCents`, `recoveryMultiple`, `bookVersion`.
- Shared integer fee helper in `packages/shared`: `feeCents = floor((gross × bps + 5000) / 10000)`, used by simulate, the W07 modal and HF-032.
- `shopperLabel`: stable, non-reversible per-listing sequence ("Shopper #1042"); never derived from an email.

## Out of scope
- UI (HF-023…HF-025). Anonymized MCP bands (`likelyBand()` / `publicBookBands`, HF-044a).

## Acceptance criteria
- [ ] Another brand → 404.
- [ ] Simulate output equals the server Clear output for the same book (shared `clear()` and `loadClearInput`).
- [ ] Property test: for random books, `clear(book.bids, q, floor).gross` equals a Clear dry-run's gross.
- [ ] Bids with no hold (`paypal_authorization_id IS NULL`) never appear in `book.bids`, `heldCents` or simulate (D8).
- [ ] Client sort by `rank` matches the server winner set for bulk-seeded bids placed in the same millisecond.
- [ ] 300-bid book responds < 200 ms.

## Test plan
- Unit: curve builder; fee helper rounding against Postgres.
- Integration: seeded 300-bid book on the FakePayPal stub; parity property test.

## Notes & risks
- Resolved (D8): no-hold bids are excluded from every Clear input; the seed aborts above 10% no-hold fallback (HF-045).
- SIM bids with real holds are included but flagged `isSimulated` so KPIs can show "incl. $X simulated" (17).
- Depends on HF-002/003b/006, not on HF-012a; development uses fixture listings.
