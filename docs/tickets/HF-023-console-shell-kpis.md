# HF-023: Listing console shell (W06): header, KPI tiles, live updates

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-022, HF-008, HF-007
- **Spec refs:** features/08-brand-console.md §Layout 1–2, §Edge cases; screens.md §W06

## Goal
The hero screen's frame: header, KPI tiles and SSE wiring that later panels plug into.

## Scope
- Header: product image, title, status pill with countdown, public-low badge + "price watch on/paused", Share offer link (copy), Cancel window (confirm → HF-012 cancel).
- KPI tiles (AG Studio widgets or styled Stat tiles): Held demand, Live bids, Projected cutoff + gross at slider, Recovery vs liquidation (×), Released by price watch; hover "incl. $X simulated".
- SSE subscription; re-fetch book on reconnect; price-drop toast "3 bids released: public price dropped to $219".
- States: no bids (share prompt), live, book-changed banner, CLEARING (lock inputs → W08), EXPIRED/CANCELLED read-only, VIEWER read-only.

## Out of scope
- Curve/slider (HF-024), grid (HF-025), brand agent panel (HF-051, P1), live-round controls (HF-037).

## Acceptance criteria
- [ ] KPIs update live as SIM bids stream in.
- [ ] Empty state "No bids yet. Share your offer link."
- [ ] Simulated share of held $ shown on hover.

## Test plan
- Manual with `sim:stream` (HF-046). Visual snapshots of empty/loading/live/cleared.

## Notes & risks
- Skeletons only on money numbers, never spinners (screens.md).
