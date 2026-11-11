# HF-026: Brand overview dashboard (W04)

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-022, HF-007
- **Spec refs:** features/08-brand-console.md §Overview W04; screens.md §W04

## Goal
The brand's landing page after sign-in: every listing at a glance and the way into the console and wizard.

## Scope
- Left nav (Overview, Listings, Payouts, Embed, Settings — Payouts/Embed/Settings may link to P1 screens or placeholders).
- KPI row: Recovered this month, Held demand now, Fees, Payout pending.
- Listing cards: image, status pill, held $, time left, sparkline; "New listing" CTA; activity feed from audit events.
- States: empty ("No windows yet" + CTA), loading, live, unverified banner.

## Out of scope
- Payouts page (HF-059, P1).

## Acceptance criteria
- [ ] Unverified brand sees the banner and can still create drafts.
- [ ] Clicking a card opens W06.

## Test plan
- Manual with seed data.

## Notes & risks
- Tenant-scoped queries only (`forBrand`).
