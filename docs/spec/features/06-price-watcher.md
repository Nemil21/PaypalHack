# 06: Price Watcher & Auto-Void

**Priority:** P0 · **Owner:** D · **Effort:** 5 h

## Purpose
This works for the shopper, not the platform. When any authorized retailer sells the exact same new product for less than a bid, and the shopper has **"Release my hold if it's cheaper elsewhere"** on (default on, switchable off per bid or in the mandate), we release that bid and point them to the cheaper offer. Shoppers who switch it off keep their bid; paying above retail is their call. The server stays neutral on price. This is plain code, not an AI.

## User stories
- As a shopper, if an authorized store drops below my bid, my hold is released automatically and I get the link.
- As a shopper who wants this seller anyway, I can switch the release off and keep my bid.

## Screens
M06 Price-drop released notification + sheet · W15 / M04 timeline event · W06 (row disappears, toast) · W21 Price dropped state

## Logic
1. On publish, subscribe once per **product + variant** (the subscription id lives on `products`, D17), with `brands.authorized_domains` (≤ 25) as the domain list. All listings and bids share it; publish reuses an existing subscription.
2. `POST /webhooks/channel3` (payload shape in [api.md](../api.md)):
   - verify the HMAC signature (`CHANNEL3_WEBHOOK_SECRET`);
   - insert into `webhook_events` (dedupe on `processed_at IS NOT NULL`);
   - return 2xx within 15 s;
   - process async; unprocessed rows are retried on boot and every minute.
3. **Exact-match gate (`channel3/match.ts`), two stages (M21):**
   - **at listing creation:** GTIN/MPN (from `structured_attributes` or entered by hand) plus brand;
   - **per offer / webhook:** Channel3 product id + variant equal to the listing's; `condition == "new"`; `domain` in `brands.authorized_domains` (editable in W11); `currency == "USD"`. Prices are decimals: convert to cents once.

   Otherwise ignore, and audit `PRICE_IGNORED` with the reason.
4. Recompute `products.best_public_price_cents` from the free product-detail endpoint (cheapest new, in-stock, allowlisted, USD offer), not `min(old, new)`, so rises and stock-outs are reflected.
5. `SELECT bids WHERE product = X AND status='HELD' AND release_if_cheaper AND newPrice < amount_cents AND newPrice < public_price_at_placement` on listings OPEN/ROUNDS. For each:
   - conditional update HELD→VOIDING (joined to the listing's status, so it can't race Clear's row locks);
   - `pp.void` (`void-<bidId>`), retried with backoff;
   - VOIDED with `void_reason=PRICE_DROP`.

   Re-run the selection until it returns zero rows (catches raises that landed mid-run).
6. Notify each shopper in-app (bid timeline, M06, W21; D18):
   - "A store now sells this at $245, below your $249 bid. Your hold is released. Your bank may show it as pending for a few days. [Buy there]". The link is the Channel3 affiliate link, shown with the affiliate disclosure, which earns us affiliate revenue.
   - If the bid belongs to an intent with a mandate, the agent may re-bid at a lower amount (e.g. $209) only if the shopper opted in ("keep me in under the new price").
7. SSE `bid.voided` → console toast "3 bids released: public price dropped to $219."
8. **Replay path, built first:** `POST /admin/replay-price-event` (admin only) replays a fixture through the same handler and stamps `replayed=true`; the UI marks it "replayed event (demo)" from that data. The live Channel3 webhook (S5) is built after it.
9. **Demo beat (B12):** the replayed drop goes to just under **one foreground bid** (e.g. the $249 Claude Desktop bid → $245). SIM bids above that price are seeded with `release_if_cheaper=false`, so the void hits ≤ 3 bids; the seed script prints the post-drop `simulate(240)` the video uses.

## Edge cases
| Case | Handling |
|---|---|
| Price drop arrives during CLEARING | Bids already WON are not voided (status ≠ HELD); the conditional update prevents a race |
| Flapping prices (drop then rise in 1 min) | Void is final; shopper may re-bid |
| Refurb/used/grey offer | Ignored by the match gate |
| Duplicate webhook | Deduped by event ID |
| Channel3 outage | Banner "price watch paused" on affected listings; nightly poll of the detail endpoint as backup (both built after the live webhook) |
| Agent auto-raise above the public price | Refused when `release_if_cheaper` is on; the agent asks the shopper |

## Acceptance criteria
- [ ] A real or replayed price event voids exactly the bids above the new price, within 60 s; `demo:price-drop` voids exactly the N bids its script prints.
- [ ] Non-matching offers are ignored and audited with a reason.
- [ ] The shopper notification includes the cheaper offer link.

## Test plan
Unit: match gate table tests (10 cases). Integration: post fixture webhook → verify voids in sandbox. Manual: demo beat 4.
