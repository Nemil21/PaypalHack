# HF-022: Book and simulate API

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-005, HF-003
- **Spec refs:** api.md §`GET /listings/:id/book`, §`GET /listings/:id/simulate`; features/08-brand-console.md §Layout 2–4; features/12-payouts-fees-tracking.md §Money math

## Goal
The brand-only read model behind the console: stats, demand curve and the exact numbers Clear would produce.

## Scope
- `GET /api/listings/:id/book` (forBrand): listing, stats (liveBids, heldCents, bestPublicPriceCents, releasedByPriceWatch), curve `[ {priceCents, bidsAtOrAbove, heldAtOrAboveCents} ]` computed server-side, bids (id, amountCents, placedAt, source, isSimulated, shopperLabel, status).
- `GET /api/listings/:id/simulate?quantity=` → `clear()` on HELD bids: cutoffCents, winners, grossCents, feeCents (`round(gross × fee_bps / 10000)`), netCents, liquidationCents.
- Fee helper shared with payouts (HF-032).

## Out of scope
- UI (HF-023…HF-025). Anonymized MCP bands (HF-044).

## Acceptance criteria
- [ ] Another brand → 404.
- [ ] Simulate output equals the server Clear output for the same book (shared `clear()`).
- [ ] 300-bid book responds < 200 ms.

## Test plan
- Unit: curve builder.
- Integration: seeded 300-bid book.

## Notes & risks
- SIM bids are included but flagged `isSimulated` so KPIs can show "incl. $X simulated" (17).
