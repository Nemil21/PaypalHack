# HF-012a: Listings API: create and publish

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** HF-003a, HF-006, HF-009
- **Spec refs:** features/02-listing-creation.md §Logic 5, §Edge cases, §Acceptance criteria; api.md §`POST /listings`, §`/publish`; data-model.md §listings, §products, §State machines (Listing)

## Goal
Brands turn a matched product into an OPEN window with a shareable `/o/:slug` link. Downstream tickets (HF-014a, HF-019, HF-022, HF-036a, HF-045) build against fixture listings and don't wait for this.

## Scope
- `POST /api/listings` `{channel3Id, variant?, quantity, floorCents, liquidationQuoteCents, windowHours}` (Idempotency-Key) → DRAFT + slug. Validation:
  - product brand matches the verified brand name by the defined rule: case-insensitive token containment after stripping "(demo)" and corporate suffixes (table tests use the seed names, e.g. "Aurel Audio (demo)" vs "Aurel Audio"), else 422 `PRODUCT_MISMATCH`;
  - HF-009's exact-match gate passes (product id, variant, condition NEW, allowlisted domain, USD);
  - `floor < best public price` (skipped when the public price is unknown);
  - quantity ≥ 1; `windowHours ∈ {24, 48}` only, anything else → `VALIDATION_ERROR`.
- `POST /api/listings/:id/publish` → `assertBrandVerified` (HF-011a); in one transaction set from DB `now()`: `window_opens_at`, `window_closes_at`, `clear_deadline_at = least(window_closes_at + 6h, window_opens_at + 60h)` and every other D6 deadline (CHECKs from HF-002); DRAFT→OPEN via `transition()`; audit `LISTING_PUBLISHED`. Partial unique index `listings(brand_id, product_id) WHERE status IN ('OPEN','ROUNDS','CLEARING')` → 409 `DUPLICATE` with a link to the existing listing.
- After commit (outside the transaction): ensure the Channel3 price subscription on the **product** (`products.channel3_subscription_id`, reuse if present, D17). If Channel3 is down, the listing stays OPEN with `price_watch=false` (badge) and the subscribe is retried later.
- `GET /api/listings` for the brand (tenant-scoped via `forBrand`).
- Channel3-down create path: manual GTIN, `best_public_price` unknown, price watch off.
- "Start now" only; `window_opens_at` is always publish time.

## Out of scope
- Cancel and quantity increase (HF-012b). Wizard UI (HF-013).

## Acceptance criteria
- [ ] Window not in {24, 48} rejected by the API.
- [ ] Wrong-brand product → `PRODUCT_MISMATCH`.
- [ ] Unverified brand can create a draft but publish → `BRAND_NOT_VERIFIED`.
- [ ] Publishing sets all D6 deadlines and gives a working `/o/:slug` link; the product has one Channel3 subscription, reused by a second listing of the same product.
- [ ] Two drafts of the same product: the second publish → 409 `DUPLICATE`.
- [ ] Channel3 down at publish → listing OPEN with price watch off.

## Test plan
- Unit: validation rules, brand-name match table, deadline maths.
- Integration: create → publish (Channel3 stubbed via `CHANNEL3_MODE`).

## Notes & risks
- Resolved (api.md fix): `windowHours` is 24 or 48 only; the old `72` example is removed from api.md.
- Resolved (D17, Q#18): the Channel3 subscription lives on `products`, per product and variant.
- Resolved (D6/D7, Q#5): `isBiddable` from `packages/shared` = `status='OPEN' AND now() < window_closes_at`.
