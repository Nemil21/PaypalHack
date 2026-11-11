# API Spec

Base URL: `https://<render-app>/api`. JSON in and out. Money is in **cents**.

**Auth:**
- **Brand users:** session cookie after Log in with PayPal. Before that ships (and on Render for judges), `DEMO_MODE` "Sign in as demo brand" (D13).
- **Shoppers:** session cookie. An anonymous shopper row is bound to a cookie on the first offer-page visit; sign-in by email magic link (console-logged locally) or PayPal login; `DEMO_MODE` "Sign in as demo shopper" (D13).
- **Admins:** emails in the `ADMIN_EMAILS` allowlist.
- **MCP clients:** `Authorization: Bearer <mcp token>`.
- **Webhooks:** provider signature.

**Errors:** `{ "error": { "code": "WINDOW_CLOSED", "message": "..." } }`

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `BRAND_NOT_VERIFIED` |
| 404 | `NOT_FOUND` |
| 409 | `WINDOW_CLOSED`, `STATE_CONFLICT` (with `reason`), `DUPLICATE`, `ALREADY_BID`, `IN_PROGRESS` |
| 422 | `MANDATE_EXCEEDED`, `BELOW_FLOOR`, `ABOVE_MANDATE_MAX`, `HOLD_FAILED`, `PRODUCT_MISMATCH` |
| 429 | `RATE_LIMITED` |
| 502 | `PAYPAL_ERROR`, `CHANNEL3_ERROR` |

Mutating calls require an `Idempotency-Key` header, scoped per principal with a request hash: same key + different body → 422; a request still in progress → 409; retryable failures are not stored, so the client mints a new key after a terminal failure. Exempt: `/webhooks/*`, `/mcp` (tool-level keys) and the OAuth callback.

## PayPal calls used (all sandbox, direct REST)

| Name | Call | Notes |
|---|---|---|
| `pp.token` | `POST /v1/oauth2/token` | Cache until `expires_in - 60s` |
| `pp.createAuthOrder` | `POST /v2/checkout/orders` `{intent:"AUTHORIZE", purchase_units:[{amount, custom_id: bidId, invoice_id: bidId}], payment_source}` | Header `PayPal-Request-Id: bidId`. With `payment_source.paypal.experience_context.return_url` for the wallet approval flow (read the `rel=payer-action` link), or `payment_source.card.attributes.vault.store_in_vault: ON_SUCCESS` with no card data for **card fields** (the browser submits the card, maybe 3DS, then we authorize; the card is vaulted on success), or `card.vault_id` + `stored_credential {MERCHANT, UNSCHEDULED, SUBSEQUENT}` for merchant-initiated holds (S2). A raw `payment_source.card` is used only by the seed and the labelled "Use sandbox test card" button (S1) |
| `pp.authorizeOrder` | `POST /v2/checkout/orders/{id}/authorize` | After wallet approval or card-fields submit. `PayPal-Request-Id: authz-<bidId>`; on `ORDER_ALREADY_AUTHORIZED`, GET the order |
| `pp.getAuthorization` | `GET /v2/payments/authorizations/{authId}` | RECONCILE path for any capture/void 422, and `reconcile:holds` |
| `pp.capture` | `POST /v2/payments/authorizations/{authId}/capture` `{amount, final_capture:true}` | `PayPal-Request-Id: settlementId` (S1, S3). Amount must equal the bid (INV-5) |
| `pp.void` | `POST /v2/payments/authorizations/{authId}/void` | `PayPal-Request-Id: void-<bidId>` on every path (D4) |
| `pp.payout` | `POST /v1/payments/payouts` `{sender_batch_header:{sender_batch_id: payoutAttemptId}, items:[{recipient_type:"EMAIL", receiver, amount}]}` | S4; ≈ $50k payout funded by captured winners' money checked in S7. Poll `GET /v1/payments/payouts/{batch_id}` and read the item status |
| `pp.track` | `POST /v2/checkout/orders/{id}/track` `{tracking_number, carrier, capture_id}` | `PayPal-Request-Id: track-<shipmentId>` |
| `pp.verifyWebhook` | `POST /v1/notifications/verify-webhook-signature` | |
| Test only | Header `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` | Demo decline; only when `DEMO_MODE` and `ALLOW_MOCK_DECLINE` are set |

Client results are `held | pending | denied | needs_approval`, judged by the response body `status` (only authorization `CREATED` is a hold), never the HTTP code. Errors are classed `TRANSIENT | TERMINAL | RECONCILE`. `PAYPAL_MODE=sandbox|stub` swaps in the `FakePayPal` stub for tests and dev seeds.

## Brand endpoints

### `GET /auth/paypal/start` → 302 to PayPal (Log in with PayPal)
### `GET /auth/paypal/callback?code=` → creates/loads brand_user; 302 to `/brand/onboarding` or `/brand`

### `POST /brands/verification`
```json
{ "name": "Aurel Audio", "domain": "aurelaudio.example", "payoutEmail": "sb-ktv5q…@business.example.com" }
```
→ `201 { "brandId": "…", "verificationStatus": "PENDING", "dnsTxtRecord": "holdfast-verify=8f2c…" }`

### `POST /brands/verification/check` → `{ "verificationStatus": "VERIFIED" }` (checks the DNS TXT record; demo: admin approve)

### `GET /products/search?q=aurel+a7` (Channel3 proxy; brand or shopper session, else 401; shared REST rate limit)
```json
{ "results": [ { "channel3Id": "r4bivjG", "variant": "Color=Green", "variantLabel": "Green", "title": "…", "brandName": "JBL",
  "gtin": null, "mpn": null, "imageUrl": "…", "bestPublicPriceCents": 13900, "offerCount": 3, "condition": "NEW",
  "brandMatch": true } ] }
```
`variant` is the `products.channel3_variant` key (`variants.selected` as `Name=Label;…`, null without variants). `gtin` / `mpn` come from `structured_attributes` and are usually null (none of the recorded fixtures have them): the wizard asks for them by hand. `bestPublicPriceCents` is the cheapest new, in-stock USD offer on any domain (display only). `brandMatch` is set for brand sessions ("Not your brand" when false), null for shoppers. `?limit=1..30`. Channel3 down → `502 CHANNEL3_ERROR { fallback: "MANUAL_IDENTIFIER" }`. Real shapes: `fixtures/channel3/` (HF-009).

### `POST /listings`
```json
{ "channel3Id": "c3_123", "variant": "Midnight", "quantity": 300, "floorCents": 19900, "liquidationQuoteCents": 3800,
  "windowHours": 48 }
```
→ `201 { "listingId": "…", "status": "DRAFT", "slug": "aurel-a7-a7f2" }`
`windowHours` is `24` or `48` only. Errors: `PRODUCT_MISMATCH` (product brand ≠ brand), `VALIDATION_ERROR` (windowHours not 24/48), `DUPLICATE` (a live listing already exists for this product).
HF-012a details: optional `gtin` / `mpn` (typed by hand; one is required unless Channel3 has it) and, for a manual listing without `channel3Id` (Channel3 down), `title` + a GTIN or MPN. `variant` is the key (`Color=Green`) or its label. The 201 also carries `productId`, `windowHours`, `bestPublicPriceCents` (null = unknown, floor check skipped) and `channel3Available`. Error details: `PRODUCT_MISMATCH { reason: BRAND_MISMATCH | NOT_NEW | VARIANT_MISMATCH | GTIN_MISMATCH | MPN_MISMATCH | NOT_FOUND }`; `VALIDATION_ERROR { field, reason: FLOOR_NOT_BELOW_PUBLIC_PRICE (+ bestPublicPriceCents) | NO_IDENTIFIER (+ fallback: MANUAL_IDENTIFIER when Channel3 is down) | INVALID_GTIN }`; `DUPLICATE { existingListingId, existingSlug, link }`. OWNER/MANAGER only.

### `POST /listings/:id/publish` → `{ "status": "OPEN", "windowClosesAt": "…", "clearDeadlineAt": "…" }`. Sets every D6 deadline. Reuses the product's Channel3 subscription or creates one (outside the DB transaction).
HF-012a: the body also has `listingId`, `slug`, `offerPath` (`/o/:slug`), `windowOpensAt` and `priceWatch` (false when Channel3 was down at publish; the subscribe is retried every 5 min). Errors: `403 BRAND_NOT_VERIFIED`, `409 DUPLICATE { existingListingId, link }`, `409 STATE_CONFLICT { reason: NOT_DRAFT }`, `404` for another brand's listing.

### `GET /listings[?status=OPEN,ROUNDS]` → `{ "listings": [ … ] }` (HF-012a): the session brand's listings, newest first, with product, deadlines, `offerPath` and `priceWatch`.

### `PATCH /listings/:id` `{ "quantity": 320 }` (later wave) → raise quantity only, while OPEN. Floor and window are locked (02).
HF-012b: OWNER/MANAGER, Idempotency-Key → `200 { listingId, status: "OPEN", previousQuantity, quantity }`; audit `LISTING_QUANTITY_RAISED`; SSE `listing.updated`. Errors: `400 VALIDATION_ERROR { field: "quantity", reason: QUANTITY_NOT_INCREASED, currentQuantity }` (equal or lower), `400 VALIDATION_ERROR` for any other field (floor, window), `409 STATE_CONFLICT { reason: NOT_OPEN, status }`, `404` for another brand's listing.

### `GET /listings/:id/book` (brand only)
```json
{ "listing": { "id": "…", "status": "OPEN", "phase": "OPEN", "quantity": 300, "floorCents": 19900, "windowClosesAt": "…",
               "roundsEndAt": null, "clearDeadlineAt": "…", "oldestHoldAuthorizedAt": "…" },
  "bookVersion": 1842,
  "stats": { "liveBids": 286, "heldCents": 6120000, "bestPublicPriceCents": 27900 },
  "curve": [ { "priceCents": 22900, "bidsAtOrAbove": 120, "heldAtOrAboveCents": 2748000 } ],
  "bids": [ { "id": "…", "amountCents": 22900, "placedAt": "…", "source": "MCP", "isSimulated": false,
              "shopperLabel": "Shopper #1042", "rank": 17, "status": "HELD" } ] }
```
`bids` is exactly the Clear input (D8 eligibility: HELD with an authorization); `shopperLabel` is opaque.

### `GET /listings/:id/simulate?quantity=240` → `{ "cutoffCents": 21900, "winners": 240, "grossCents": 5424000, "feeCents": 488160, "netCents": 4935840, "liquidationCents": 912000 }` (pay-your-bid: gross = sum of winners' own bids)

### `POST /listings/:id/rounds/start` `{ "targetQuantity": 240 }` → `{ "status": "ROUNDS", "roundsEndAt": "…", "windowClosesAt": "…", "clearDeadlineAt": "…" }` · `POST /listings/:id/rounds/stop` (sets `rounds_end_at = now()`) · `POST /listings/:id/rounds/next` (basic mode: advance one round) · `PATCH /listings/:id/rounds` `{ "targetQuantity" }` (see 19). OWNER/MANAGER only; rounds start once.

### `GET /listings/:id/rounds/activity` (HF-037b) → the W06 raises feed. Brand users, any role; another brand's listing or a bad id → `404`.
`{ listingId, status, currentRound, targetQuantity, expectedGrossCents, rounds: [{ round, startedAt, nudged, raised, grossAtStartCents, grossDeltaCents }], raises: [{ bidId, replacesBidId, oldCents, newCents, shopperLabel, source, isSimulated, at, round }] (newest first, ≤ 200), extensions: [{ round, at, bidId, roundEndsAt, extendedByMs }], ended: { round, reason, at } | null }`. Raises use the `bid.raised` fields; labels are the book's. Gross is `clear(bids, targetQuantity, floor).grossCents` (gross at a round's start comes from its `ROUND_SNAPSHOT` audit). Clients re-read it on every `bid.raised` / `round.*` notice.

### `GET /listings/:id/events` (SSE): `bid.held`, `bid.voided`, `bid.raised`, `settlement.updated`, `listing.status`, `round.started`, `round.nudged`, `round.extended`, `round.ended`, `payout.updated`, `pricewatch.released`, `listing.updated` (HF-012b: `{ previousQuantity, quantity }`)

### `POST /listings/:id/clear` (brand OWNER/MANAGER)
```json
{ "quantity": 240, "expectedGrossCents": 5424000 }
```
→ `202 { "status": "CLEARING", "cutoffCents": 21900, "grossCents": 5424000, "winners": 240, "losers": 46, "settlementRunId": "…" }`
`1 ≤ quantity ≤ listing.quantity`. Errors (409 `STATE_CONFLICT` carries `reason` and the new numbers, so the console can offer one-click "Confirm $X"):
- `reason: NOT_CLEARABLE`: listing not OPEN/ROUNDS;
- `reason: BOOK_CHANGED`: expected gross differs → `{ "cutoffCents", "grossCents", "winners" }` recomputed;
- `HOLDS_TOO_OLD`: a **winner's** hold is ≥ 66 h old (older non-winner holds are released instead of blocking Clear).

### `POST /listings/:id/cancel` (OWNER/MANAGER; from OPEN or ROUNDS) → `202 { "status": "CANCELLED" }`; bids go VOIDING and are voided asynchronously (concurrency ≤ 10); progress over SSE.
HF-012b: the 202 body is `{ listingId, status: "CANCELLED", from: "OPEN" | "ROUNDS", voiding, abandoned }` (HELD → VOIDING with `void_reason = CANCELLED`, PENDING_APPROVAL → ABANDONED; the audit rows carry `cause: LISTING_CANCELLED`). SSE: `listing.status`, then `bid.voided` per bid (once at VOIDING, once at VOIDED). A void PayPal keeps refusing stays VOIDING for the HF-034 sweeper. Errors: `409 STATE_CONFLICT { reason: NOT_CANCELLABLE, status }`, `404` for another brand's listing.
### `GET /listings/:id/settlement` → counts by status + rows (settlement-view payload from `packages/shared`), incl. promotion links via `unit_root_bid_id`, "Cleared $X · Captured $Y".
### `GET /brands/me/overview` → per-listing cards and totals for W04.
### `GET /brands/me/payouts`, `GET /brands/me/reports?from&to` (CSV via `Accept: text/csv`).
### `POST /listings/:id/shipments` `{ "bidId", "carrier", "trackingNumber" }` → calls `pp.track`.
### `POST /brand-agent/ask` `{ "listingId", "question" }` → `{ "answer", "recommendation": { "quantity", "cutoffCents", "grossCents", "reasons": [] } }`

## Shopper endpoints

### `GET /offers/:slug` (public)
```json
{ "listingId": "…", "brand": { "name": "Aurel Audio", "verified": true },
  "product": { "title": "Aurel A7 Wireless — Midnight", "imageUrl": "…", "bestPublicPriceCents": 27900 },
  "publicOffer": { "domain": "retailer.example", "priceCents": 27900, "url": "…" },
  "windowClosesAt": "…", "suggestedBidCents": 22900, "likelyBand": { "fromCents": 21000, "toCents": 22000 } , "status": "OPEN",
  "myBid": null }
```
Floor is never exposed. `likelyBand()` (shared, floor-blind): $10 buckets, bands with fewer than 3 bids merged, shown only if eligible ≥ quantity; changing the floor never changes the response (M22).

### `POST /bids` (Idempotency-Key)
```json
{ "listingId": "…", "amountCents": 22900, "paymentMethod": "PAYPAL" | "CARD" | "VAULT" | "TEST_CARD", "releaseIfCheaper": true, "intentId": null }
```
Logic:
- check `isBiddable` (OPEN and `now() < window_closes_at`) → else 409 `WINDOW_CLOSED`;
- one live bid per shopper per listing → else 409 `ALREADY_BID { bidId }` (raise or cancel instead; D3);
- set `mandate_id` and check the cap (D12), inserting the bid as PENDING_APPROVAL in the same transaction;
- call `pp.createAuthOrder`; holds land only through `landHold` (D1).

Responses:
- PAYPAL → `201 { "bidId", "status": "PENDING_APPROVAL", "approveUrl": "<rel=payer-action link>" }`
- CARD → `201 { "bidId", "status": "PENDING_APPROVAL", "orderId": "…" }`: the browser submits PayPal card fields (JS SDK v6, maybe 3DS) against `orderId`, then calls `POST /bids/:id/authorize`. - TEST_CARD (sandbox / `DEMO_MODE` only; the labelled "Use sandbox test card" button, built before card fields) → server-side S1-style hold → `201 { "bidId", "status": "HELD", "authorizationId" }`. Card fields remain the full path.
- VAULT → `201 { "bidId", "status": "HELD", "authorizationId": "…" }`
- Declined outright (no authorization created) → `422 HOLD_FAILED`, bid status `HOLD_FAILED` (terminal; a retry is a new bid row with a new Idempotency-Key). If an authorization exists but the `landHold` re-check fails, the new authorization is voided and the bid ends VOIDED with a `void_reason` (e.g. `WINDOW_CLOSED`). A retry with another method needs a new Idempotency-Key.
- Every response also carries `publicOffer { domain, priceCents, url }` (Channel3, refreshed asynchronously if older than 10 min). The server never rejects a bid for being above it; the shopper side decides (03, 06). Confirming the over-public-price warning sets `releaseIfCheaper=false`.

### `POST /bids/:id/authorize` (Idempotency-Key) → after card-fields submit or wallet approval: `pp.authorizeOrder` (`authz-<bidId>`), assert amount and `custom_id`, then `landHold`. If the listing is no longer biddable, don't authorize; return 409 `WINDOW_CLOSED`. → `200 { "bidId", "status": "HELD", "authorizationId" }`
### `GET /bids/return?token=…` (PayPal return URL) → same path as `POST /bids/:id/authorize` → 302 `/bids/:id?held=1`
  - Shared path (`authorizeAndLand`, HF-014b): already HELD → the same answer, no PayPal call (refresh, double click); window closed → no authorization, bid ABANDONED (`error_code WINDOW_CLOSED`), 409 `WINDOW_CLOSED` "This window has closed. Nothing was held."; not approved / card not submitted yet → 409 `IN_PROGRESS` `{reason: "NOT_APPROVED"}` (not stored, retry); declined → 422 `HOLD_FAILED`; authorization amount or `custom_id` ≠ bid → voided, 409 `STATE_CONFLICT {reason: "AMOUNT_MISMATCH"}`; PayPal unanswered → 502 `PAYPAL_ERROR` + `needs_reconcile`. CARD saves the returned card `vault.id` on the shopper.
  - `return_url` = `<APP_BASE_URL>/api/bids/return`, `cancel_url` = the same with `?cancelled=1` (PayPal appends `token`). No session needed: the order id names the bid. Failures redirect to `/bids/:id?error=<code>`; cancel → `/bids/:id?cancelled=1` and the bid stays PENDING_APPROVAL for the HF-034 order poll; unknown token → `/bids?error=NOT_FOUND`.
### `PATCH /bids/:id` `{ "releaseIfCheaper": false }` → change the price-watch setting on a live bid.
### `GET /bids/mine` → list with status, listing, amount, `belowCutoff` (only during ROUNDS), reserve-list flag. Clients poll every 5 s during ROUNDS (D18).
### `GET /bids/:id` → bid plus timeline (audit events for that bid, walking the `replaces_bid_id` chain) and money box.
### `POST /bids/:id/raise` `{ "amountCents": 23900 }` → `isRaisable` (D7); mandate check excludes the old hold; new bid PENDING_APPROVAL with `replaces_bid_id`, then `landHold` swaps atomically (old HELD→VOIDING `REPLACED`, new →HELD) and the old hold is voided. If the new hold is declined, the old bid stands (`422 HOLD_FAILED`). Vaulted shoppers raise in one call; wallet bids return an `approveUrl`. Minimum raise $1 or 1%; no cap on raises (05).
### `POST /bids/:id/cancel` → HELD→VOIDING → `pp.void` (`void-<bidId>`) → VOIDED; PENDING_APPROVAL → ABANDONED. "Already voided" counts as success.

### Mandates
- `POST /mandates` `{ "maxPriceCents": 23000, "totalHoldCapCents": 23000, "productIds": ["…"], "autoRoll": true, "expiresAt": "…" }`
- `PATCH /mandates/:id` (pause, change limits), `GET /mandates`

### `POST /agent/chat` (buyer agent)
```json
{ "conversationId": "…", "message": "Aurel A7-class headphones, I'd buy at $229" }
```
→ SSE stream of `{type:"text"|"tool_call"|"tool_result"|"confirm_required", …}`. The conversation must belong to the session's shopper. Money-moving tools (`place_bid`, `raise_bid`) return `confirm_required { actionId, tool, args }` unless a mandate covers them: the server stores the arguments in `agent_pending_actions`.

### `POST /agent/actions/:id/confirm` → executes the **stored** arguments (never re-asks the model) with `Idempotency-Key = action.id` → the tool result. Expired or another shopper's action → 404/409 (B10).

### `POST /notifications/subscribe` (web push subscription), `GET /notifications`, `POST /notifications/:id/read`

## MCP server (`/mcp`, Streamable HTTP)

Auth: Bearer token from W19 (scoped to one shopper; the token holder's own PayPal pays). Rate limit 30 calls/min/token.

| Tool | Input | Output | Backend |
|---|---|---|---|
| `get_book` | `{ listingSlug }` | `{ product, bestPublicPriceCents, windowClosesAt, demandBands:[{fromCents,toCents,bids}] }` (`publicBookBands` via floor-blind `likelyBand()`; anonymized, no floor, no shopper data) | `GET /listings/:id/book` summarized |
| `place_bid` | `{ listingSlug, amountCents, idempotencyKey }` | `{ bidId, status, amountCents, amountFormatted, offerUrl? }` | `POST /bids` with source=MCP; VAULT if mandate + saved method, else **our offer-page link** `/o/:slug?amount=…` (not a wallet approveUrl). Tool error `ALREADY_BID { bidId }` |
| `cancel_bid` | `{ bidId }` | `{ bidId, status:"VOIDED" }` | `POST /bids/:id/cancel` |
| `my_bids` | `{}` | `{ bids:[{ bidId, listingSlug, amountCents, status, belowCutoff, cutoffCents? }] }` (cutoff only during live rounds) | `GET /bids/mine` |
| `raise_bid` | `{ bidId, amountCents, idempotencyKey }` | `{ bidId, status }` | `POST /bids/:id/raise` |

Five tools ship; the four above `raise_bid` are built and recorded first (HF-044a), `raise_bid` follows (HF-044b). Amounts are integer **cents** and every result echoes `amountFormatted`. Transport: stateless `StreamableHTTPServerTransport`; bearer token only (cookies ignored).

Tool descriptions say plainly: "Places a real PayPal hold. If you win, you're charged exactly amountCents; otherwise it's released."

## Webhooks

### `POST /webhooks/channel3`: price change on a subscribed product
Channel3's model: offers carry no GTIN and no merchant name; an offer is `{url, domain, price{price, compare_at_price, currency}, availability, condition}` (`condition` is `new`, `used` or null), and a subscription is pinned to one product **variant `selection`** and up to 25 domains. Shape from Channel3's OpenAPI `OfferPriceChangedEvent` (HF-009; fixture `fixtures/channel3/webhooks/offer.price.changed.json`, schema-derived until HF-042b records a live delivery):
```json
{ "id": "evt_…", "timestamp": "2026-11-11T14:00:00Z", "type": "offer.price.changed",
  "data": { "subscription_id": "sub_…",
    "subject": { "product_id": "r4bivjG", "domain": "jcpenney.com", "selection": [ { "name": "Color", "label": "Green" } ],
                 "locale": { "language": "en", "country": "US", "currency": "USD" } },
    "previous": { "price": 139.0, "compare_at_price": null, "currency": "USD" },
    "current": { "price": 119.99, "compare_at_price": 139.0, "currency": "USD" } } }
```
The event carries **no condition or availability**: hydrate them from the free detail endpoint (the offer on the same domain) before the gate (`observePriceChangedEvent(event, detail)` in `channel3/match.ts`); without them the event is ignored as `CONDITION_UNKNOWN`.
Logic:
1. Verify the HMAC signature (`CHANNEL3_WEBHOOK_SECRET`, constant-time).
2. Insert into `webhook_events`; skip only if already processed. Return 2xx within 15 s; process async (unprocessed rows are retried every minute).
3. Exact-match gate, per offer: Channel3 product id + variant equal to the listing's, `condition == "new"`, `domain` in `brands.authorized_domains`, `currency == "USD"`. Convert to cents once (`Math.round(price * 100)`).
4. Recompute `products.best_public_*` from the free detail endpoint (cheapest new, in-stock, allowlisted, USD offer), not `min(old, new)`.
5. Void each bid `HELD` with `release_if_cheaper` where `newPrice < amount_cents AND newPrice < public_price_at_placement`, on a listing OPEN/ROUNDS: conditional HELD→VOIDING, `pp.void` (`void-<bidId>`), `void_reason=PRICE_DROP`. Re-run the selection until it returns zero rows.
6. Notify the shopper in-app with the affiliate link and the disclosure.

`POST /admin/replay-price-event` replays a fixture (admin only, no signature) and stamps `replayed=true`.

### `POST /webhooks/paypal`
Verify with `pp.verifyWebhook`, then dedupe. Map events by authorization id; conditional updates only. A missed wallet return is caught by the sweeper GETting the order, not by a webhook.

| Event | Action |
|---|---|
| `PAYMENT.AUTHORIZATION.VOIDED` | Confirm VOIDED; an unexpected void of a HELD bid → VOIDED (`EXPIRED`) |
| `PAYMENT.CAPTURE.COMPLETED` | settlement SUCCEEDED, bid CAPTURED |
| `PAYMENT.CAPTURE.DENIED` / `DECLINED` | settlement FAILED → promote |
| `PAYMENT.PAYOUTSBATCH.SUCCESS` / `DENIED` | payout status |
| `CUSTOMER.DISPUTE.CREATED` | audit + flag on bid (P2) |

## Ops (admin only)
- `GET /admin/audit?brandId&entity&from&to`
- `POST /admin/brands/:id/verify`
- `POST /admin/listings/:id/retry-settlement` (refused once SETTLED)
- `POST /admin/replay-price-event` (demo, labelled)
- `GET /admin/health` (PayPal token ok, Channel3 ok, queue depth)
