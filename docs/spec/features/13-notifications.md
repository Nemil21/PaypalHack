# 13: Notifications (Email, Push, In-App)

**Priority:** P0 (in-app, D18), P1 (`notify()` + bell, email, web push, M11 set) · **Owner:** C · **Effort:** 4 h

## Purpose
Shoppers don't watch a dashboard. Every money event reaches them in words they understand. Brands get alerts that matter.

## Channels
- **P0 in-app (D18):** the bid timeline (W15/M04), W21 states, M06/M07 sheets, MCP `my_bids`, and `GET /bids/mine` polled every 5 s during ROUNDS. No email or push is needed for the demo.
- **In-app:** bell + list (W14/M03 header) via `notify()` as an audit subscriber (P1).
- **Email (P1):** Resend; in demo mode, logged to the console and the in-app list.
- **Web push** (PWA, P1): VAPID keys; `POST /notifications/subscribe`.
- PayPal sends its own receipts for captures; we don't duplicate those.

## Templates (M11 shows them all)
| Template | To | Trigger | Copy (short) |
|---|---|---|---|
| `bid_held` | Shopper | BID_HELD | "$229 held, not charged. Window closes Thu 6 pm." |
| `price_drop_released` | Shopper | PRICE_DROP void | "A store sells it for $245 now. We released your $249 hold. Your bank may show it as pending for a few days. Buy there →" (+ affiliate disclosure) |
| `below_clearing` | Shopper | Once per window, when the bid is below the likely clearing band 12 h before close | "Bids around $219 are likely to clear. Raise?" |
| `round_nudge` | Shopper | Live-round nudge (19) | "You're out at $219. The cutoff for 240 units is $240. Raise to $241?" |
| `bid_rolled` | Shopper | Auto-roll | "Your agent re-bid $210 in Aurel Audio's new window." |
| `won` | Shopper | CAPTURED | "You won at your bid of $229. Charged $229." |
| `promoted` | Shopper | Promotion (11) | "A unit opened up. You won at your bid of $219. Charged $219." |
| `reserve` | Shopper | LOST with a reserve hold | "You're on the reserve list. Your $215 hold stays until clearing finishes." |
| `lost` | Shopper | VOIDED (LOST) | "Didn't clear this time. $229 released. Your bank may show it as pending for a few days. Keep bidding?" |
| `payment_failed` | Shopper | CAPTURE_FAILED | "PayPal couldn't charge your card; you didn't get this one." |
| `shipped` | Shopper | Tracking added | "On its way: UPS 1Z…" |
| `brand_demand_milestone` | Brand | Held demand crosses $10k/$25k/$50k | "$61k now held at ≥ $219." |
| `brand_window_closing` | Brand | 6 h before close | "Window closes in 6 h; recommended: clear 240 at $219." |
| `brand_cleared` | Brand | SETTLED | "Cleared 240 units, each at the winner's own bid (lowest $219, average $226). Payout $49.4k on its way." |
| `brand_payout_failed` | Brand | PAYOUT_FAILED | "Payout failed; we're retrying." |

## Logic
- `notify(recipient, template, payload)` subscribes to audit events, inserts a row (deduped by key) and fans out to enabled channels.
- Every release message adds "Your bank may show it as pending for a few days." (D14).
- Per-user preferences live in W17/M09 (shopper) and W11 (brand).
- Never put card or PayPal IDs in notification text.
- Links use signed short-lived tokens, with no personal data in query strings.

## Acceptance criteria
- [ ] Each template fires once per event (dedupe on entity + template).
- [ ] The in-app list shows unread counts and mark-as-read.
- [ ] (P1) A push arrives on a phone for `price_drop_released`.

## Test plan
Unit: template rendering. Integration: event → notification row. Manual: phone push in demo.
