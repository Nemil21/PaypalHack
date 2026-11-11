# HF-025: Bids grid (AG Grid Enterprise)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 3
- **Depends on:** HF-023, HF-024
- **Spec refs:** features/08-brand-console.md §Layout 5, §Acceptance criteria; features/17-demo-seeding.md §Labelling rules; screens.md §W06

## Goal
Every anonymized bid, live, sortable and filterable, with honest SIM labels — the main AG Grid sponsor showcase.

## Scope
- Columns: Rank (server rank; "below floor" instead of a number for bids under the floor, brand-only), Bid, Placed, Source (Offer page / Agent / MCP / SIM), Shopper label, Status (money copy rule: held, charged, released), Would win? (from the HF-024 slider store).
- Grid mechanics: `getRowId = bid.id`, `applyTransactionAsync`, `enableCellChangeFlash`; live insert/remove via SSE.
- Raises update the row in place via `bid.raised {replacesBidId, oldCents, newCents}` with a flash "$219 → $241" (no delete + insert).
- Grouping by source with a group-row aggregate of held $; set filter; side-bar tool panel; sticky header; virtualization.
- Grey "SIM" chip on simulated rows.
- Licensed (no watermark), custom theme matching v3 tokens.

## Out of scope
- Bid detail drawer (lives in HF-035).

## Acceptance criteria
- [ ] New bid row appears within 2 s with flash; voided bid is removed.
- [ ] A raise flashes the existing row from old to new amount.
- [ ] Every SIM row visibly labelled.
- [ ] No AG Grid watermark.

## Test plan
- Manual with `dev:bids` / `sim:stream`; visual snapshot.

## Notes & risks
- Shopper labels only ("Shopper #1042"); no emails.
- No-hold bids never reach this grid (D8), so the old "SIM (no hold)" chip is gone.
