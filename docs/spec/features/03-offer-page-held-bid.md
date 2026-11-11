# 03: Shopper Offer Page & Held Bid

**Priority:** P0 · **Owner:** C · **Effort:** 8 h

## Purpose
The main way shoppers arrive. A shopper names a price, PayPal holds that amount, and the bid enters the brand's private book. "Held, not charged."

## User stories
- As a shopper who clicked "Make an offer" on Aurel Audio's site, I see the product, the cheapest public price and how this works in 10 seconds.
- As a shopper, I name my price and approve a PayPal hold once.
- As a shopper, I know I pay exactly my bid, only if I win, and never more.

## Screens
W12 / M01 Offer page · W13 / M02 Hold approval + confirmation · W21 Error states (window closed, hold failed) · W14 / M03 My bids

## Logic
1. `GET /offers/:slug` shows:
   - the product and a verified-brand badge;
   - the "Cheapest public price $279 at 14 stores" anchor;
   - a countdown to window close;
   - a "How it works" 3-step strip: Name your price → PayPal holds it → Charged your bid only if you win; otherwise released.
2. Price input with a slider.
   - The default is the agent-suggested bid, about 18% below the public price.
   - Inline hints: "Bids near $219 are most likely to clear." This comes from the shared floor-blind `likelyBand()` ($10 buckets, bands with < 3 bids merged, shown only if eligible ≥ quantity); the floor is never shown.
3. Payment choice: PayPal (default), or card.
   - The first visit creates an anonymous shopper bound to a cookie, so every bid has a `shopper_id` (D13). Sign in by email magic link (console-logged locally) or with PayPal, where the email comes from the PayPal order; on Render, `DEMO_MODE` offers "Sign in as demo shopper".
4. Click "Hold $229 with PayPal" → `POST /bids` (Idempotency-Key = uuid per user action; a new key after a terminal failure).
   - **PAYPAL:** redirect or popup to `approveUrl` (`rel=payer-action`) → return to `/bids/return` → `POST /bids/:id/authorize` (`authz-<bidId>`) → `landHold` → HELD. Wallet bids don't vault, so their raises need a new approval.
   - **CARD (two-step, D1/B8):** `POST /bids` returns PENDING_APPROVAL + `orderId` → PayPal card fields (JS SDK v6) submit in the browser (maybe 3DS) → `POST /bids/:id/authorize` → `landHold` → HELD; vaulted on success (`store_in_vault: ON_SUCCESS`) → save `shoppers.paypal_vault_id`. Card data never touches our API. Proven first in spike S7 (HF-063).
   - **Fallback, built first:** a labelled "Use sandbox test card" button (`paymentMethod: TEST_CARD`, sandbox / `DEMO_MODE` only) places an S1-style hold server-side. Card fields are built after it.
5. Confirmation (W13/M02):
   - "✓ $229 held, not charged";
   - what happens next (timeline);
   - "Let my agent manage this" (sets up a mandate → 05);
   - "Release my hold if it's cheaper elsewhere" (on by default, can be switched off later via `PATCH /bids/:id`; see 06).
6. SSE pushes `bid.held` to the brand console.

## Data / API
`bids`, `shoppers`, audit BID_PENDING / BID_HELD. PayPal: `pp.createAuthOrder`, `pp.authorizeOrder`.

## Edge cases
| Case | Handling |
|---|---|
| Shopper abandons PayPal approval | Bid stays PENDING_APPROVAL; marked ABANDONED after 30 min (cron); no hold exists |
| Window closes while approving | On return, if the listing is no longer biddable: don't authorize (no hold is created) and show W21 "This window has closed." If an authorization already exists, `landHold` voids it and shows "Window closed, your $229 was released. Your bank may show it as pending for a few days." |
| Bid above best public price | Allowed: it's the shopper's call. The server stays neutral and returns `publicOffer {domain, priceCents, url}` with the bid; the shopper side (this page, the buyer agent, the SDK) warns "A store sells it for $219 today. Still bid $239?". Confirming the warning sets `releaseIfCheaper=false`. The price watcher only releases bids whose owner has "Release if cheaper elsewhere" on (06) |
| Bid below floor | Accepted (floor is private); it just won't win. Prevents floor-probing |
| Shopper bids twice on the same listing | One live bid per shopper per listing (D3): the second `POST /bids` returns `409 ALREADY_BID {bidId}` and the page shows "Raise or cancel". Lowering a bid = cancel + new bid, which loses time priority |
| Authorization denied | Bid `HOLD_FAILED` (terminal); W21 "PayPal couldn't hold this amount", with a retry using another method (new bid, new Idempotency-Key) |
| Double click | Same Idempotency-Key, same bid |

## Acceptance criteria
- [ ] A shopper can place a real sandbox hold with the labelled test-card button, then with card fields, and a real wallet hold.
- [ ] Two tabs bidding at once leave exactly one HELD bid (the other gets `ALREADY_BID`).
- [ ] The bid appears on W06 within 2 s.
- [ ] The confirmation says "held, not charged" and shows the exact amount.
- [ ] No hold is left behind when the window closed during approval.
- [ ] Works at 375 px wide (M01/M02).

## Test plan
Integration: card hold with the test card (as in spike S1). Manual: wallet hold with the US sandbox personal account. Manual script first, then E2E (Playwright): offer page → card hold → confirmation.
