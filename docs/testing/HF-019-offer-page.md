# HF-019 offer page: manual test script

The ticket's test plan runs this script first, then the Playwright E2E
(`apps/web/e2e/offer-page.spec.ts`). Each step lists what to check. Part 1 (test card) works on
`main` today; the card-fields and wallet steps need HF-014b (`POST /bids` CARD / PAYPAL and
`POST /bids/:id/authorize`), and Raise / Cancel need HF-018 / HF-016.

## Setup

1. Postgres with the schema: `npm run migrate`.
2. A fixture listing: `npm run fixture:offer` → `/o/aurel-a7-fixture` (OPEN, 48 h, public price
   $279 at retailer.example, 12 fixture bids so the "likely to clear" band shows). Use
   `-- --slug x --bids 0` for a listing with no band.
3. `.env`: `DEMO_MODE=true`. `PAYPAL_MODE=sandbox` for real sandbox holds and card fields;
   `PAYPAL_MODE=stub` for the FakePayPal stub (no card fields: the Card option is disabled).
4. `npm run build -w @holdfast/web && npm run dev`, open `http://localhost:3000/o/aurel-a7-fixture`.

## Part 1: sandbox test card (CP2)

| # | Do | Expect |
|---|---|---|
| 1 | Open the page in a fresh browser profile | Product, "Verified brand", "Cheapest public price $279 at retailer.example", countdown ticking, price prefilled at **$229**, hint "Bids between $… and $… are most likely to clear." DevTools → Application: an `hf_shopper` cookie |
| 2 | View source / DevTools → Network → `GET /api/offers/aurel-a7-fixture` | No `floor` field anywhere in the response or the DOM (search the Elements panel for "198": the fixture floor is $198) |
| 3 | Press **Use sandbox test card** | Button reads "Placing your hold…", then `/bids/<id>?held=1` (HF-020's confirmation). Server log: one `POST /api/bids` 201 |
| 4 | Back to the offer page | "Your bid $229 · HELD · NOT CHARGED", Cancel bid, Bid lower; no bid form |
| 5 | Sandbox only: check the hold at developer.paypal.com → sandbox business account → Activity | A $229 authorization |

## Double click, over-public warning, decline

| # | Do | Expect |
|---|---|---|
| 6 | New profile. Double-click (or click 5× fast) **Use sandbox test card** | One bid: `SELECT count(*) FROM bids WHERE listing_id = …` grows by 1; the second click sends nothing (button disabled) |
| 7 | New profile. Type **289** and press Hold | Warning "Another store sells it for $279 today. Still bid $289?" and "We won't release this bid for a cheaper store." "Change my price" closes it; "Still bid $289" places the bid with `release_if_cheaper = false` |
| 8 | Stub: run the server with a decline queued (or sandbox with `ALLOW_MOCK_DECLINE`); press Hold | "PayPal couldn't hold $229. Try another payment method." Press the button again (or switch method): a **new** `Idempotency-Key` (Network tab) and the hold lands HELD |

## Part 2: card fields and wallet (needs HF-014b)

| # | Do | Expect |
|---|---|---|
| 9 | `PAYPAL_MODE=sandbox`. Choose **Card** | PayPal's hosted fields load (number, expiry, CVV, name). Enter 4111 1111 1111 1111, any future expiry, 123 |
| 10 | Press **Hold $229 with card** | Network: `POST /api/bids` (CARD) → 201 `orderId`; card data goes to `*.paypal.com` only (no card number in any request to our origin); `POST /api/bids/:id/authorize` → HELD; redirect to `/bids/:id?held=1`; `shoppers.paypal_vault_id` set |
| 11 | Card with a bad CVV / cancelled 3DS | "Your card couldn't be verified…"; Try again re-submits the same order; switching to PayPal cancels the pending card bid first |
| 12 | Choose **PayPal**, press **Hold $229 with PayPal** (wallet, manual) | Redirect to PayPal sandbox; log in with the US sandbox personal account; approve → `/api/bids/return` → `/bids/:id?held=1` HELD |

## States

| # | Do | Expect |
|---|---|---|
| 13 | `?amount=21500&src=agent` | Price prefilled at $215; the bid row has `utm_source = 'agent'` |
| 14 | `UPDATE listings SET window_closes_at = now() + interval '20 seconds'` and wait | Countdown reaches zero, the page reloads into "This window has closed." |
| 15 | `UPDATE listings SET status = 'ROUNDS', window_closes_at = now(), rounds_end_at = now() + interval '10 minutes'` | Without a bid: "Live rounds are on…"; with a bid: Raise only (HF-018) |
| 16 | `/o/does-not-exist` | 404 page |
| 17 | Demo email: type an email under the form, Sign in | "Bidding as you@…"; `/api/me` shows the email; reloading in another browser with the same email shows the same bids |
| 18 | DevTools → 375 px (iPhone SE) | No horizontal scroll; ± $5 stepper and numeric keypad; sticky "Hold $229 with PayPal" bar at the bottom; FAQ is an accordion |
