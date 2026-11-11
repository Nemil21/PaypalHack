# HF-013: Create listing wizard (W05)

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-012, HF-007
- **Spec refs:** features/02-listing-creation.md §Logic 1–6; screens.md §W05

## Goal
The 4-step wizard that turns a Channel3 search into a published listing.

## Scope
- Step 1 Product: search box → result cards (image, title, GTIN, MPN, public low, offer count); "Not your brand" disabled state; states search-empty / no results / Channel3 unavailable (manual GTIN entry).
- Step 2 Quantity & price: quantity, floor, liquidation quote; helper "Cheapest public price $279. Floor is private; shoppers never see it."; block floor ≥ public low ("No one will bid above a cheaper store").
- Step 3 Window: start now / set time; 24/48 h segmented control; note "Card holds are guaranteed for 3 days".
- Step 4 Review: summary + estimate "If 60% of quantity clears at the floor: $X vs $Y liquidation"; Save draft / Publish.
- On publish → redirect W06 with toast "Window open: share your offer link".

## Out of scope
- W10 embed & share page (HF-055, P1); the toast links to the plain `/o/:slug` copy-link.

## Acceptance criteria
- [ ] Wrong-brand products cannot be selected.
- [ ] Window > 48 h cannot be chosen in the UI.
- [ ] Manual Sony XM5 listing created end to end.

## Test plan
- Manual: create Sony XM5 listing end to end.
- Unit: client validation mirrors server rules.

## Notes & risks
- Floor is brand-only; never render it on shopper routes.
