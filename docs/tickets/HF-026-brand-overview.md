# HF-026: Brand overview dashboard (W04) + `GET /brands/me/overview`

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 3
- **Depends on:** HF-022, HF-007, HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/08-brand-console.md §Overview W04; screens.md §W04

## Goal
The brand's landing page after sign-in: every listing at a glance and the way into the console and wizard. Kept in scope by the user (the review proposed P1, M32); built after the money spine.

## Scope
- Fallback already shipped in HF-023 Part 1: `/brand` redirects to the newest console. This ticket replaces the redirect with W04.
- `GET /api/brands/me/overview` (`forBrand`): KPIs (Recovered this month = sum of real captures, Held demand now, Fees, Payout pending), per-listing cards (status, held $, `listingPhase`, deadline), held-$ sparkline from `bids.placed_at` bucketed per hour server-side, activity feed from a PII-free projection of the brand's audit events.
- Left nav (Overview, Listings, Payouts, Embed, Settings — Payouts/Embed/Settings link to HF-059b / HF-055 / HF-056 when they land, placeholders until then).
- Listing cards: image, status pill (`listingPhase`), held $, time left, sparkline; "New listing" CTA (HF-013); activity feed.
- States: empty ("No windows yet" + CTA), loading, live, unverified banner.

## Out of scope
- Payouts page (HF-059b, P1).

## Acceptance criteria
- [ ] Unverified brand sees the banner and can still create drafts.
- [ ] Clicking a card opens W06.
- [ ] Another brand's listings and audit events never appear (cross-tenant test in HF-047).
- [ ] Activity feed contains no shopper emails or PayPal payer ids.

## Test plan
- Integration: overview endpoint against seed data; tenancy test.
- Manual with seed data.

## Notes & risks
- Tenant-scoped queries only (`forBrand`).
- Resolved (user override of M32): stays P0, sequenced after the money spine.
