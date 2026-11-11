# HF-019: Shopper offer page (W12 / M01) and `GET /offers/:slug`

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 5
- **Estimate:** 4
- **Depends on:** HF-014a, HF-007, HF-063 (card-fields part also needs HF-014b; builds against fixture listings, integrates with HF-012a)
- **Spec refs:** features/03-offer-page-held-bid.md §Logic 1–4, §Acceptance criteria; api.md §`GET /offers/:slug`; screens.md §W12, §M01

## Goal
The main shopper entry: see the product and public anchor, name a price, and hold it with a card or PayPal.

## Scope
- `GET /api/offers/:slug` (public): listing id, brand name + verified, product title/image, `publicOffer {merchant, priceCents, url, updatedAt}`, `windowClosesAt`, `suggestedBidCents` (≈18% below public), status/phase, and the floor-blind `likelyBand()` from `core/` (M22: $10 buckets, bands with < 3 bids merged, shown only when eligible bids ≥ quantity; otherwise only the suggestion). **Floor never exposed.**
- Identity (D13): an anonymous shopper row bound to a cookie on the first visit; an email field creates or loads the shopper and issues the session at once in `DEMO_MODE` (instant demo sign-in); otherwise a console-logged magic link. No bid without a `shopper_id`.
- W12/M01: product hero, verified badge, "Cheapest public price $279 at 14 stores" anchor, countdown, price input + slider (M01: ± $5 stepper + keypad), primary "Hold $229", how-it-works 3 steps, FAQ, sticky bottom bar on mobile.
- Payment, in build order:
  1. **Part 1 (fallback, build first):** labelled "Use sandbox test card" button (HF-014b Part 1).
  2. **Part 2 (full):** JS SDK v6 card fields two-step (create → `cardFields.submit()` → `POST /bids/:id/authorize`) and the PayPal wallet button (redirect to `approveUrl`), both via HF-014b.
- Idempotency-Key: one uuid per attempt; a **new key after any terminal failure** (HOLD_FAILED, ABANDONED, 4xx other than ALREADY_BID) or change of payment method.
- Above-public-price warning before the hold, from `publicOffer`: "Another store sells it for $219 today. Still bid $239?" Confirming sets `releaseIfCheaper=false` with visible copy "We won't release this bid for a cheaper store."
- "Already bid" state (`409 ALREADY_BID` or existing bid): shows your bid + Raise / Cancel (HF-018 / HF-016); "Lower" = cancel and rebid, copy says time priority resets.
- `?amount=` deep link prefill (used by HF-039 for shoppers without a vault).

## Out of scope
- Confirmation and error screens (HF-020). Embed mode `?embed=1` (HF-055, P1).

## Acceptance criteria
- [ ] Part 1: a shopper places a real sandbox hold with the test-card button from the deployed offer page (CP2).
- [ ] Part 2: a real card-fields hold and a real wallet hold from this page.
- [ ] The floor never appears in the API response or the DOM; a test shows changing the floor never changes the `GET /offers` body.
- [ ] After a declined hold, retrying with another method succeeds (new key).
- [ ] Works at 375 px wide.
- [ ] Double click → one bid.

## Test plan
- Build order: manual test script first (fixtures + sandbox), then a Playwright E2E (offer page → test-card hold → confirmation; then card fields).
- Manual: wallet hold.

## Notes & risks
- Card fields must post card data to PayPal, never to our API.
- Resolved (D13, Q#28): anonymous shopper + DEMO_MODE instant sign-in; console magic link locally.
- Resolved (B8): CARD is two-step; test-card button first.
- Resolved (user override): §5 swapped Playwright for a manual script; both stay, manual first.
