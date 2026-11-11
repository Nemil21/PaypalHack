# HF-009: Channel3 client, product search proxy and exact-match gate

- **Track / owner:** D integrations & demo
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-002, HF-006
- **Spec refs:** features/02-listing-creation.md §Logic 1, §Edge cases; features/06-price-watcher.md §Logic 3; api.md §`GET /products/search`; data-model.md §products

## Goal
One Channel3 integration used by listing creation, the offer page anchor, the buyer agent and the price watcher, with an exact-product gate that look-alikes cannot fool.

## Scope
- `apps/api/src/channel3/client.ts`: search, product lookup, offers (cheapest NEW offer + affiliate URL), subscribe to `offer.price.changed` for a product.
- `GET /api/products/search?q=` proxy returning the api.md shape (channel3Id, title, gtin, mpn, imageUrl, bestPublicPriceCents, offerCount, condition).
- Upsert `products` by `channel3_id`; refresh `best_public_*` if older than 10 min (used by `publicOffer` in POST /bids).
- `channel3/match.ts`: GTIN equal (or MPN + brand equal), condition NEW, merchant on the authorized allowlist, USD → match or `{ignored, reason}`.
- Recorded fixtures for CI and for when promo credits run low; `CHANNEL3_ERROR` 502 on outage.

## Out of scope
- Webhook handling and voids (HF-042). Listing UI (HF-013).

## Acceptance criteria
- [ ] Search returns real Channel3 data for at least 3 demo products (Sony WH-1000XM5, Bose QC45, one more).
- [ ] Match gate table tests: 10 cases (GTIN mismatch, used, refurb, unauthorized merchant, non-USD, MPN+brand fallback, etc.).
- [ ] Outage returns `CHANNEL3_ERROR` and callers can fall back to manual GTIN entry.

## Test plan
- Unit: match gate table tests.
- Integration: 3 live calls with promo credits; CI uses fixtures.

## Notes & risks
- Spec question: the authorized-merchant allowlist is "editable in W11" (06) but there is no table/column for it in data-model.md. Proposed for P0: per-brand JSON config seeded by HF-045; W11 editing is P1 (HF-056).
- Spec question: 06 subscribes once per product, but data-model stores `channel3_subscription_id` on `listings`. Proposed: store on product, copy to listing.
- Channel3 credits are limited; cache aggressively.
