# 17: Demo Seeding & Simulated Bidders (Labelled Honestly)

**Priority:** P0 · **Owner:** D · **Effort:** 4 h

## Purpose
A market needs many bidders. The demo uses simulated bidders for volume and a few real sandbox holds in the foreground. Everything simulated is clearly labelled, so judges trust the rest.

## Seed script (`npm run seed:demo`)
Video rules forbid third-party trademarks, so the demo brand is the fictional **Aurel Audio** (D15). Real Channel3 calls stay on screen in product search and agent price comparisons.

1. Brands (seeded through core services, not the listings API):
   - "Aurel Audio (demo)", verified, payout to the sandbox brand account, `authorized_domains` set; a seeded OWNER and a seeded VIEWER;
   - a second, smaller Aurel Audio listing (e.g. Aurel A5) for multi-product intent demos.
2. Products: Aurel A7 Wireless — Midnight (and the A5), with Channel3 fixtures recorded from live calls for the public-price anchor.
3. Listings: Aurel A7 300 units, floor $199, liquidation $38; clock `window_closes_at = now + 4 h` (`--window-left` flag) so rounds and Clear fit the recording; winning bids seeded to average $226 (gross $54,240) from a **deterministic bid table**; the script prints the expected post-drop and post-rounds `simulate(240)` numbers the video script uses.
4. Bidders: 280 SIM shoppers (`is_simulated=true`) from the deterministic table:
   - mostly $189–$249, peak around $215–$225;
   - SIM bids above the price-drop target are `release_if_cheaper=false` (B12);
   - ~20 SIM round agents get vaulted cards and mandates so they can auto-raise in live rounds.
5. **SIM holds are real sandbox card holds** (S1 flow) spread across 4–5 test cards, in batches with concurrency 5; only the round agents are vaulted. Dev seeds use the `FakePayPal` stub; only the recording seed uses the real sandbox.
   - If rate-limited, fall back to DB-only SIM bids with `paypal_authorization_id = null`, marked "SIM (no hold)". These never reach Clear (D8). The seed **aborts** if more than 10% fall back.
   - The fallback is shown in the UI and stated in the README.
   - Reruns are keyed by `demo_run_id`.
6. Live mode `npm run sim:stream --count N`: adds a bounded number of SIM bids every 2–4 s during recording, so the console looks alive; paused before Clear.

## Labelling rules
- SIM rows show a grey "SIM" chip in every grid and list.
- The KPI tiles show "incl. $X simulated" on hover.
- The video narration says which bids are real (Maya's offer-page hold, the Claude Desktop MCP bid) and which are simulated; the live-rounds segment is time-lapsed and labelled.
- The README has a "What's real vs simulated" table.

## Demo script hooks
- `npm run demo:price-drop`: replays the Channel3 fixture (labelled "replayed event") to just under one foreground bid; prints the N bids it voids.
- `npm run demo:decline`: sets `listings.demo_decline_rank` so the winner at that rank gets `PayPal-Mock-Response INSTRUMENT_DECLINED` on capture (`DEMO_MODE` only; requires eligible > Q so a promotion is possible).
- `npm run demo:reset` (CLI only, owner-role DB URL, refused while settling): sweep → `reconcile:holds` → verify no live authorizations are left → truncate → reseed. Keeps foreground actors (`is_demo_foreground`) and their MCP tokens.
- `demo:refresh`: a daily Render cron through Dec 21 that resets and seeds a smaller judge book, so the hosted demo stays live for judging.

## Acceptance criteria
- [ ] One command produces a lively console in < 5 min.
- [ ] Reset leaves no dangling sandbox holds.
- [ ] Every simulated item is visibly labelled.

## Test plan
Run the seed and reset twice on the stub, then once in sandbox; check for leftover authorizations with `reconcile:holds` (P0, part of the sweeper ticket; D19).
