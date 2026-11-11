# 08: Brand Console (AG Grid Book, Demand Curve, Slider)

**Priority:** P0, the hero screen and the largest sponsor prize (AG Grid) · **Owner:** B · **Effort:** 12 h

## Purpose
The brand sees committed demand (money already held) at every price and decides how much to clear. This is the product the brand pays for.

## User stories
- As a brand manager, I see "$61k held at ≥ $219" at a glance.
- As a brand manager, I drag a quantity slider and instantly see the cutoff, gross revenue (sum of winners' bids) and liquidation comparison.
- As a brand manager, I see each bid (anonymized) live, with its source, and filter/sort them.

## Screens
W04 Overview dashboard · W06 Listing console · W07 Clear confirmation modal · M10 Brand mobile alert

## Layout of W06
1. **Header:**
   - product image, title, status pill from shared `listingPhase()` (OPEN · closes in 41:12:09 / ROUNDS · round 2 / FROZEN · clear by …); "Clear by" = min(`clear_deadline_at`, oldest hold `authorized_at` + 66 h);
   - public low price badge with "price watch on";
   - buttons: Share offer link, Cancel window.
2. **KPI tiles (AG Studio widgets; the KPI row is built on AG Studio, the AG Grid prize criterion):**
   - Held demand ($);
   - Live bids;
   - Projected cutoff and gross revenue at the current slider;
   - Recovery vs liquidation (×5.8);
   - Released by price watch (count).
3. **Demand curve (AG Charts):**
   - x = price, y = units with bids at or above that price (step line);
   - a second series for held dollars;
   - vertical markers for floor (brand only), public low and current projected cutoff.
   - Hovering shows "120 bids ≥ $229 · $27.5k held".
4. **Quantity slider (0 … listing quantity):**
   - range 1 … min(quantity, eligible bids); prefix sums while dragging, the shared pure `clear()` on release (same code as the server);
   - updates the cutoff marker and the KPIs.
5. **Bids grid (AG Grid Enterprise).** Columns:
   - Rank, Bid, Placed, Source (Offer page / Agent / MCP / SIM), Shopper label, Status, Would win? (at the current slider).
   - Live row insert/remove via SSE with row flash animation (`getRowId` + `applyTransactionAsync`); a raise (`bid.raised`) flashes the row in place.
   - Below-floor bids show "below floor" instead of a rank.
   - Grouping by source; set filter; sticky header.
   - SIM rows show a grey "SIM" chip.
6. **Brand agent panel** (right side, see 09): recommendation card, plus "Ask about this book" input.
7. **Clear button** (primary). Opens W07 with:
   - quantity, cutoff, gross revenue, winners, losers;
   - gross, fee and net;
   - "Each winner is charged their own bid (lowest $219, average $226). Everyone else's hold is released.";
   - a type-to-confirm field (`CLEAR 240`).
   - during ROUNDS the button reads **"Stop rounds & clear"** (stops rounds, then opens W07);
   - on 409 the modal shows the new numbers with one-click "Confirm $X" (`reason: BOOK_CHANGED`) or a read-only message (`reason: NOT_CLEARABLE`).
8. After Clear, W06 switches to W08 Settlement live view.

## Overview W04
- Backed by `GET /brands/me/overview` (later wave; the console works without it).
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
| Book changes while the modal is open | Clear sends `expectedGrossCents`; on 409 `BOOK_CHANGED` the response carries the new numbers: "Book changed: new gross $54.0k. Confirm $54.0k?" (one click). The demo pauses `sim:stream` before Clear |
| Bids without a hold | Never shown as eligible; excluded from the curve, slider and Clear (shared eligibility, D8) |
| VIEWER role | Clear hidden; read-only |
| 5k+ bids | AG Grid virtualization; curve computed server-side |

## Acceptance criteria
- [ ] The curve, KPIs and grid update live as bids arrive (demo: SIM bidders streaming).
- [ ] The slider recomputes the cutoff and gross exactly as the server auction does (shared code + test).
- [ ] The Clear modal shows exact money numbers and requires a typed confirm.
- [ ] AG Grid licence key is loaded, with no watermark; custom theme matches design.

## Test plan
Unit: curve builder. Visual: Storybook snapshots of empty/loading/live/cleared. Manual: 300-bid seed, slider performance < 50 ms.
