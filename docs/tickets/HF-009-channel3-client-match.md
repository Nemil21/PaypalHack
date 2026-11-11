# HF-009: Channel3 client, live fixtures, product search proxy and two-stage exact-match gate

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 4
- **Estimate:** 3
- **Depends on:** HF-002, HF-006
- **Spec refs:** features/02-listing-creation.md §Logic 1, §Edge cases; features/06-price-watcher.md §Logic 3; api.md §`GET /products/search`, §Channel3 webhook; data-model.md §products, §brands; review SUMMARY D15, D17, M21

## Goal
One Channel3 integration used by listing creation, the offer page anchor, the buyer agent and the price watcher, with an exact-product gate built on Channel3's real data model.

## Scope
- **First 30 minutes:** one live `search` and one `GET /v1/products/{id}` call for the demo products; save as fixtures (`fixtures/channel3/`); share the real shapes with the api.md webhook example (spec owners) and HF-042a.
- `packages/core/channel3/client.ts`: search, product detail (free endpoint), offers, subscribe to price changes per **product + variant `selection`** with up to 25 domains.
- Prices are decimals: convert once with `Math.round(price * 100)`; table-test 279.99 and 0.1+0.2-style values.
- `GET /api/products/search?q=` proxy (requires a brand or shopper session; shared HF-006 limiter) returning the api.md shape (channel3Id, variant, title, gtin/mpn from `structured_attributes` when present, imageUrl, bestPublicPriceCents, offerCount, condition).
- Upsert `products` by `channel3_id` + `channel3_variant`; cache identity forever; refresh price/offers via the detail endpoint if older than 10 min (used by `publicOffer`). Spend search credits only on wizard and agent searches.
- `channel3/match.ts`, two stages (M21):
  - **At listing creation:** GTIN/MPN from `structured_attributes` (or entered by hand) + brand name.
  - **Per offer / webhook:** Channel3 product id + variant equal to the listing's; `condition == "new"`; `domain` in `brands.authorized_domains` (D17); `currency == "USD"` → match or `{ignored, reason}`.
- `CHANNEL3_MODE=live|fixtures` switch; recorded fixtures for CI and clean-clone setup; `CHANNEL3_ERROR` 502 on outage.
- Export `AFFILIATE_DISCLOSURE` ("We may earn a commission when you buy through links on this page") and the list of screens that must render it (offer page `publicOffer`, M06, W21, W15).

## Out of scope
- Webhook handling and voids (HF-042a replay, HF-042b live). Listing UI (HF-013). Allowlist editing UI (HF-056).

## Acceptance criteria
- [ ] Live fixtures recorded for the Aurel Audio demo product's real-world comparison searches and 2 others (D15: real Channel3 calls stay on screen in search and agent price comparisons; the seeded listing itself is the fictional Aurel A7).
- [ ] Match gate table tests, ≥ 10 cases: wrong product id, wrong variant, used, refurb, domain not allowlisted, non-USD, GTIN mismatch at creation, MPN + brand fallback, etc.
- [ ] Prices convert to integer cents exactly.
- [ ] Outage returns `CHANNEL3_ERROR` and callers can fall back to manual GTIN entry.
- [ ] Unauthenticated search → 401.

## Test plan
- Unit: match gate table tests; cents conversion.
- Integration: 3 live calls with promo credits; CI uses fixtures.

## Notes & risks
- Resolved (D17, Q#16/Q#18): allowlist = `brands.authorized_domains text[]` (max 25, reused as the subscription domain list; seeded by HF-045); subscription stored on `products` (per product + variant), reused by HF-012a publish.
- Channel3's offers carry no GTIN or merchant name; the api.md payload was invented and is being corrected from these fixtures.
- Channel3 credits are limited; the detail endpoint is free, search is not.
