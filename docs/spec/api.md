# API Spec

Base URL: `https://<render-app>/api`. JSON in and out. Money is in **cents**.

**Auth:**
- **Brand users:** session cookie after Log in with PayPal.
- **Shoppers:** session cookie (email magic link or PayPal login).
- **MCP clients:** `Authorization: Bearer <mcp token>`.
- **Webhooks:** provider signature.

**Errors:** `{ "error": { "code": "WINDOW_CLOSED", "message": "..." } }`

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `BRAND_NOT_VERIFIED` |
| 404 | `NOT_FOUND` |
| 409 | `WINDOW_CLOSED`, `STATE_CONFLICT`, `DUPLICATE` |
| 422 | `MANDATE_EXCEEDED`, `BELOW_FLOOR`, `ABOVE_MANDATE_MAX`, `HOLD_FAILED`, `PRODUCT_MISMATCH` |
| 429 | `RATE_LIMITED` |
| 502 | `PAYPAL_ERROR`, `CHANNEL3_ERROR` |

Mutating calls require an `Idempotency-Key` header.

## PayPal calls used (all sandbox, direct REST)

| Name | Call | Notes |
|---|---|---|
| `pp.token` | `POST /v1/oauth2/token` | Cache until `expires_in - 60s` |
| `pp.createAuthOrder` | `POST /v2/checkout/orders` `{intent:"AUTHORIZE", purchase_units:[{amount, custom_id: bidId}], payment_source}` | Header `PayPal-Request-Id: bidId`. With `payment_source.paypal.experience_context.return_url` for the wallet approval flow, or `payment_source.card` (+ `attributes.vault.store_in_vault: ON_SUCCESS`) for the first card hold, or `card.vault_id` + `stored_credential {MERCHANT, UNSCHEDULED, SUBSEQUENT}` for merchant-initiated holds (S2) |
| `pp.authorizeOrder` | `POST /v2/checkout/orders/{id}/authorize` | After wallet approval |
| `pp.capture` | `POST /v2/payments/authorizations/{authId}/capture` `{amount, final_capture:true}` | `PayPal-Request-Id: settlementId` (S1, S3) |
| `pp.void` | `POST /v2/payments/authorizations/{authId}/void` | `PayPal-Request-Id: settlementId` |
| `pp.payout` | `POST /v1/payments/payouts` `{sender_batch_header:{sender_batch_id: payoutId}, items:[{recipient_type:"EMAIL", receiver, amount}]}` | S4 |
| `pp.track` | `POST /v2/checkout/orders/{id}/track` `{tracking_number, carrier, capture_id}` | |
| `pp.verifyWebhook` | `POST /v1/notifications/verify-webhook-signature` | |
| Test only | Header `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` | Demo decline |

## Brand endpoints

### `GET /auth/paypal/start` → 302 to PayPal (Log in with PayPal)
### `GET /auth/paypal/callback?code=` → creates/loads brand_user; 302 to `/brand/onboarding` or `/brand`

### `POST /brands/verification`
```json
{ "name": "Sony Audio US", "domain": "sony.example", "payoutEmail": "sb-ktv5q…@business.example.com" }
```
→ `201 { "brandId": "…", "verificationStatus": "PENDING", "dnsTxtRecord": "holdfast-verify=8f2c…" }`

### `POST /brands/verification/check` → `{ "verificationStatus": "VERIFIED" }` (checks the DNS TXT record; demo: admin approve)

### `GET /products/search?q=sony+xm5` (Channel3 proxy)
```json
{ "results": [ { "channel3Id": "c3_123", "title": "Sony WH-1000XM5", "gtin": "0027242923782", "mpn": "WH1000XM5/B",
  "imageUrl": "…", "bestPublicPriceCents": 27900, "offerCount": 14, "condition": "NEW" } ] }
```

### `POST /listings`
```json
{ "channel3Id": "c3_123", "quantity": 300, "floorCents": 19900, "liquidationQuoteCents": 3800,
  "windowHours": 72 }
```
→ `201 { "listingId": "…", "status": "DRAFT", "slug": "sony-xm5-a7f2" }`
Errors: `PRODUCT_MISMATCH` (product brand ≠ brand), `VALIDATION_ERROR` (windowHours > 48).

### `POST /listings/:id/publish` → `{ "status": "OPEN", "windowClosesAt": "…" }`. Also subscribes to Channel3 price webhooks.

### `GET /listings/:id/book` (brand only)
```json
{ "listing": { "id": "…", "status": "OPEN", "quantity": 300, "floorCents": 19900, "windowClosesAt": "…" },
  "stats": { "liveBids": 286, "heldCents": 6120000, "bestPublicPriceCents": 27900 },
  "curve": [ { "priceCents": 22900, "bidsAtOrAbove": 120, "heldAtOrAboveCents": 2748000 } ],
  "bids": [ { "id": "…", "amountCents": 22900, "placedAt": "…", "source": "MCP", "isSimulated": false,
              "shopperLabel": "Shopper #1042", "status": "HELD" } ] }
```

### `GET /listings/:id/simulate?quantity=240` → `{ "cutoffCents": 21900, "winners": 240, "grossCents": 5424000, "feeCents": 488160, "netCents": 4935840, "liquidationCents": 912000 }` (pay-your-bid: gross = sum of winners' own bids)

### `POST /listings/:id/rounds/start` `{ "targetQuantity": 240 }` → `{ "status": "ROUNDS", "roundsEndAt": "…" }` · `POST /listings/:id/rounds/stop` (see 19)

### `GET /listings/:id/events` (SSE): `bid.held`, `bid.voided`, `settlement.updated`, `listing.status`

### `POST /listings/:id/clear` (brand OWNER/MANAGER)
```json
{ "quantity": 240, "expectedGrossCents": 5424000 }
```
→ `202 { "status": "CLEARING", "cutoffCents": 21900, "grossCents": 5424000, "winners": 240, "losers": 46, "workflowRunId": "…" }`
Errors: `STATE_CONFLICT` (not OPEN/ROUNDS), `STATE_CONFLICT` (book changed: expected gross differs → client re-simulates), `HOLDS_TOO_OLD` (oldest live hold > 66 h).

### `POST /listings/:id/cancel` → voids all live bids.
### `GET /listings/:id/settlement` → counts by status + rows.
### `GET /brands/me/payouts`, `GET /brands/me/reports?from&to` (CSV via `Accept: text/csv`).
### `POST /listings/:id/shipments` `{ "bidId", "carrier", "trackingNumber" }` → calls `pp.track`.
### `POST /brand-agent/ask` `{ "listingId", "question" }` → `{ "answer", "recommendation": { "quantity", "cutoffCents", "grossCents", "reasons": [] } }`

## Shopper endpoints

### `GET /offers/:slug` (public)
```json
{ "listingId": "…", "brand": { "name": "Sony Audio US", "verified": true },
  "product": { "title": "Sony WH-1000XM5", "imageUrl": "…", "bestPublicPriceCents": 27900 },
  "windowClosesAt": "…", "suggestedBidCents": 22900, "status": "OPEN" }
```
Floor is never exposed.

### `POST /bids` (Idempotency-Key)
```json
{ "listingId": "…", "amountCents": 22900, "paymentMethod": "PAYPAL" | "CARD" | "VAULT", "intentId": null }
```
Logic:
- check the listing is OPEN;
- check the mandate (if any);
- insert the bid as PENDING_APPROVAL;
- call `pp.createAuthOrder`.

Responses:
- PAYPAL → `201 { "bidId", "status": "PENDING_APPROVAL", "approveUrl": "https://www.sandbox.paypal.com/checkoutnow?token=…" }`
- CARD/VAULT → `201 { "bidId", "status": "HELD", "authorizationId": "…" }`
- Every response also carries `publicOffer { merchant, priceCents, url }` (Channel3, refreshed if older than 10 min). The server never rejects a bid for being above it; the shopper side decides (03, 06).

### `GET /bids/return?token=…` (PayPal return URL) → `pp.authorizeOrder` → bid HELD → 302 `/bids/:id?held=1`
### `GET /bids/mine` → list with status, listing, amount, outbid signal.
### `GET /bids/:id` → bid plus timeline (audit events for that bid).
### `POST /bids/:id/raise` `{ "amountCents": 23900 }` → mandate check excludes the old hold; creates the new hold first, then voids old (`void_reason=REPLACED`). If the new hold is declined, the old bid stands (`422 HOLD_FAILED`). Minimum raise $1 or 1%; no cap on raises (05).
### `POST /bids/:id/cancel` → HELD→VOIDING → `pp.void` → VOIDED.

### Mandates
- `POST /mandates` `{ "maxPriceCents": 23000, "totalHoldCapCents": 23000, "productIds": ["…"], "autoRoll": true, "expiresAt": "…" }`
- `PATCH /mandates/:id` (pause, change limits), `GET /mandates`

### `POST /agent/chat` (buyer agent)
```json
{ "conversationId": "…", "message": "Sony XM5-class headphones, I'd buy at $229" }
```
→ SSE stream of `{type:"text"|"tool_call"|"tool_result"|"confirm_required", …}`. Money-moving tools return `confirm_required` until the shopper confirms or a mandate covers it.

### `POST /notifications/subscribe` (web push subscription), `GET /notifications`, `POST /notifications/:id/read`

## MCP server (`/mcp`, Streamable HTTP)

Auth: Bearer token from W19 (scoped to one shopper; the token holder's own PayPal pays). Rate limit 30 calls/min/token.

| Tool | Input | Output | Backend |
|---|---|---|---|
| `get_book` | `{ listingSlug }` | `{ product, bestPublicPriceCents, windowClosesAt, demandBands:[{fromCents,toCents,bids}] }` (anonymized, no floor, no shopper data) | `GET /listings/:id/book` summarized |
| `place_bid` | `{ listingSlug, amountCents, idempotencyKey }` | `{ bidId, status, approveUrl? }` | `POST /bids` with source=MCP; VAULT if mandate + saved method, else approveUrl |
| `cancel_bid` | `{ bidId }` | `{ bidId, status:"VOIDED" }` | `POST /bids/:id/cancel` |
| `my_bids` | `{}` | `{ bids:[{ bidId, listingSlug, amountCents, status, belowCutoff, cutoffCents? }] }` (cutoff only during live rounds) | `GET /bids/mine` |
| `raise_bid` | `{ bidId, amountCents, idempotencyKey }` | `{ bidId, status }` | `POST /bids/:id/raise` |

Tool descriptions say plainly: "Places a real PayPal hold. If you win, you're charged exactly amountCents; otherwise it's released."

## Webhooks

### `POST /webhooks/channel3`: `offer.price.changed`
```json
{ "id": "evt_…", "type": "offer.price.changed", "data": { "productId": "c3_123", "gtin": "0027242923782",
  "offer": { "merchant": "Best Buy", "priceCents": 21900, "condition": "NEW", "url": "…" } } }
```
Logic:
1. Verify the signature.
2. Dedupe on `id`.
3. Update `products.best_public_*`.
4. Run the exact-match check (GTIN equal, condition NEW, authorized merchant).
5. For each bid `HELD` with `release_if_cheaper` and `amount_cents > priceCents` on that product: HELD→VOIDING, `pp.void`, `void_reason=PRICE_DROP`.
6. Notify the shopper with the affiliate link.

Return 200 fast and do the work async.

### `POST /webhooks/paypal`
Verify with `pp.verifyWebhook`, then dedupe.

| Event | Action |
|---|---|
| `PAYMENT.AUTHORIZATION.CREATED` | Confirm bid HELD (backup to return URL) |
| `PAYMENT.AUTHORIZATION.VOIDED` | Confirm VOIDED |
| `PAYMENT.CAPTURE.COMPLETED` | settlement SUCCEEDED, bid CAPTURED |
| `PAYMENT.CAPTURE.DENIED` / `DECLINED` | settlement FAILED → promote |
| `PAYMENT.PAYOUTSBATCH.SUCCESS` / `DENIED` | payout status |
| `CUSTOMER.DISPUTE.CREATED` | audit + flag on bid (P2) |

## Ops (admin only)
- `GET /admin/audit?brandId&entity&from&to`
- `POST /admin/brands/:id/verify`
- `POST /admin/listings/:id/retry-settlement`
- `GET /admin/health` (PayPal token ok, Channel3 ok, queue depth)
