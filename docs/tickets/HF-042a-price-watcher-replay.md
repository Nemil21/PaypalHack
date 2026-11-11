# HF-042a: Price watcher: labelled replay and auto-void

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 2
- **Depends on:** HF-009, HF-016, HF-003a
- **Spec refs:** features/06-price-watcher.md §Logic 1–8, §Edge cases, §Acceptance criteria; features/17-demo-seeding.md §Demo script hooks (`demo:price-drop`); data-model.md §webhook_events, §bids (public_price_at_placement, void_reason)

## Goal
When an authorized store sells the exact product below a bid, release that bid (if the shopper opted in) within 60 s and point them to the cheaper offer. This ticket builds the shared processing path and the labelled demo replay first (S5 is unproven); HF-042b adds the live Channel3 webhook on the same path.

## Scope
- `processPriceEvent(event)` in `core/` (shared with HF-042b):
  - Two-stage match gate from HF-009 (product id, `channel3_variant`, `condition`, allowlisted domain from `brands.authorized_domains`, USD) → else audit `PRICE_IGNORED` with reason.
  - Recompute `products.best_public_price_cents` from the product-detail endpoint (cheapest new, in stock, allowlisted, USD offer), not `min(old, new)` (M13).
  - Select HELD bids on that product's OPEN/ROUNDS listings with `release_if_cheaper AND newPrice < amount_cents AND newPrice < public_price_at_placement` (M13).
  - Conditional `HELD→VOIDING` joined to `listings.status IN ('OPEN','ROUNDS')` (D2 lock order), then `voidBid` (HF-003a, request id `void-<bidId>`, D4) → VOIDED, `void_reason=PRICE_DROP`. Audit (actor WATCHER) with the cheaper offer, affiliate link and `AFFILIATE_DISCLOSURE` in `data`; SSE `pricewatch.released` (console toast).
  - Re-run the selection until it returns zero rows (catches raises that landed mid-run).
  - Mark `webhook_events.processed_at` only after processing; a loop on boot and every minute reprocesses rows where `processed_at IS NULL` (M13/M14).
- `POST /api/admin/replay-price-event` (admin from `ADMIN_EMAILS`) + `npm run demo:price-drop`: inserts the fixture into `webhook_events` with `data.replayed=true` and runs the same path; UI and audit label it "replayed event (demo)" from that data.
- Demo beat (B12): the fixture drops the price to just under **one foreground bid** (e.g. Claude Desktop bid $249 → drop to $245). SIM bids above it are seeded with `release_if_cheaper=false` (HF-045). The script prints how many bids it voided.
- Shopper surfaces: the release and cheaper-offer link (with disclosure) show on W15/M06 and W21 (HF-020) and in MCP `my_bids`.

## Out of scope
- Live Channel3 webhook, HMAC verification, outage banner, nightly poll (HF-042b).
- Re-bid lower under a mandate (needs intents, HF-052). Email/push (HF-054b).

## Acceptance criteria
- [ ] A replayed price event voids exactly the bids that meet the rule, within 60 s; `demo:price-drop` voids exactly N bids (N printed) and the post-drop `simulate(240)` matches the number HF-045 printed for the video script.
- [ ] Bids with "Release if cheaper" off, and bids below `public_price_at_placement` the shopper knowingly placed above, are untouched.
- [ ] Non-matching offers are ignored and audited with a reason.
- [ ] Race (stub, from old HF-047): replay in parallel with Clear → no bid is both WON and VOIDED; WON/LOST bids during CLEARING are never voided.
- [ ] Race (stub): a raise landing during processing is caught by the re-run selection.
- [ ] A crash after dedupe but before processing is recovered by the `processed_at IS NULL` loop.

## Test plan
- Unit: selection predicate; best-price recompute from fixtures.
- Integration (FakePayPal): replay → voids; replay ∥ Clear; crash/reprocess.
- Manual: demo beat 4 on the recording seed.

## Notes & risks
- Resolved (D4, Q#14): voids use `void-<bidId>`; no VOID settlement rows outside Clear (D's settlement-row alternative was rejected).
- Resolved (D17, Q#16/Q#18): the Channel3 subscription lives on `products` (`channel3_subscription_id`, `channel3_variant`); allowlist is `brands.authorized_domains`.
- Resolved (D18, Q#27): the shopper notification with the cheaper-offer link is in-app (timeline, W21, MCP `my_bids`); email/push in HF-054b.
- Stuck VOIDING bids are retried by the HF-034 sweeper with the same `void-<bidId>` key.
