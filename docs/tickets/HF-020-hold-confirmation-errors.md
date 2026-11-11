# HF-020: Hold confirmation (W13 / M02) and error states (W21)

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-019, HF-015
- **Spec refs:** features/03-offer-page-held-bid.md §Logic 5, §Edge cases; features/06-price-watcher.md §Logic 6; screens.md §W13, §M02, §W21

## Goal
After a hold, the shopper sees exactly what's held and what happens next; every failure has a plain, honest screen.

## Scope
- W13/M02: "✓ $229 held, not charged"; what-happens-next timeline; opt-in cards "Let my agent manage this" (→ mandate setup, HF-017) and "Release my hold if it's cheaper elsewhere" (on by default; toggles `bids.release_if_cheaper` via a small `PATCH /api/bids/:id` or field on create).
- W21 variants: window closed; hold failed (retry with another method); payment declined at clearing; price dropped ("Best Buy is $219 now. We released your $229 hold." + affiliate link); above mandate; 404 listing; session expired.

## Out of scope
- Push/email delivery of these messages (HF-054, P1).

## Acceptance criteria
- [ ] Confirmation says "held, not charged" and shows the exact amount.
- [ ] Toggling "Release if cheaper" persists on the bid.
- [ ] Each W21 variant renders from its error code.

## Test plan
- E2E: part of the HF-019 Playwright flow.
- Manual: each W21 state via query-string fixture.

## Notes & risks
- Spec question: api.md has no endpoint for changing `release_if_cheaper` after placing the bid; proposed `PATCH /bids/:id {releaseIfCheaper}`.
