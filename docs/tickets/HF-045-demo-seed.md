# HF-045: Demo seed script (`npm run seed:demo`): Aurel Audio, deterministic book, SIM round agents

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 3
- **Depends on:** HF-014a, HF-017a, HF-005 (seeds through core services; no HF-012a dependency)
- **Spec refs:** features/17-demo-seeding.md §Seed script, §Labelling rules, §Acceptance criteria; features/19-live-rounds.md §Test plan; HOLDFAST-SPEC.md §3, §13

## Goal
One command produces a lively, honestly labelled, deterministic market for the fictional brand Aurel Audio, with numbers the video script can quote.

## Scope
- Brand (D15): "Aurel Audio (demo)", VERIFIED, `authorized_domains` allowlist, `max_discount_bps = 2200` (so the brand agent's "240 at $219" recommendation reproduces, HF-051a), payout to the sandbox **business** receiver (different account from the merchant; printed in the output).
- Products: **Aurel A7** headphones (main listing) and a second Aurel product (e.g. Aurel A5 earbuds) as a small second listing with ≤ 10 SIM bids for the multi-listing glimpse. The demo product's own public anchor and price event use a labelled fixture; real Channel3 calls stay on screen elsewhere (wizard search, buyer agent comparisons).
- Listings via core services (insert brand, upsert product, create listing, `transition(DRAFT→OPEN)`, Channel3 subscribe outside the transaction): A7 300 units, floor $199, liquidation $38. Clock: `window_closes_at = now + 4h` by default (`--window-left` flag); `window_opens_at` backdated so the window reads 48 h; clock printed in the output.
- SIM book: 280 SIM shoppers (`is_simulated=true`) from a **deterministic bid table** (seeded RNG, fixed seed), mostly $189–$249, peak $215–$225. `placed_at` backdated (seed-only override, never on the API path); hold age uses `authorized_at` (D6).
  - SIM bids above the planned price-drop level get `release_if_cheaper=false` (B12) so the drop voids ≤ 3 bids.
  - Holds are real sandbox card holds via `placeBid` (concurrency 5), round-robin over 4–5 sandbox test cards; plain CARD for most, **vault only the ~20 round agents**.
  - Fallback to DB-only bids on rate limit is labelled `SIM · no hold`, excluded from Clear by the D8 eligibility predicate; the seed **aborts** if more than 10% fall back.
- SIM round agents (moved here from HF-046): ~20 vaulted SIM shoppers with ACTIVE mandates whose maxima let about half raise; HF-038b drives them.
- Printed expected numbers: current `simulate(240)`, post-price-drop `simulate(240)`, and post-rounds `simulate(240)` assuming the scripted raises. The video script uses these.
- Modes: `PAYPAL_MODE=stub` for dev seeds; real sandbox only for the recording seed.
- Reruns: keyed by `demo_run_id`; refuses if demo data exists unless `--reset` (which calls HF-046's reset).
- Labels: two chips, `SIM` (real sandbox hold) and `SIM · no hold`; KPI hover "incl. $X simulated".

## Out of scope
- `sim:stream`, `demo:decline`, `demo:reset` (HF-046). Price-drop replay (HF-042a).

## Acceptance criteria
- [ ] One command produces a lively console in < 5 min (sandbox) and < 30 s (stub).
- [ ] Every simulated item is visibly labelled; no Sony/Bose or other real brand appears in seeded data.
- [ ] Two runs with the same seed produce the same bid table and the same printed numbers.
- [ ] The fallback count is logged; above 10% the seed aborts.
- [ ] A 300-hold dry run on 4–5 test cards completes on Nov 11 morning; hold rate and any `RATE_LIMIT_REACHED` are logged (feeds HF-063).

## Test plan
- Run on the stub twice (determinism, rerun refusal); one sandbox dry run; check counts, labels and printed numbers.

## Notes & risks
- Resolved (D15, Q#34): fictional Aurel Audio / Aurel A7 in seed and video (video rules forbid third-party trademarks).
- Resolved (D6, Q#15): hold age is measured from `bids.authorized_at`; backdated `placed_at` is safe.
- Resolved (D8): no-hold bids never reach Clear.
- Resolved (D7): `window_closes_at = now + 4h` so beats 2–4 can still place bids; rounds start while OPEN.
