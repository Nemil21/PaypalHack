# HF-007: Web app scaffold, v3 tokens, AG Grid / AG Studio, same-origin SPA, demo hub

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 2
- **Estimate:** 2.5
- **Depends on:** HF-001
- **Spec refs:** README.md §Tech stack, §Designs; screens.md (shared states, money copy rule); features/08-brand-console.md §Acceptance criteria (licence, theme); review SUMMARY D14, D16, M26, M31

## Goal
A React app that brand and shopper screens can be dropped into, built on the Figma "Holdfast — v3" tokens, with AG Grid Enterprise, AG Charts and AG Studio licensed from day one, served from the same origin as the API.

## Scope
- `apps/web`: React + Vite + Tailwind; routes for brand (`/brand/*`), shopper (`/o/:slug`, `/bids/*`, `/agent`, `/mandates`, `/developer`) and admin. Start from `github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate` if it saves time.
- **Same origin only** (M31): Fastify serves the built SPA with client-side routing fallback; the Vite dev server proxies `/api` and `/mcp`. No static-site deployment.
- Design tokens from the Figma **"Holdfast — v3"** page variables (D16): Geist / Geist Mono uppercase labels, orange `#F26B2C` primary, charcoal secondary, square corners, thin guide lines; CSS variables + Tailwind theme. Build app screens from v3 components without waiting for per-screen frames.
- Base components: Button, Badge (incl. grey "SIM" chip), Toast host, Stat tile, Skeleton loader (no spinners on money numbers), inline error banner with retry, empty state.
- AG Grid Enterprise + AG Charts + **AG Studio** registered with `AG_GRID_LICENSE_KEY`; v3 theme.
- API client: one `Idempotency-Key` **per user action**, reused on retries of that action; a new key after a terminal failure or method change. SSE hook `useListingEvents(listingId)` typed by the shared `ListingEvent` union.
- Shared copy helpers (D14): "held" before capture, "charged" only after a successful capture, "released" for voids + "Your bank may show it as pending for a few days."; pay-your-bid phrases ("You won at your bid of $229. Charged $229." / "Each winner is charged their own bid (lowest $219, average $226)."). `AFFILIATE_DISCLOSURE` from HF-009.
- `/` demo hub (30 min): links to demo sign-in (HF-006), the offer page and `/developer`, plus "test accounts in README". The marketing landing page (HF-057) replaces it later.
- Mobile-first layout working at 375 px. `/dev/components` page.

## Out of scope
- Individual screens (later tickets). Landing page (HF-057).

## Acceptance criteria
- [ ] Built SPA served by the API on one origin with client-side routing; session cookie and SSE work from the SPA.
- [ ] An AG Grid demo grid, an AG Chart and an AG Studio dashboard render with the v3 theme and **no watermark**.
- [ ] Tokens match the v3 variables (spot-check 5 colours, spacing scale).
- [ ] Layout has no horizontal scroll at 375 px.
- [ ] `/` demo hub reachable without login.

## Test plan
- Manual: `/dev/components` page with every base component; licence check.

## Notes & risks
- Resolved (D16, Q#33): v3 is canonical; "SO v2" is stale.
- AG Grid licence must stay valid to Dec 21 (HOLDFAST.md §9). Confirm the key covers AG Charts Enterprise features or keep charts to Community features.
- If this runs long, split scaffold (routing, serving, API client) from tokens/components; the scaffold half unblocks the other UI tickets.
