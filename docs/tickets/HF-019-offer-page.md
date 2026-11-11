# HF-019: Shopper offer page (W12 / M01) and `GET /offers/:slug`

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 4
- **Depends on:** HF-014, HF-012, HF-007
- **Spec refs:** features/03-offer-page-held-bid.md §Logic 1–4, §Acceptance criteria; api.md §`GET /offers/:slug`; screens.md §W12, §M01

## Goal
The main shopper entry: see the product and public anchor, name a price, and hold it with PayPal or a card.

## Scope
- `GET /api/offers/:slug` (public): listing id, brand name + verified, product title/image/best public price, `windowClosesAt`, `suggestedBidCents` (≈18% below public), status, coarse "likely to clear" band. **Floor never exposed.**
- W12/M01: product hero, verified badge, "Cheapest public price $279 at 14 stores" anchor, countdown, price input + slider (M01: ± $5 stepper + keypad), payment choice (PayPal default / card via PayPal JS SDK v6 card fields), primary "Hold $229 with PayPal", how-it-works 3 steps, FAQ, sticky bottom bar on mobile.
- Idempotency-Key = uuid created on page load.
- Above-public-price warning on the client: "Best Buy sells it for $219 today. Still bid $239?" (server stays neutral).
- "Already bid" state: shows your bid + Raise / Cancel (calls HF-018 / HF-016).
- Shopper magic-link sign-in prompt when needed (HF-006).

## Out of scope
- Confirmation and error screens (HF-020). Embed mode `?embed=1` (HF-055, P1).

## Acceptance criteria
- [ ] A shopper can place a real sandbox card hold and a real wallet hold from this page.
- [ ] The floor never appears in the API response or the DOM.
- [ ] Works at 375 px wide.
- [ ] Double click → one bid.

## Test plan
- E2E (Playwright): offer page → card hold → confirmation.
- Manual: wallet hold.

## Notes & risks
- "Likely to clear" band must be coarse and must not leak the floor (03 §Logic 2).
- Card fields must post card data to PayPal, not to our API.
