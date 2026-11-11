# 17: Demo Seeding & Simulated Bidders (Labelled Honestly)

**Priority:** P0 · **Owner:** D · **Effort:** 4 h

## Purpose
A market needs many bidders. The demo uses simulated bidders for volume and a few real sandbox holds in the foreground. Everything simulated is clearly labelled, so judges trust the rest.

## Seed script (`npm run seed:demo`)
1. Brands:
   - "Sony Audio US (demo)", verified, payout to the sandbox brand account;
   - "Bose (demo)", a second book for multi-brand and intent demos.
2. Products: real Channel3 lookups for Sony WH-1000XM5 and Bose QC45 (cached as fixtures if credits run low).
3. Listings: Sony 300 units, floor $199, liquidation $38, 48 h window + live rounds; winning bids seeded to average $226 (gross $54,240); Bose 150 units.
4. Bidders: 280 SIM shoppers (`is_simulated=true`) with bids drawn from a realistic distribution:
   - mostly $189–$249, peak around $215–$225;
   - placed over a simulated 48 h.
5. **SIM holds are real sandbox card holds**, using the same test-card flow as spike S1, in batches with concurrency 5.
   - If rate-limited, fall back to DB-only SIM bids with `paypal_authorization_id = null`, marked "SIM (no hold)".
   - The fallback is shown in the UI and stated in the README.
6. Live mode `npm run sim:stream`: adds 1 SIM bid every 2–4 s during recording, so the console looks alive.

## Labelling rules
- SIM rows show a grey "SIM" chip in every grid and list.
- The KPI tiles show "incl. $X simulated" on hover.
- The video narration says which bids are real (Maya's offer-page hold, the Claude Desktop MCP bid) and which are simulated.
- The README has a "What's real vs simulated" table.

## Demo script hooks
- `npm run demo:price-drop`: replays the Channel3 fixture (labelled "replayed event") if the live webhook is not available.
- `npm run demo:decline`: marks one winner to get `PayPal-Mock-Response INSTRUMENT_DECLINED` on capture.
- `npm run demo:reset`: voids all holds and reseeds.

## Acceptance criteria
- [ ] One command produces a lively console in < 5 min.
- [ ] Reset leaves no dangling sandbox holds.
- [ ] Every simulated item is visibly labelled.

## Test plan
Run the seed and reset twice; check the PayPal sandbox for leftover authorizations via the reconcile job.
