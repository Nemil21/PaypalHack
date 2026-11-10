# 03: Shopper Offer Page & Held Bid

**Priority:** P0 · **Owner:** C · **Effort:** 8 h

## Purpose
The main way shoppers arrive. A shopper names a price, PayPal holds that amount, and the bid enters the brand's private book. "Held, not charged."

## User stories
- As a shopper who clicked "Make an offer" on Sony's site, I see the product, the cheapest public price and how this works in 10 seconds.
- As a shopper, I name my price and approve a PayPal hold once.
- As a shopper, I know I'll never pay more than my bid and might pay less.

## Screens
W12 / M01 Offer page · W13 / M02 Hold approval + confirmation · W21 Error states (window closed, hold failed) · W14 / M03 My bids

## Logic
1. `GET /offers/:slug` shows:
   - the product and a verified-brand badge;
   - the "Cheapest public price $279 at 14 stores" anchor;
   - a countdown to window close;
   - a "How it works" 3-step strip: Name your price → PayPal holds it → Charged only if it clears, at the same price everyone pays.
2. Price input with a slider.
   - The default is the agent-suggested bid, about 18% below the public price.
   - Inline hints: "Bids near $219 are most likely to clear." This is a coarse band from the curve; the floor is never shown.
3. Payment choice: PayPal (default), or card.
   - Sign in by email magic link if not signed in. Sign-in can be skipped with PayPal, where the email comes from the PayPal order.
4. Click "Hold $229 with PayPal" → `POST /bids` (Idempotency-Key = uuid created on page load).
   - **PAYPAL:** redirect or popup to `approveUrl` → return to `/bids/return` → `pp.authorizeOrder` → bid HELD.
   - **CARD:** PayPal card fields (JS SDK v6) → order with `payment_source.card` and `store_in_vault: ON_SUCCESS` → HELD immediately (proven in S1/S2) → save `shoppers.paypal_vault_id`.
5. Confirmation (W13/M02):
   - "✓ $229 held, not charged";
   - what happens next (timeline);
   - "Let my agent manage this" (sets up a mandate → 05);
   - "Watch prices for me" (on by default).
6. SSE pushes `bid.held` to the brand console.

## Data / API
`bids`, `shoppers`, audit BID_PENDING / BID_HELD. PayPal: `pp.createAuthOrder`, `pp.authorizeOrder`.

## Edge cases
| Case | Handling |
|---|---|
| Shopper abandons PayPal approval | Bid stays PENDING_APPROVAL; marked ABANDONED after 30 min (cron); no hold exists |
| Window closes while approving | On return, if listing not OPEN: void the new authorization at once and show W21 "Window closed, your $229 was released" |
| Bid above best public price | Soft warn "Best Buy sells it for $219 today"; allow, but the watcher will void it immediately, so block in practice |
| Bid below floor | Accepted (floor is private); it just won't win. Prevents floor-probing |
| Shopper bids twice on the same listing | Second becomes a raise (see 04/05): create the new hold, then void the old |
| Authorization denied | W21 "PayPal couldn't hold this amount", with a retry using another method |
| Double click | Same Idempotency-Key, same bid |

## Acceptance criteria
- [ ] A shopper can place a real sandbox wallet hold and a real card hold.
- [ ] The bid appears on W06 within 2 s.
- [ ] The confirmation says "held, not charged" and shows the exact amount.
- [ ] No hold is left behind when the window closed during approval.
- [ ] Works at 375 px wide (M01/M02).

## Test plan
Integration: card hold with the test card (as in spike S1). Manual: wallet hold with the US sandbox personal account. E2E (Playwright): offer page → card hold → confirmation.
