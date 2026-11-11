# HF-012: Listings API: create, publish, cancel

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-009, HF-011
- **Spec refs:** features/02-listing-creation.md §Logic 5, §Edge cases, §Acceptance criteria; api.md §`POST /listings`, §`/publish`, §`/cancel`; data-model.md §listings, §State machines (Listing)

## Goal
Brands turn a matched product into an OPEN window with a shareable offer link; brands can cancel and release every hold.

## Scope
- `POST /api/listings` `{channel3Id, quantity, floorCents, liquidationQuoteCents, windowHours}` → DRAFT + slug. Validation: product brand fuzzy-matches verified brand name (else 422 `PRODUCT_MISMATCH`); condition NEW; GTIN or MPN+brand present; `floor < best public price`; quantity ≥ 1; `windowHours ∈ {24, 48}` (> 48 → `VALIDATION_ERROR`); no other OPEN listing for the same product + brand.
- `POST /api/listings/:id/publish` → brand VERIFIED guard; set `window_opens_at/closes_at`, `clear_deadline_at = window_closes_at + 6h`; subscribe Channel3 price webhook (store id); DRAFT→OPEN via `transition()`; audit `LISTING_PUBLISHED`; return `windowClosesAt`.
- `POST /api/listings/:id/cancel` → OPEN→CANCELLED; enqueue VOID for every HELD bid (reuse HF-030 void path or direct `pp.void` with settlement rows); SSE `listing.status`.
- `GET /api/listings` for the brand (tenant-scoped).
- Channel3-down path: manual GTIN, `best_public_price` unknown, price watch off flag.

## Out of scope
- Wizard UI (HF-013). Scheduled start time ("start at a set time") beyond storing `window_opens_at`.

## Acceptance criteria
- [ ] Window > 48 h rejected by the API.
- [ ] Wrong-brand product → `PRODUCT_MISMATCH`.
- [ ] Publishing creates a Channel3 subscription and a working `/o/:slug` link.
- [ ] Cancel voids all live holds (each with an audit row + PayPal id).

## Test plan
- Unit: validation rules.
- Integration: create → publish → cancel against sandbox with 2 held bids.

## Notes & risks
- Spec question: api.md's `POST /listings` example uses `"windowHours": 72`, contradicting the 48 h maximum; implement 48 max.
- Spec question: 02 says after publish "only quantity can increase; floor and window are locked", but api.md has no PATCH /listings endpoint. Not ticketed; confirm whether needed.
- Spec question: listing state table allows CANCELLED only from OPEN; can a brand cancel during ROUNDS?
