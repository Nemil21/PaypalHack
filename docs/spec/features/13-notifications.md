# 13: Notifications (Email, Push, In-App)

**Priority:** P0 (in-app + email), P1 (web push) · **Owner:** C · **Effort:** 4 h

## Purpose
Shoppers don't watch a dashboard. Every money event reaches them in words they understand. Brands get alerts that matter.

## Channels
- **In-app:** bell + list (W14/M03 header).
- **Email:** Resend; in demo mode, logged to the console and the in-app list.
- **Web push** (PWA, P1): VAPID keys; `POST /notifications/subscribe`.
- PayPal sends its own receipts for captures; we don't duplicate those.

## Templates (M11 shows them all)
| Template | To | Trigger | Copy (short) |
|---|---|---|---|
| `bid_held` | Shopper | BID_HELD | "$229 held, not charged. Window closes Thu 6 pm." |
| `price_drop_released` | Shopper | PRICE_DROP void | "Best Buy is $219 now. We released your $229 hold. Buy there →" |
| `below_clearing` | Shopper | Once per window, when the bid is below the likely clearing band 12 h before close | "Bids around $219 are likely to clear. Raise?" |
| `bid_rolled` | Shopper | Auto-roll | "Your agent re-bid $210 in Sony's new window." |
| `won` | Shopper | CAPTURED | "You got it at $219 (you bid $229). $10 released." |
| `lost` | Shopper | VOIDED (LOST) | "Didn't clear this time. $229 released. Keep bidding?" |
| `payment_failed` | Shopper | CAPTURE_FAILED | "PayPal couldn't charge your card; you didn't get this one." |
| `shipped` | Shopper | Tracking added | "On its way: UPS 1Z…" |
| `brand_demand_milestone` | Brand | Held demand crosses $10k/$25k/$50k | "$61k now held at ≥ $219." |
| `brand_window_closing` | Brand | 6 h before close | "Window closes in 6 h; recommended: clear 240 at $219." |
| `brand_cleared` | Brand | SETTLED | "Cleared 240 at $219. Payout $47.8k on its way." |
| `brand_payout_failed` | Brand | PAYOUT_FAILED | "Payout failed; we're retrying." |

## Logic
- `notify(recipient, template, payload)` inserts a row and fans out to enabled channels.
- Per-user preferences live in W17/M09 (shopper) and W11 (brand).
- Never put card or PayPal IDs in notification text.
- Links use signed short-lived tokens, with no personal data in query strings.

## Acceptance criteria
- [ ] Each template fires once per event (dedupe on entity + template).
- [ ] The in-app list shows unread counts and mark-as-read.
- [ ] (P1) A push arrives on a phone for `price_drop_released`.

## Test plan
Unit: template rendering. Integration: event → notification row. Manual: phone push in demo.
