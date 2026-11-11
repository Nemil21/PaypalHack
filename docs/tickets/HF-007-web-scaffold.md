# HF-007: Web app scaffold, design tokens, AG Grid licence, routing

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-001
- **Spec refs:** README.md §Tech stack, §Designs; screens.md (shared states, money copy rule); features/08-brand-console.md §Acceptance criteria (licence, theme)

## Goal
A React app that brand and shopper screens can be dropped into, with the Figma design tokens and AG Grid Enterprise licensed from day one.

## Scope
- `apps/web`: React + Vite + Tailwind; routes for brand (`/brand/*`), shopper (`/o/:slug`, `/bids/*`, `/agent`, `/mandates`, `/developer`) and admin.
- Design tokens from Figma "SO v2 — Design System" (colour, space, radius, type) as CSS variables + Tailwind theme.
- Base components used everywhere: Button, Badge (incl. grey "SIM" chip), Toast host, Stat tile, Skeleton loader (no spinners on money numbers), inline error banner with retry, empty state.
- AG Grid Enterprise + AG Charts registered with `AG_GRID_LICENSE_KEY`; custom theme.
- API client with `Idempotency-Key` helper; SSE hook `useListingEvents(listingId)`.
- Mobile-first layout working at 375 px.

## Out of scope
- Individual screens (later tickets). Landing page (HF-057, P1).

## Acceptance criteria
- [ ] App builds and is served by the API in production mode (or as a static site) with client-side routing.
- [ ] An AG Grid demo grid renders with no watermark.
- [ ] Tokens match the Figma variables (spot-check 5 colours, spacing scale).
- [ ] Layout has no horizontal scroll at 375 px.

## Test plan
- Manual: Storybook or a `/dev/components` page with every base component.

## Notes & risks
- Money copy rule (screens.md): "held" before capture, "charged" only after a successful capture, "released" for voids. Bake into shared copy helpers.
- AG Grid licence must stay valid to Dec 21 (HOLDFAST.md §9).
- HOLDFAST-SPEC §9 describes a newer "Holdfast — v3" design direction (Geist, orange #F26B2C) while docs/spec/README.md names "SO v2". Spec question: which Figma page is the source of truth for app screens?
