# 06: Price Watcher & Auto-Void

**Priority:** P0 · **Owner:** D · **Effort:** 5 h

## Purpose
This works for the shopper, not the platform. When any authorized retailer sells the exact same new product for less than a bid, and the shopper has **"Release my hold if it's cheaper elsewhere"** on (default on, switchable off per bid or in the mandate), we release that bid and point them to the cheaper offer. Shoppers who switch it off keep their bid; paying above retail is their call. The server stays neutral on price. This is plain code, not an AI.

## User stories
- As a shopper, if Best Buy drops below my bid, my hold is released automatically and I get the link.
- As a shopper who wants this seller anyway, I can switch the release off and keep my bid.

## Screens
M06 Price-drop released notification + sheet · W15 / M04 timeline event · W06 (row disappears, toast) · W21 Price dropped state

## Logic
1. On publish, subscribe once per product to Channel3 `offer.price.changed`. All listings and bids share it.
2. `POST /webhooks/channel3`:
   - verify the signature;
   - insert into `webhook_events` (dedupe);
   - return 200;
   - process async.
3. **Exact-match gate (`channel3/match.ts`):** all of the following must hold:
   - the offer GTIN equals the product GTIN (or MPN + brand equal);
   - condition is NEW;
   - the merchant is on the authorized list (Channel3 merchant allowlist for the brand, editable in W11);
   - the price is in USD.

   Otherwise ignore, and audit `PRICE_IGNORED` with the reason.
4. Update `products.best_public_price_cents` if lower.
5. `SELECT bids WHERE product = X AND status='HELD' AND release_if_cheaper AND amount_cents > newPrice`. For each:
   - conditional update HELD→VOIDING;
   - `pp.void`;
   - VOIDED with `void_reason=PRICE_DROP`.
6. Notify each shopper:
   - "Best Buy now sells this at $219, below your $229 bid. Your hold is released. [Buy at Best Buy]". The link is the Channel3 affiliate link, which earns us affiliate revenue.
   - If the bid belongs to an intent with a mandate, the agent may re-bid at a lower amount (e.g. $209) only if the shopper opted in ("keep me in under the new price").
7. SSE `bid.voided` → console toast "3 bids released: public price dropped to $219."
8. **Fallback:** if Channel3 webhooks don't reach Render in time, `POST /admin/replay-price-event` replays a fixture. The UI marks it "replayed event (demo)".

## Edge cases
| Case | Handling |
|---|---|
| Price drop arrives during CLEARING | Bids already WON are not voided (status ≠ HELD); the conditional update prevents a race |
| Flapping prices (drop then rise in 1 min) | Void is final; shopper may re-bid |
| Refurb/used/grey offer | Ignored by the match gate |
| Duplicate webhook | Deduped by event ID |
| Channel3 outage | Banner "price watch paused" on affected listings; nightly poll as backup |

## Acceptance criteria
- [ ] A real or replayed price event voids exactly the bids above the new price, within 60 s.
- [ ] Non-matching offers are ignored and audited with a reason.
- [ ] The shopper notification includes the cheaper offer link.

## Test plan
Unit: match gate table tests (10 cases). Integration: post fixture webhook → verify voids in sandbox. Manual: demo beat 4.
