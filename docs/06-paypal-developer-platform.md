# 06 — PayPal Developer Platform (Core Integration Context)

Sources: Devpost Resources page; https://github.com/paypaldev/getting-started-with-paypal-sandbox; https://developer.paypal.com/sdk/js/set-up; https://developer.paypal.com/llms.txt

## All core links from the Resources page

**Core PayPal integration**
- PayPal Developer docs — https://developer.paypal.com
- PayPal Payments — https://developer.paypal.com/payments/
- PayPal Checkout — https://developer.paypal.com/checkout/
- PayPal JavaScript SDK v6 — https://developer.paypal.com/sdk/js/
- PayPal REST API — https://developer.paypal.com/api/rest/
- PayPal Developer Dashboard — https://developer.paypal.com/dashboard/
- Getting Started with PayPal sandbox — https://github.com/paypaldev/getting-started-with-paypal-sandbox

**Useful payment capabilities**
- Low-Code/No-Code (Payment Links & Buttons) — https://developer.paypal.com/payment-links-buttons/overview
- Pay Later — https://developer.paypal.com/pay-later/overview (docs 09–10)
- Subscriptions — https://developer.paypal.com/platforms/subscriptions
- Invoicing — https://developer.paypal.com/invoicing/about
- Payouts — https://developer.paypal.com/docs/payouts/
- Disputes — https://developer.paypal.com/platforms/disputes/overview
- Donations — https://developer.paypal.com/sdk/donate/
- Webhooks — https://developer.paypal.com/api/webhooks/overview

**AI and agent development** (doc 07)
- PayPal AI Toolkit — https://github.com/paypal/AI-Toolkit
- PayPal AI docs — https://docs.paypal.ai/
- Agent Toolkit quickstart — https://docs.paypal.ai/developer/tools/ai/agent-toolkit-quickstart
- MCP server quickstart — https://docs.paypal.ai/developer/tools/ai/mcp-quickstart
- Agent tools reference — https://docs.paypal.ai/developer/tools/ai/agent-tools-ref

**Extra (from build session)**
- Postman collection — https://postman.com/paypal
- Example code — https://github.com/paypal-examples/docs-examples
- JS SDK v6 sample integration — https://github.com/paypal-examples/v6-web-sdk-sample-integration
- Next.js checkout guide — https://developer.paypal.com/guides/nextjs-checkout
- Low-code buy button guide — https://developer.paypal.com/guides/low-code-buy-button
- PayPal Server SDK (npm) — https://www.npmjs.com/package/@paypal/paypal-server-sdk
- VS Code PayPal extension — https://marketplace.visualstudio.com/items?itemName=PayPal.vscode-paypal
- LLM-friendly docs index — https://developer.paypal.com/llms.txt (append `.md` to most developer.paypal.com doc URLs for markdown)

## Sandbox — what it is and how to set it up

The sandbox is a self-contained test environment mirroring live PayPal (same API feature set). Fake accounts, fake money.

### Account types (you need one of each)
| Type | Role |
|---|---|
| Personal | Buyer |
| Business | Seller/merchant |

Logging into the Developer Dashboard auto-creates one default Business (with API creds) and one default Personal account (emails like `sb-xxxx@business.example.com` / `sb-xxxx@personal.example.com`; defaults can't be deleted).

### The three URLs (don't mix them up)
| URL | Use | Login |
|---|---|---|
| `developer.paypal.com` | Manage sandbox accounts, apps, API creds | **Your real PayPal login** |
| `www.sandbox.paypal.com` | Approve/review test payments | **Generated sandbox account** |
| `https://api-m.sandbox.paypal.com` | API base for your code | Access token (from Client ID + Secret) |

Live equivalents: `paypal.com`, `api-m.paypal.com`. Dashboard has a Sandbox/Live toggle.

### Steps
1. Log in to https://developer.paypal.com/dashboard/ → switch to **Sandbox**.
2. **Testing Tools → Sandbox Accounts** to see buyer/seller accounts. **Create Account** for more (choose type + country; "Create Custom Account" for custom balance/cards).
3. `(...) → View/Edit Account` to see generated email/password, top up balance, change currency.
4. **Apps & Credentials → Sandbox tab** (https://developer.paypal.com/dashboard/applications/sandbox) → use Default Application or **Create App** → copy **Client ID** and **Secret**.
5. (If calling REST directly) get an access token:
   ```bash
   curl -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
     -u "CLIENT_ID:CLIENT_SECRET" \
     -d "grant_type=client_credentials"
   ```
   The PayPal Server SDK handles OAuth and refresh for you.
6. **First test transaction loop:** create an order → approve on sandbox as Personal buyer → confirm it landed in the Business seller's activity. That's your end-to-end proof (great for the demo video).

> Keep the **Client Secret server-side only**. Separate env files for sandbox vs live.

### Test cards & negative testing
- Sandbox test cards: https://developer.paypal.com/sandbox-testing/card-testing#test-card-numbers (any future expiry; CVV 4 digits Amex, 3 others).
- Force errors with the `PayPal-Mock-Response` header (sandbox only):
  ```bash
  curl -X POST https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER_ID/capture \
    -H "Authorization: Bearer ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -H 'PayPal-Mock-Response: {"mock_application_codes": "INSTRUMENT_DECLINED"}'
  ```
  `INSTRUMENT_DECLINED` → card declined; `DUPLICATE_INVOICE_ID` → idempotency test. More: https://developer.paypal.com/negative-testing/overview

## JavaScript SDK v6 (frontend)

Supports: PayPal & Pay Later, Venmo (US), Google Pay, Apple Pay, Fastlane guest checkout, card fields. Faster/more secure than v5; standalone buttons and iframe integrations.

```html
<!-- sandbox -->
<script src="https://www.sandbox.paypal.com/web-sdk/v6/core"></script>
<!-- live -->
<script src="https://www.paypal.com/web-sdk/v6/core"></script>
```

### Auth
- **Option A — clientId (recommended for almost everything):** public, safe in frontend.
  ```js
  const sdkInstance = await window.paypal.createInstance({
    clientId: "YOUR_CLIENT_ID",
    components: ["paypal-payments"],
  });
  ```
- **Option B — clientToken (required only for Fastlane):** generate server-side:
  ```bash
  curl -X POST 'https://api-m.sandbox.paypal.com/v1/oauth2/token' \
   -u 'PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET' \
   -H 'Content-Type: application/x-www-form-urlencoded' \
   -d 'grant_type=client_credentials' \
   -d 'domains[]=YOUR_URL1,YOUR_URL2' \
   -d 'response_type=client_token'
  ```
  Client token expires after ~15 min in the SDK context.
- Can't use clientId and clientToken together.

### `window.paypal.createInstance(options)`
| Param | Notes |
|---|---|
| `clientId` / `clientToken` | One of them |
| `components` | `paypal-payments` (PayPal + Pay Later checkout, default), `venmo-payments`, `googlepay-payments`, `applepay-payments`, `fastlane`, `paypal-messages` |
| `pageType` | `checkout`, `product-details`, `cart`, `mini-cart`, `home` |
| `locale` | BCP-47, e.g. `en-US` (auto-detected if omitted) |
| `clientMetadataId` | e.g. `crypto.randomUUID()` for log correlation |
| `partnerAttributionId` | BN code (partners) |

Returns an instance with `findEligibleMethods()`, `createPayPalOneTimePaymentSession()`, `createFastlane()`.

Web components: `<paypal-button>`, `<paypal-pay-later-button>`, `<paypal-credit-button>`. **Always check eligibility before showing buttons.**

Typical flow: frontend button → your server creates an Order (Orders v2 API) → buyer approves in PayPal popup → your server captures the order → webhook confirms.

Migrations: v5→v6 https://developer.paypal.com/v5-v6 · v4→v6 https://developer.paypal.com/v4-v6

## Docs map (from developer.paypal.com/llms.txt)
- Get Started (5 pages) · Payments (277: checkout, cards, wallets, payment links, fraud) · **Revenue (118: invoicing, reports, disputes, subscriptions, payouts, agentic commerce)** · Developer Resources (311: tools, sandbox testing, reference) · Platforms (onboarding, multi-party) · Braintree GraphQL reference.
- Each section has its own `llms.txt`, e.g. https://developer.paypal.com/revenue/llms.txt
