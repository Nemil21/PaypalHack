# HF-045: Demo seed script (`npm run seed:demo`)

- **Track / owner:** D integrations & demo
- **Priority:** P0
- **Estimate:** 4
- **Depends on:** HF-012, HF-014, HF-017
- **Spec refs:** features/17-demo-seeding.md §Seed script, §Labelling rules, §Acceptance criteria

## Goal
One command produces a lively, honestly labelled market in under 5 minutes.

## Scope
- Brands: "Sony Audio US (demo)" (VERIFIED, payout to the sandbox brand account) and "Bose (demo)"; authorized-retailer allowlists.
- Products: Channel3 lookups for Sony WH-1000XM5 and Bose QC45, cached fixtures fallback.
- Listings: Sony 300 units, floor $199, liquidation $38, 48 h window; Bose 150 units.
- 280 SIM shoppers (`is_simulated=true`) with bids mostly $189–$249, peak $215–$225, `placed_at` spread over a simulated 48 h, tuned so the top 240 average ≈ $226 (gross ≈ $54,240).
- SIM holds are **real sandbox card holds** via `placeBid` (concurrency 5); on rate limit fall back to DB-only bids (`paypal_authorization_id = null`, labelled "SIM (no hold)").
- SIM mandates with vault for the round agents (HF-046).

## Out of scope
- Live streaming / round agents / reset (HF-046).

## Acceptance criteria
- [ ] One command produces a lively console in < 5 min.
- [ ] Every simulated item is visibly labelled.
- [ ] Fallback count is logged and reported for the README.

## Test plan
- Run seed twice on a fresh DB; check counts and labels.

## Notes & risks
- `placed_at` is DB time; backdating for the simulated 48 h needs a seed-only override — keep it out of the API path.
- Spec question: backdated SIM bids may trip the 66 h hold-age guard or rank ties; real authorizations are fresh, so compute hold age from the PayPal authorization time, not `placed_at`.
- Data inconsistency to watch: README/HOLDFAST.md demo uses Sony; HOLDFAST-SPEC §3 uses "Aurel Audio / Aurel A7". Spec question: which brand appears in the video?
