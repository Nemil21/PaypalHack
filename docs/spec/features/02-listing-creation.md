# 02: Listing Creation (Channel3 Product Match)

**Priority:** P0 · **Owner:** B (UI), D (Channel3) · **Effort:** 6 h

## Purpose
A brand turns overstock into an open, private window. The product is pinned to an exact identity (GTIN/MPN), so price comparisons and auto-voids can't be fooled by look-alikes.

## User stories
- As a brand manager, I search my product and pick the exact SKU.
- As a brand manager, I set quantity, a floor price and my liquidator quote so I can compare outcomes.
- As a brand manager, I choose a window (max 48 h) and get a shareable offer link.

## Screens
W05 Create listing wizard (4 steps) · W04 Overview (new listing card) · W10 Embed & share (after publish)

## Logic
1. **Step 1, Product.** Search box calls `GET /products/search`.
   - Results show image, title, variant, GTIN, MPN, cheapest public price and offer count. The brand picks the exact variant (`products.channel3_variant`).
   - Only `condition=NEW` results whose `brand_name` fuzzy-matches the verified brand name can be selected. Others show "Not your brand" disabled.
2. **Step 2, Quantity & price.**
   - Inputs: quantity, floor price, liquidation quote per unit.
   - Helper text: "Cheapest public price $279. Floor is private; shoppers never see it."
   - Validation: floor < best public price; quantity ≥ 1.
3. **Step 3, Window.**
   - Start now or at a set time; length 24 or 48 h only.
   - Explain why: "Card holds are guaranteed for 3 days."
4. **Step 4, Review.** A summary card plus an estimate: "If 60% of quantity clears at the floor: $X vs $Y liquidation."
   - "Save draft" or "Publish".
5. **Publish:**
   - `POST /listings` then `POST /listings/:id/publish`;
   - subscribe to Channel3 price webhooks for the product + variant, or reuse the existing subscription (`products.channel3_subscription_id`, D17), outside the DB transaction;
   - set every D6 deadline (`window_closes_at`, `clear_deadline_at`);
   - generate the `slug`;
   - status becomes OPEN.
6. Redirect to W06 with a toast "Window open: share your offer link" → W10.

## Data / API
`products` (upsert by channel3_id), `listings`, audit LISTING_CREATED / LISTING_PUBLISHED. Channel3: search/lookup, offers, subscribe.

## Edge cases
| Case | Handling |
|---|---|
| Channel3 down | Allow a manual GTIN entry; mark `best_public_price` unknown; price watcher off for this listing (badge) |
| Product has no GTIN | Use MPN + brand; if neither exists, block (needed for exact matching) |
| Same product already has an OPEN listing for this brand | Block; link to the existing one |
| Floor ≥ best public price | Warn "No one will bid above a cheaper store" and block |
| Brand edits after publish | Only quantity can increase (`PATCH /listings/:id`, while OPEN; later wave); floor and window are locked (fairness) |

## Acceptance criteria
- [ ] The search returns real Channel3 data for at least 3 demo products.
- [ ] Wrong-brand products cannot be selected.
- [ ] Window > 48 h is rejected by both UI and API.
- [ ] Publishing creates a Channel3 subscription and a working `/o/:slug` offer link.

## Test plan
Unit: validation rules. Integration: Channel3 client against the live API with promo credits (3 calls) and recorded fixtures for CI. Manual: create the Aurel A7 listing end to end.
