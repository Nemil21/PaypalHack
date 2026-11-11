# HF-020: Hold confirmation (W13 / M02), error states (W21), my bids (W14 / M03) and bid timeline (W15 / M04)

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 3
- **Depends on:** HF-019, HF-016 (W13 "Let my agent manage this" links to HF-017b; nudge rows read HF-036a's `nudges`, testable against a fixture SQL file)
- **Spec refs:** features/03-offer-page-held-bid.md §Logic 5, §Edge cases; features/06-price-watcher.md §Logic 6, §Screens; features/15-audit-ops.md §Logic 3; screens.md §W13, §M02, §W14, §W15, §M03, §M04, §M06, §W21

Merges the former HF-020 (confirmation + errors) and HF-021 (my bids + timeline).

## Goal
After a hold the shopper sees exactly what's held and what happens next; every bid has a plain timeline; every failure has an honest screen. All P0 notifications are in-app here (D18).

## Scope
- **W13/M02:** "✓ $229 held, not charged"; what-happens-next timeline; opt-in cards "Let my agent manage this" (→ HF-017b) and "Release my hold if it's cheaper elsewhere" (default on). Toggling uses `PATCH /api/bids/:id {releaseIfCheaper}` (owner only, Idempotency-Key); toggling on compares at once with `products.best_public_price_cents` and voids with `PRICE_DROP` if the bid is above it.
- **W21:** four specific variants — window closed, hold failed (retry with another method), price dropped ("Another store is $219 now. We released your $229 hold." + affiliate link with disclosure), declined at clearing — plus one generic layout for above mandate / 404 listing / session expired. Each renders from its error code.
- **W14/M03:** tabs with status mapping — Live = PENDING_APPROVAL, HELD, WON awaiting capture; Won = CAPTURED, SHIPPED; Released = VOIDING, VOIDED, ABANDONED, CAPTURE_FAILED (with reason). Bid cards: product, your bid, status pill, time left, "below likely clearing" hint (ROUNDS only), source chip (e.g. "via Claude Desktop"). Cancel button with confirm. Polls `GET /bids/mine` every 5 s during ROUNDS.
- **W15/M04:** summary; vertical timeline over the `replaces_bid_id` chain (HF-016): Held → Price watch on since <time> (static row from `release_if_cheaper` + `products.price_updated_at`) → Below-cutoff nudge → Raised → Won / Released, with times and plain reasons. Money box per chain: each superseded hold "held $229 → released"; final bid "held $241 → charged $241" or "released". Sticky Raise / Cancel bar.
- Price-drop release as a timeline event + M06-style sheet (old vs new price, "Hold released", affiliate "Buy at <store> $219").
- **Copy (D14):** won = "You won at your bid of $229. Charged $229." Every release adds "Your bank may show it as pending for a few days." LOST on the reserve list until VOIDED: "Not won: on the reserve list. Your hold is released within minutes unless a unit opens up." Raise copy "New $241 hold placed · $229 hold released" only after the old bid is VOIDED ("releasing" before).
- **Last in scope:** mobile swipe-to-cancel (with confirm) and pull-to-refresh on M03.

## Out of scope
- Bell, email and push (HF-054a/b, P1). Tracking (HF-059b, P1). Won page W18 (HF-059a). Bryntum Gantt (HF-060, P1).

## Acceptance criteria
- [ ] Confirmation says "held, not charged" and shows the exact amount.
- [ ] Toggling "Release if cheaper" persists; toggling on above the public price voids the hold.
- [ ] Each W21 variant renders from its error code.
- [ ] Timeline shows held → (signals) → won/lost → captured/voided across a raise chain, with times.
- [ ] Money copy follows held / charged / released and D14 exactly; no "got it at $219" anywhere.
- [ ] Every status appears in exactly one tab.
- [ ] Works at 375 px; swipe-to-cancel and pull-to-refresh work on mobile.

## Test plan
- Manual against a fixture SQL file with bids in each state (and seeded bids once HF-045 lands); each W21 via query-string fixture.
- E2E: part of the HF-019 flow.

## Notes & risks
- Resolved (Other answers, Q#22): `releaseIfCheaper` on `POST /bids` plus `PATCH /bids/:id`.
- Resolved (D14, Q#2): pay-your-bid copy; HF-054a/b and HF-059a reuse it.
- Resolved (D18, Q#27): P0 notifications are in-app (timeline, W21, MCP `my_bids`, 5 s polling in ROUNDS).
- Resolved (user override): §5 moved swipe and pull-to-refresh to P1; they stay here, built last.
