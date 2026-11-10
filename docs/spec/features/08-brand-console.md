# 08: Brand Console (AG Grid Book, Demand Curve, Slider)

**Priority:** P0, the hero screen and the largest sponsor prize (AG Grid) · **Owner:** B · **Effort:** 12 h

## Purpose
The brand sees committed demand (money already held) at every price and decides how much to clear. This is the product the brand pays for.

## User stories
- As a brand manager, I see "$61k held at ≥ $219" at a glance.
- As a brand manager, I drag a quantity slider and instantly see the clearing price, recovery and liquidation comparison.
- As a brand manager, I see each bid (anonymized) live, with its source, and filter/sort them.

## Screens
W04 Overview dashboard · W06 Listing console · W07 Clear confirmation modal · M10 Brand mobile alert

## Layout of W06
1. **Header:**
   - product image, title, status pill (OPEN · closes in 41:12:09);
   - public low price badge with "price watch on";
   - buttons: Share offer link, Cancel window.
2. **KPI tiles (AG Studio widgets):**
   - Held demand ($);
   - Live bids;
   - Projected clearing price at the current slider;
   - Recovery vs liquidation (×5.8);
   - Released by price watch (count).
3. **Demand curve (AG Charts):**
   - x = price, y = units with bids at or above that price (step line);
   - a second series for held dollars;
   - vertical markers for floor (brand only), public low and current projected clearing price.
   - Hovering shows "120 bids ≥ $229 · $27.5k held".
4. **Quantity slider (0 … listing quantity):**
   - on change, call `/simulate` (debounced 150 ms; or compute client-side with the same pure `auction.ts` from `packages/shared`);
   - updates the clearing price marker and the KPIs.
5. **Bids grid (AG Grid Enterprise).** Columns:
   - Rank, Bid, Placed, Source (Offer page / Agent / MCP / SIM), Shopper label, Status, Would win? (at the current slider).
   - Live row insert/remove via SSE with row flash animation.
   - Grouping by source; set filter; sticky header.
   - SIM rows show a grey "SIM" chip.
6. **Brand agent panel** (right side, see 09): recommendation card, plus "Ask about this book" input.
7. **Clear button** (primary). Opens W07 with:
   - quantity, clearing price, winners, losers;
   - gross, fee and net;
   - "Holds above $219 are charged $219; the rest released";
   - a type-to-confirm field (`CLEAR 240`).
8. After Clear, W06 switches to W08 Settlement live view.

## Overview W04
- Cards per listing: status, held demand, time left, sparkline.
- Totals: recovered this month, fees, payouts pending.
- "New listing" CTA.

## Data / API
`GET /listings/:id/book`, `GET /listings/:id/simulate`, SSE `/listings/:id/events`, `POST /listings/:id/clear`.

## Edge cases
| Case | Handling |
|---|---|
| 0 bids | Empty state: "No bids yet. Share your offer link." + W10 shortcut |
| Fewer qualifying bids than slider quantity | The slider clamps to max qualifying (bids ≥ floor); tooltip explains |
| Book changes while the modal is open | Clear sends `expectedClearingPriceCents`; on 409, re-simulate and show "Book changed: new price $217" |
| VIEWER role | Clear hidden; read-only |
| 5k+ bids | AG Grid virtualization; curve computed server-side |

## Acceptance criteria
- [ ] The curve, KPIs and grid update live as bids arrive (demo: SIM bidders streaming).
- [ ] The slider recomputes the clearing price exactly as the server auction does (shared code + test).
- [ ] The Clear modal shows exact money numbers and requires a typed confirm.
- [ ] AG Grid licence key is loaded, with no watermark; custom theme matches design.

## Test plan
Unit: curve builder. Visual: Storybook snapshots of empty/loading/live/cleared. Manual: 300-bid seed, slider performance < 50 ms.
