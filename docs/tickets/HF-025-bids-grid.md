# HF-025: Bids grid (AG Grid Enterprise)

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-023
- **Spec refs:** features/08-brand-console.md §Layout 5, §Acceptance criteria; features/17-demo-seeding.md §Labelling rules; screens.md §W06

## Goal
Every anonymized bid, live, sortable and filterable, with honest SIM labels — the main AG Grid sponsor showcase.

## Scope
- Columns: Rank (tie-break visible), Bid, Placed, Source (Offer page / Agent / MCP / SIM), Shopper label, Status, Would win? (current slider).
- Live row insert/remove via SSE with row flash; grouping by source; set filter; sticky header; virtualization.
- Grey "SIM" chip on simulated rows; "SIM (no hold)" variant for DB-only SIM bids.
- Licensed (no watermark), custom theme matching tokens.

## Out of scope
- Bid detail drawer (W08 drawer lives in HF-035).

## Acceptance criteria
- [ ] New bid row appears within 2 s with flash; voided bid is removed.
- [ ] Every SIM row visibly labelled.
- [ ] No AG Grid watermark.

## Test plan
- Manual with `sim:stream`; visual snapshot.

## Notes & risks
- Shopper labels only ("Shopper #1042"); no emails.
