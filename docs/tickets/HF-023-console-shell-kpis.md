# HF-023: Listing console shell (W06): header, KPI row on AG Studio, live updates

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 5
- **Estimate:** 3.5
- **Depends on:** HF-022, HF-008, HF-007
- **Spec refs:** features/08-brand-console.md §Layout 1–2, §Edge cases; screens.md §W06

## Goal
The hero screen's frame: header, KPI row and SSE wiring that later panels plug into.

## Scope
- Part 1 (fallback, build first):
  - `/brand` redirects to the newest listing console; the nav lists listings from `GET /listings` (0.5 h, from HF-026). HF-026 replaces the redirect with W04 later.
  - `npm run dev:bids`: inserts labelled SIM bids with stub holds and publishes `bid.held`, so the console can be tested before `sim:stream` (HF-046).
- Header:
  - product image, title;
  - status pill driven by shared `listingPhase(listing, now)`: BIDDING → AWAITING_ROUNDS_OR_CLEAR → ROUNDS_ACTIVE → ROUNDS_ENDED → CLEARING → SETTLED / PAID_OUT / PAYOUT_FAILED / EXPIRED / CANCELLED, each with its deadline;
  - "Clear by" = `min(clearDeadlineAt, oldestHoldAuthorizedAt + 66 h)` (D6);
  - public-low badge + "price watch on/paused";
  - Share offer link (copy);
  - Cancel window: confirm "N holds will be released. Shoppers' banks may show them as pending for a few days." → HF-012b async cancel (allowed from OPEN and ROUNDS). Disabled from CLEARING onward and for VIEWER.
- KPI row built on **AG Studio** with custom v3-themed widgets (M26): Held demand, Live bids, Projected cutoff + gross at slider, Recovery vs liquidation (×, `recoveryMultiple`), Released by price watch; hover "incl. $X simulated" (`stats.simulatedHeldCents`).
- SSE subscription; debounced (250 ms) book refetch on bursts and on reconnect; deltas applied only to grid rows.
- Price-drop toast from `pricewatch.released {count, priceCents, merchant}`: "3 bids released: public price dropped to $219".
- States: no bids (share prompt), live, book-changed banner, CLEARING (lock inputs → W08), EXPIRED/CANCELLED read-only, VIEWER read-only (seeded VIEWER via `DEMO_MODE` login).

## Out of scope
- Curve/slider (HF-024), grid (HF-025), brand agent panel (HF-051a/b, P1), live-round controls (HF-037a/b).

## Acceptance criteria
- [ ] KPIs update live as SIM bids stream in (`dev:bids`, later `sim:stream`).
- [ ] Empty state "No bids yet. Share your offer link."
- [ ] Simulated share of held $ shown on hover.
- [ ] Header shows the right phase and deadline for each `listingPhase` value, including after the window closes while still OPEN.
- [ ] KPI row renders as AG Studio widgets with no watermark.
- [ ] A burst of 50 events triggers at most a few refetches.

## Test plan
- Manual with `dev:bids`, then `sim:stream` (HF-046). Visual snapshots of empty/loading/live/cleared.
- Unit: `listingPhase()` table test (shared with HF-037a, HF-028, HF-026).

## Notes & risks
- Skeletons only on money numbers, never spinners (screens.md).
- Resolved (D6/D7): the listing stays OPEN after `window_closes_at` but no longer accepts new bids; the header shows "Bidding closed · start rounds or Clear by …".
