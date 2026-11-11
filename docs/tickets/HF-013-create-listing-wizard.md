# HF-013: Create listing wizard (W05)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 3
- **Depends on:** HF-012a, HF-007; HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/02-listing-creation.md §Logic 1–6; screens.md §W05

## Goal
The 4-step wizard that turns a Channel3 search into a published listing. Until it lands, the demo seed (HF-045) creates listings through core services.

## Scope
- Step 1 Product: search box (on Enter or 400 ms debounce, min 3 chars; results cached server-side by HF-009) → result cards (image, title, GTIN, MPN, public low, offer count); "Not your brand" disabled state; states search-empty / no results / Channel3 unavailable (manual GTIN entry).
- Step 2 Quantity & price: quantity, floor, liquidation quote; helper "Cheapest public price $279. Floor is private; shoppers never see it."; block floor ≥ public low ("No one will bid above a cheaper store"); skip that check when the public price is unknown and show the "price watch off" note.
- Step 3 Window: start now; 24/48 h segmented control; note "Card holds are guaranteed for 3 days".
- Step 4 Review: summary + estimate chart "If 60% of quantity clears at the floor: $X vs $Y liquidation"; Save draft / Publish.
- One `Idempotency-Key` per wizard session on `POST /listings` (double-click safe).
- Unverified (PENDING) brand: Publish disabled with banner, Save draft enabled; `BRAND_NOT_VERIFIED` maps to the banner.
- On publish → redirect W06 with toast "Window open: share your offer link" (plain `/o/:slug` copy-link).

## Out of scope
- W10 embed & share page (HF-055, P1). Scheduled start (HF-012a is "start now" only).

## Acceptance criteria
- [ ] Wrong-brand products cannot be selected.
- [ ] Only 24 h or 48 h can be chosen.
- [ ] Manual Aurel A7 listing created end to end.
- [ ] Double-click on Publish creates one listing.

## Test plan
- Manual: create an Aurel A7 listing end to end.
- Unit: client validation mirrors server rules.

## Notes & risks
- Floor is brand-only; never render it on shopper routes.
- Resolved (D15): demo product is the fictional Aurel Audio / Aurel A7.
- Resolved (user override): §5 proposed P1 / "wizard lite"; the full 4-step wizard stays P0, sequenced after the money spine.
