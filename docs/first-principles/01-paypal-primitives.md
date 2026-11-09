# 01 — PayPal Primitives: First-Principles Capability Map

Raw-materials inventory for the PayPal AI Hackathon (sandbox + AI, deadline Nov 12 2026). **No product ideas here.** Each entry lists what the primitive does, its creative levers, its limits, whether it works in sandbox, and a doc link.

- **Verification:** checked Nov 9–10 2026 against developer.paypal.com (`.md` API references and OpenAPI `schema.json`), paypal.com fee pages, the `paypal/agent-toolkit` source, and press coverage.
- **`UNVERIFIED`** means not confirmed in an official doc.
- **Sandbox legend:**
  - **Yes:** self-serve with a standard developer account.
  - **Gated:** needs account or feature enablement, or an access request.
  - **No:** not available in sandbox.
- **docs.paypal.ai:** it now redirects to `developer.paypal.com/docsai/...`, which returns 404. The AI docs live at `developer.paypal.com/ai-tools/*`.

---

## A. Payments (money in)

### A1. Orders v2: intent CAPTURE vs AUTHORIZE
- **Does:** creates a checkout order, then either captures funds at once or places an authorization hold.
- **Levers:**
  - **HOLD without charging for up to 29 days.** The first 3 days are the "honor period". After that you can **reauthorize multiple times** inside the 29 days, and each reauth gives a new auth ID and a fresh 3-day honor period. A reauth on day 27 gets only 2 days.
  - **Over-capture** up to 115% of the authorized amount, capped at +$75 in the US. Lets the final price come in above the quote.
  - **Partial and multiple captures** against one authorization. `final_capture: true` closes it.
  - **Void** releases the hold with zero cost to the buyer.
  - `processing_instruction: ORDER_COMPLETE_ON_PAYMENT_APPROVAL` auto-completes on approval, with no server capture call. Required for crypto and some APMs.
- **Limits:**
  - After 30 days you need a new authorization.
  - Partial capture of **PayPal-wallet** authorizations must be enabled on the merchant account.
  - Reauthorize accepts only `amount`.
  - An account with open authorizations can't be closed.
- **Sandbox:** Yes. Partial wallet capture may need enablement (`UNVERIFIED` in sandbox).
- **Docs:** https://developer.paypal.com/api/orders/v2 · https://developer.paypal.com/payment-methods/auth-honor · https://developer.paypal.com/api/payments/v2

### A2. Orders v2: multiple purchase_units, `payee`, IDs, PATCH, callbacks
- **Does:** one buyer approval can pay up to **10 purchase units**, each with its own `payee` (a different merchant email or ID).
- **Levers:**
  - **PAY-MANY-MERCHANTS in one approval:** a single checkout splits across up to 10 sellers.
  - `custom_id` holds 1–255 characters. It is hidden from the payer and appears in reports and webhooks, so it is a free metadata slot for your own state machine (127 on refunds).
  - `invoice_id` holds 1–127 characters. It is shown to the payer and **must be unique per merchant**, which gives you idempotency or dedupe for free (sandbox mock error `DUPLICATE_INVOICE_ID`).
  - `soft_descriptor` text appears on the card statement (truncated to 22 characters).
  - `items[]` can hold up to 32,767 entries.
  - **PATCH** works while an order is CREATED or APPROVED. It can change amount, items, payee email, shipping, `custom_id`, description and intent. **You can reprice after the buyer approves but before capture.**
  - **Shipping callbacks:** `callback_configuration.callback_url` plus `callback_events` (SHIPPING_ADDRESS, SHIPPING_OPTIONS). PayPal calls your server live, *during* buyer approval, to recompute totals. Callbacks are signed with certs from `/v2/checkout/callback/certs/{id}`.
  - `experience_context`:
    - `shipping_preference`: GET_FROM_FILE, NO_SHIPPING, or SET_PROVIDED_ADDRESS
    - `user_action`: CONTINUE or PAY_NOW
- **Limits:** platform fees allow at most 1 per unit. Multi-payee orders need payees who can receive payments.
- **Sandbox:** Yes.
- **Docs:** https://developer.paypal.com/api/orders/v2 (schema: `/api/orders/v2/schema.json`)

### A3. Orders v2: `payment_source` types
- **Does:** one Orders API covers every funding rail.
- **Keys in schema:** card, token, paypal, venmo, apple_pay, google_pay, bancontact, blik, eps, giropay, ideal, mybank, p24, sofort, trustly, **crypto**.
- **Separate guides:** Multibanco, Alipay, BANCOMAT Pay, Boleto, GrabPay, MB WAY, OXXO, Satispay, Pay Upon Invoice (DE).
- **Levers:**
  - The same order object works for wallets, cards, EU bank methods and crypto.
  - `POST /v2/payments/find-eligible-methods` asks PayPal which methods a buyer is eligible for, server side.
- **Limits:** APMs are country- and currency-specific. Venmo is US only.
- **Sandbox:** Yes for most. Crypto is gated (see E1).
- **Docs:** https://developer.paypal.com/api/orders/v2 · https://developer.paypal.com/api/payments/v2

### A4. Payment Method Tokens / Vault v3 (CHARGE-LATER)
- **Does:** saves a PayPal wallet, **Venmo** or card, with or without a purchase. Later charges then run **without the buyer present**.
- **How:**
  - **Without a purchase:** setup token, then buyer approval, then payment token.
  - **With a purchase:** `store_in_vault: ON_SUCCESS`.
- **Levers:**
  - **Merchant-initiated charges:** set `payment_source.<type>.vault_id` on a new order plus `stored_credential` (`payment_initiator: MERCHANT`). This charges a saved Venmo or PayPal account while the user is away.
  - `usage_pattern` declares the mandate shape (12 values): IMMEDIATE, DEFERRED, and each of RECURRING, THRESHOLD, SUBSCRIPTION, UNSCHEDULED, INSTALLMENT as `_PREPAID` or `_POSTPAID`. **THRESHOLD** means "charge when a balance crosses X" and **UNSCHEDULED** means "charge whenever needed". Both map naturally to metered or agent spending.
  - `usage_type` is MERCHANT or PLATFORM. A PLATFORM token can be used across a platform's sellers.
  - `permit_multiple_payment_tokens` allows several tokens per payer (e.g., one per agent or purpose).
  - A card can be saved with no buyer interaction. A PayPal wallet needs a one-time billing-agreement approval.
- **Limits:**
  - Turn on "Save payment methods" in the Dashboard app.
  - Cards need Expanded Checkout (SAQ D for direct card vaulting).
  - Available in US, CA, AU, JP, SG, HK, CN and 28 European countries.
  - Legacy Billing Agreements / Reference Transactions (NVP/v1) are `UNVERIFIED`. They are largely superseded by Vault v3 and may need approval.
- **Sandbox:** Yes. Docs say you can test in sandbox while live eligibility is pending.
- **Docs:** https://developer.paypal.com/api/payment-tokens/v3 · https://developer.paypal.com/api/save-with-purchase/save-payment-methods · https://developer.paypal.com/sdk/js/save-with-purchase/venmo

### A5. JS SDK v6 (front end)
- **Does:** browser payment UI. Load `https://www.sandbox.paypal.com/web-sdk/v6/core`, then `paypal.createInstance({clientId, components})`.
- **Components:** `paypal-payments`, `venmo-payments`, `card-fields`, `applepay-payments`, `googlepay-payments`, `paypal-messages`, `fastlane`.
- **Sessions:**
  - `createPayPalOneTimePaymentSession`, `createPayPalSavePaymentSession`
  - `createVenmoOneTimePaymentSession`
  - `createCardFieldsOneTimePaymentSession`, `createCardFieldsSavePaymentSession`
  - `createApplePay…`, `createGooglePay…`
  - `createFastlane`, `createPayPalMessages`, `createLearnMore`
- **Web components:** `<paypal-button>`, `<paypal-pay-later-button>`, `<paypal-credit-button>` (Credit availability is `UNVERIFIED`).
- **Levers:**
  - `findEligibleMethods()` lets the UI adapt to what this buyer can actually use.
  - **Save-payment sessions** turn a button click into a vaulted mandate (feeds A4).
  - **Fastlane** recognizes guest buyers via PayPal's network for one-click guest checkout. It needs a `clientToken`.
  - 3DS via `SCA_ALWAYS` / `SCA_WHEN_REQUIRED`, which returns `liabilityShift`.
- **Limits:**
  - Venmo supports only `presentationMode: "auto"`, US only, and needs the mobile app. The desktop QR flow is not testable in sandbox.
  - Other presentation modes for PayPal sessions are `UNVERIFIED`.
  - The Fastlane country list follows Expanded Checkout eligibility (US-only `UNVERIFIED`).
  - Client tokens last about 15 minutes.
- **Sandbox:** Yes, including Fastlane (needs a sandbox account) and Venmo with `buyer-country=US`.
- **Docs:** https://developer.paypal.com/sdk/js/set-up · https://developer.paypal.com/venmo · https://developer.paypal.com/fastlane/enable · https://developer.paypal.com/apple-pay/integrate · https://developer.paypal.com/google-pay/integrate

### A6. Pay Later (button + messaging)
- **Does:** BNPL. PayPal takes the credit risk, and the merchant is paid in full up front.
- **Products:**

  | Country | Product | Amount range |
  |---|---|---|
  | US | Pay in 4 | **$10–$2,000** (updated Oct 2026; the old $30–$1,500 is outdated) |
  | US | Pay Monthly (3/6/12/24 months) | $49–$10,000 |
  | CA | Pay in 4 | $10–$2,000 CAD |
  | AU | Pay in 4 | $1–$1,999.99 AUD |
  | FR | 4X | €20–€3,000 |
  | FR | 6/12/24X | €120–€2,900 |

  The UK, DE, IT and ES rows are not extracted.
- **Levers:**
  - **Merchant gets paid now; buyer pays over time.**
  - The `<paypal-message>` element live-updates with the amount.
  - The Learn More modal has an `onCalculate` hook.
- **Limits:**
  - The merchant must be domiciled in the country and use its local currency.
  - Pay Later costs 4.99% + fixed fee for the merchant.
  - Not eligible on reference-transaction or recurring integrations (CA text).
- **Sandbox:** Yes. Messaging renders in sandbox, and BNPL test buyers are covered in docs 09–10.
- **Docs:** https://developer.paypal.com/pay-later/overview · https://developer.paypal.com/pay-later/integrate

### A7. Refunds
- **Does:** `POST /v2/payments/captures/{id}/refund`. An empty body refunds in full; `amount` refunds partially, and multiple partial refunds are allowed.
- **Levers:**
  - **Partial refunds as a "rebate" or price-adjust channel** after the sale.
  - `note_to_payer` (255 characters) is a message channel to the buyer.
  - `custom_id` / `invoice_id` on the refund.
  - Platform-fee reversal via `payment_instruction`.
- **Limits:**
  - Refund within **180 days** of capture.
  - Sandbox refunds are instant; production takes 3–5 days.
  - You track the cumulative total yourself.
- **Sandbox:** Yes.
- **Docs:** https://developer.paypal.com/checkout/refund-payment

---

## B. Money out

### B1. Payouts v1 (PAY-MANY)
- **Does:** `POST /v1/payments/payouts` sends money to many recipients in one call. Track by batch or by item (`/v1/payments/payouts-item/{id}`).
- **Levers:**
  - **Up to 15,000 items per API call.** No cap on the batch total.
  - **Recipient needs only an email, phone, PayPal ID or Venmo handle.** No bank details, and no existing account: an unregistered recipient gets an invitation to claim.
  - `recipient_type`: EMAIL, PHONE, PAYPAL_ID, USER_HANDLE.
  - `recipient_wallet: VENMO` pays to a Venmo @handle or phone. **The `note` shows up in the recipient's Venmo social feed**, subject to their privacy settings. Non-users get an SMS to sign up.
  - **Unclaimed items** sit for 30 days and then auto-return. **Cancel** an UNCLAIMED item via `/payouts-item/{id}/cancel`, which acts as a revocable send.
  - `sender_batch_id` is an idempotency key.
  - 96–156+ countries and 23+ currencies. PayPal converts to the recipient's currency for a fee.
  - Assisted Account Creation (AAC) collects payer IDs.
  - Webhooks:
    - Item: `PAYMENT.PAYOUTS-ITEM.{SUCCEEDED, UNCLAIMED, RETURNED, BLOCKED, HELD, FAILED, CANCELED, REFUNDED}`
    - Batch: `PAYMENT.PAYOUTSBATCH.*`
- **Limits:**
  - $20,000 per item by default (raisable).
  - One currency per batch.
  - A completed payout to the wrong address can't be reversed.
  - The sender's balance must cover the amount plus fees.
  - Venmo payouts are US only.
  - Live Payouts must be activated by PayPal.
  - **Not in the Agent Toolkit or MCP**; call REST directly.
- **Fees:** paid by the sender; the recipient pays nothing.
  - US via API: **flat $0.25 per item**
  - Domestic (non-API): 2%, capped at $1
  - International: 2%, capped at $20
- **Sandbox:** Yes, with a sandbox merchant app and no approval documented. Simulation values are available for negative tests.
- **Docs:** https://developer.paypal.com/payouts/overview · https://developer.paypal.com/api/payouts · https://developer.paypal.com/payouts/use-payouts/venmo · https://developer.paypal.com/payouts/fees · https://developer.paypal.com/payouts/use-payouts/cancel-reverse-payouts

### B2. Invoicing v2 (INVOICE)
- **Does:** creates and sends a PayPal-hosted invoice. The buyer pays by PayPal, card, or Pay by Bank. No checkout integration is needed.
- **Levers:**
  - **Partial payments:** `allow_partial_payment` with `minimum_amount_due` lets an invoice be paid in installments chosen by the payer.
  - **Tips:** `allow_tip`.
  - **Conditional rules:** `/conditional-rules` with `EARLY_PAYMENT_DISCOUNT` (percent or amount, expiring on a date or relative period) or `AUTO_CANCEL`. This gives the invoice time-based logic. Confirmed in the agent-toolkit source.
  - **Recurring series:** `/v2/invoicing/recurring-invoices` (create, activate, cancel, search). It exists in the toolkit source, but the public guide doesn't document it: **`UNVERIFIED` officially**.
  - `send_to_recipient:false` creates a payable invoice without emailing it. You can then share the link or **QR code** (`generate-qr-code` returns a Base64 PNG; the invoice must be SENT).
  - **SCHEDULED** status sends on a future date.
  - Payment terms: `NET_10/14/30…` or `DUE_ON_DATE_SPECIFIED`.
  - **Up to 100 primary + 100 CC recipients.**
  - Attachments.
  - Templates CRUD.
  - Reminders: manual, up to 2 per day, and `setup-reminders` configurations.
  - **Record off-PayPal payments and refunds** (cash, check, wire) via `/payments` and `/refunds`. This makes PayPal a ledger even for non-PayPal money.
  - `payment_method_overrides` can enable **PAY_BY_BANK**, optionally `EXCLUSIVE_ABOVE_AMOUNT_THRESHOLD` (bank-only above a threshold).
  - Theme color.
  - Use a custom email sending domain.
  - Invoice-number generator.
  - Webhook `INVOICING.INVOICE.PAID` and others.
- **Limits:**
  - Invoice-specific fees are `UNVERIFIED`; commercial rates presumably apply.
  - Pay by Bank availability is `UNVERIFIED` (US).
- **Sandbox:** Yes.
- **Docs:** https://developer.paypal.com/invoicing/object · https://developer.paypal.com/invoicing/reference · https://developer.paypal.com/invoicing/lifecycle · https://developer.paypal.com/invoicing/templates

### B3. Subscriptions v1 (SUBSCRIBE)
- **Does:** Catalog Product, then Plan, then Subscription, with PayPal-run recurring billing.
- **Levers:**
  - `billing_cycles` take a `sequence` and are TRIAL or REGULAR. **Up to 2 trials** (free or discounted). Frequency is DAY/WEEK/MONTH/YEAR with `interval_count`, and `total_cycles: 0` means infinite.
  - Pricing models: **Fixed, Quantity (seats), Volume, Tiered**.
  - **Setup fee** is charged immediately, even with a delayed start date.
  - **Revise** changes plan and/or `quantity` mid-life (same product only).
  - **Suspend** is a soft pause; then activate or cancel.
  - **`/capture`** collects an outstanding balance on demand.
  - `payment_failure_threshold`, `auto_bill_outstanding`: PayPal retries twice per cycle and rolls failed amounts forward.
  - `update-pricing-schemes` changes the price for existing subscribers with a 10-day notice.
  - Webhooks: `BILLING.SUBSCRIPTION.*`.
- **Limits:**
  - Upgrades and downgrades only within the same product.
  - Price changes take effect a cycle later if billing is within 10 days.
- **Sandbox:** Yes, and the Agent Toolkit covers it.
- **Docs:** https://developer.paypal.com/subscriptions/about · https://developer.paypal.com/subscriptions/pricing-plan · https://developer.paypal.com/subscriptions/payment-failure-retry · https://developer.paypal.com/subscriptions/change-price

### B4. Payment Links & Buttons (no-code + API)
- **Does:** `POST /v1/checkout/payment-resources` returns a hosted `payment_link` (`/ncp/payment/PLB-…`). It supports variants, tax, discounts, shipping and a return URL. Links can be shared as QR codes.
- **Levers:**
  - **A payable URL minted by API, with no front end.**
  - Works in all PayPal countries.
- **Limits:** about 10 variant options. **Venmo is not available on links in sandbox.**
- **Sandbox:** Yes (sandbox.paypal.com/ncp/links/create).
- **Docs:** https://developer.paypal.com/api/payment-links-buttons · https://developer.paypal.com/payment-links-buttons/faq

### B5. Donate SDK / PayPal Giving Fund
- **Does:** Donate button and SDK (`hosted_button_id` or `business`). The return includes a status `st`.
- **Lever:** a donation-specific UX and trust frame.
- **Limits:** charity enrolment in PayPal Giving Fund has no developer API (`UNVERIFIED`).
- **Sandbox:** Yes. Create the button at sandbox.paypal.com/donate/buttons and use `env:'sandbox'`.
- **Docs:** https://developer.paypal.com/sdk/donate

---

## C. Post-purchase

### C1. Disputes v1 (DISPUTE)
- **Does:** gives programmatic access to buyer disputes and chargebacks.
- **Actions** (`POST /v1/customer/disputes/{id}/…`):
  - `provide-evidence`, `appeal`, `accept-claim`, `escalate`, `send-message`
  - `make-offer`, `accept-offer`, `deny-offer`
  - `acknowledge-return-item`, `provide-supporting-info`
  - Also list, show and PATCH.
- **Sandbox-only helpers:**
  - **`/adjudicate`** decides the outcome (BUYER_FAVOR or SELLER_FAVOR).
  - **`/require-evidence`**.
  - **`POST /v1/customer/disputes`** opens a dispute as the buyer from a transaction ID.
  - **`/change-reason`**.
  - **`/v2/customer-support/process-chargeback`** simulates a card chargeback.
  - The `ACCELERATED_RESPONSE_ENABLED` note.
- **Levers:**
  - **A full, scriptable dispute lifecycle in sandbox.** You can open, negotiate (offers and messages), escalate and settle a dispute end-to-end with no humans involved.
  - `make-offer` supports structured negotiation: refund, replace, or return.
  - Evidence uploads: jpg/gif/png/pdf, under 10 MB each, 50 MB per call.
  - Stages: INQUIRY, CHARGEBACK (PayPal claim), PRE_ARBITRATION, ARBITRATION.
  - Webhooks: `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED`.
- **Limits:**
  - The buyer has 180 days from payment to open.
  - The inquiry lasts 20 days.
  - PayPal decides within about 10 days of escalation.
  - Funds are held during the dispute.
  - The Agent Toolkit exposes only list, get and accept.
- **Sandbox:** Yes. Creating a dispute needs buyer-side sandbox credentials.
- **Docs:** https://developer.paypal.com/api/customer-disputes/v1 · https://developer.paypal.com/disputes/test-go-live · https://developer.paypal.com/disputes/disputes-lifecycle · https://developer.paypal.com/disputes/overview

### C2. Shipment Tracking (PROVE-DELIVERY)
- **Does:** `POST /v1/shipping/trackers-batch` (up to 20 per call) or `POST /v2/checkout/orders/{id}/track` (COMPLETED orders, with item-level detail).
- **Levers:**
  - **Tracking releases held funds faster** (on delivery) and is key to **seller protection**.
  - `notify_buyer` sends an email, plus a PayPal app push to the buyer.
  - Item-level tracking lets the buyer dispute single items.
  - Carrier `OTHER` with `carrier_name_other`; about 1,300 carriers listed.
  - Status values: SHIPPED, ON_HOLD, DELIVERED, CANCELLED (LOCAL_PICKUP appears in the toolkit).
- **Limits:** tracking numbers are required for tangible goods. The order must be captured first.
- **Sandbox:** Yes, and the Agent Toolkit covers it.
- **Docs:** https://developer.paypal.com/api/tracking/track-orders/use · https://developer.paypal.com/api/tracking/track-orders/integrate · https://developer.paypal.com/api/orders-v2/track-orders/use

### C3. Transaction Search, Balances, Insights (OBSERVE)
- **Does:**
  - `GET /v1/reporting/transactions`: 31-day window per query, 3 years of history, up to 3 hours' delay, `page_size` up to 500, `fields=all`.
  - `GET /v1/reporting/balances`: balance as of any date-time, going back 3 years.
  - `get-balance-net-summary` and `get-daily-summary`.
  - `GET /v1/merchant/insights` (ORDERS/SALES metrics by interval) is in the toolkit; it has no public reference page, so it is `UNVERIFIED`.
- **Levers:**
  - **PayPal as the source of truth for an agent's financial memory.** `custom_id` and `invoice_id` show up here.
  - T-code reference.
  - SFTP reports.
- **Limits:** the 3-hour lag means you should use webhooks for anything real-time.
- **Sandbox:** Yes.
- **Docs:** https://developer.paypal.com/api/transaction-search/v1 · https://developer.paypal.com/reports/reference/t-codes

### C4. Webhooks (EVENTS)
- **Does:** push notifications for about 86–91 event types.
- **Levers:**
  - **`/v1/notifications/simulate-event`** fires mock events on demand.
  - **`webhooks-events/{id}/resend`** replays real events.
  - `webhooks-lookup`.
  - Offline verification: CRC32 of the raw body, `transmissionId|time|webhookId|crc32`, checked with SHA256withRSA against `paypal-cert-url`.
  - Key events:
    - `CHECKOUT.ORDER.APPROVED`
    - `PAYMENT.CAPTURE.*` (COMPLETED, DENIED, PENDING, REFUNDED, **REVERSED**)
    - `PAYMENT.AUTHORIZATION.CREATED/VOIDED`
    - `BILLING.SUBSCRIPTION.*`
    - `CUSTOMER.DISPUTE.*`, `RISK.DISPUTE.CREATED`
    - `PAYMENT.PAYOUTS-ITEM.*`
    - `INVOICING.INVOICE.PAID`
    - `VAULT.PAYMENT-TOKEN.CREATED/DELETED`
    - `MERCHANT.ONBOARDING.COMPLETED`, `MERCHANT.PARTNER-CONSENT.REVOKED`
    - `IDENTITY.AUTHORIZATION-CONSENT.REVOKED`
- **Limits:**
  - At most **10 webhooks per app**.
  - HTTPS on port 443.
  - Retries up to 25 times over 3 days.
  - Simulated events can't be verified via the API; verify them offline with the literal ID `WEBHOOK_ID`.
- **Sandbox:** Yes.
- **Docs:** https://developer.paypal.com/api/rest/webhooks/rest · https://developer.paypal.com/api/rest/webhooks/event-names · https://developer.paypal.com/api/rest/webhooks/simulator

### C5. Risk and fraud
- **STC / Transaction Risk (RaaS):**
  - `PUT /v1/risk/transaction-contexts/{merchant_id}/{tracking_id}` pushes arbitrary key-value risk context *before* payment.
  - Link it with the `PayPal-Client-Metadata-Id` header; the `tracking_id` can't be reused within 48 hours.
  - **Limited release, so sandbox access is likely gated** (`UNVERIFIED`).
  - Docs: https://developer.paypal.com/limited-release/raas
- **FraudNet:** a JSON script tag (`fncls=fnparams-dede7cc5-…`, `f` = session ID of at most 32 characters, `sandbox:true`) collects device data. Pass the same ID in `PAYPAL-CLIENT-METADATA-ID`. Sandbox: Yes. Docs: https://developer.paypal.com/pay-upon-invoice/fraudnet
- **Fraud Protection Advanced (cards):**
  - ML risk score, custom filters, review queue, allow and block lists.
  - Costs about $0.07 per transaction in the US. Self-serve in the business account.
  - Sandbox is `UNVERIFIED`.
  - Docs: https://developer.paypal.com/expanded/fraud-protection-advanced
- **3D Secure:** `SCA_ALWAYS` or `SCA_WHEN_REQUIRED`. Docs: https://developer.paypal.com/expanded/3d-secure
- **Lever:** you can feed **your app's own context** (e.g., agent identity or session signals) into PayPal's risk engine via STC. Gated.

### C6. Negative testing (sandbox superpower)
- **Does:** send the header `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}`. It works on Orders v2 and Payments v2 (auth, capture, void, refund).
- **Other methods:** per-account negative-testing mode and test values for Payouts, Invoicing and Subscriptions.
- **Lever:** **deterministic failure injection** for demoing recovery logic: declines, duplicates, denials.
- **Sandbox:** sandbox only (beta).
- **Docs:** https://developer.paypal.com/negative-testing/request-headers

---

## D. Platforms and identity

### D1. Multiparty / Platform (Partner Referrals, fees, delayed disbursement)
- **Onboarding:**
  - `POST /v2/customer/partner-referrals` returns a signup link (`action_url`). The seller logs in or signs up and grants permissions.
  - You can onboard **before or after the seller's first payment**.
  - Status via `/v1/customer/partners/{id}/merchant-integrations` (`UNVERIFIED` path).
  - The `PARTNER_FEE` feature is requested during onboarding.
- **Platform fees:**
  - `purchase_units[].payment_instruction.platform_fees[]` (max 1) takes a cut automatically at capture (SPLIT). The fee goes to the caller or to a named payee.
  - Same currency only. It settles daily to the partner's bank.
  - The seller sees it as "Partner commissions."
  - Not available for first-party integrations.
- **Delayed disbursement:**
  - `disbursement_mode: DELAYED` holds funds on the platform after capture, **auto-releasing after 28 days**.
  - Early release via `/v1/payments/referenced-payouts-items` is `UNVERIFIED`.
  - **This is PayPal's closest primitive to ESCROW.**
- **PayPal-Auth-Assertion:**
  - An unsigned JWT (`alg:none`) carrying `iss` (your client ID) and the seller's `payer_id` or email.
  - Lets you **act on behalf of a connected seller** (create orders, refund, track, read disputes).
- **Connected vs managed path:** connected means the seller owns a PayPal account. Managed (the platform does the KYC) is invite-only (`UNVERIFIED`).
- **`payee_receivable_fx_rate_id`:** an FX rate lock on orders.
- **Limits:**
  - Live requires partner approval.
  - Fee refunds and delayed disbursement may need PayPal enablement even in sandbox: the docs list "be an approved partner".
  - Requests carry the `PayPal-Partner-Attribution-Id` (BN code).
- **Sandbox:** Yes for basic onboarding and auth-assertion. **Gated (likely)** for DELAYED and fee refunds.
- **Docs:** https://developer.paypal.com/platforms/overview · https://developer.paypal.com/platforms/seller-onboarding · https://developer.paypal.com/platforms/checkout/delayed-disbursement · https://developer.paypal.com/api/rest/requests/#paypal-auth-assertion

### D2. Log in with PayPal (VERIFY-IDENTITY)
- **Does:** OAuth2/OIDC sign-in with a PayPal account.
- **Scopes:**
  - `openid`
  - `profile` (name)
  - `email`
  - `address`
  - `https://uri.paypal.com/services/paypalattributes`, which returns **`verified_account`** (PayPal-verified status) and **payer ID**
- **Levers:**
  - **Prove "this user is a real, PayPal-verified account holder" with no KYC of your own.**
  - The payer ID can be used directly as a **Payouts** recipient (`PAYPAL_ID`), so login becomes a payable identity.
  - Consent revocation arrives as a webhook (`IDENTITY.AUTHORIZATION-CONSENT.REVOKED`).
- **Limits:**
  - **No age or DOB attribute is documented.**
  - `email_verified` and `account_type` are `UNVERIFIED`.
  - Live needs a privacy/URL review.
- **Sandbox:** Yes. Enable "Log in with PayPal" in the app settings.
- **Docs:** https://developer.paypal.com/log-in/build · https://developer.paypal.com/log-in/references · https://developer.paypal.com/api/identity/v1

---

## E. Other assets and rails

### E1. Crypto / PYUSD (PROGRAMMABLE)
- **Pay with Crypto (Orders v2):**
  - Uses `payment_source.crypto` with `country_code: US`, `ORDER_COMPLETE_ON_PAYMENT_APPROVAL`, and a redirect to the `payer-action` link.
  - **The buyer pays from any third-party wallet in about 100 coins (BTC, ETH, PYUSD, USDC…) with no PayPal account.**
  - The merchant settles in USD. Minimum is $0.01. **Refunds are issued in PYUSD.**
  - **Limits:** US verified business merchants only, with a compliance review.
  - **Sandbox:** **Gated.** Request it at `sandbox.paypal.com/bizsignup/add-product?product=CRYPTO_PYMTS`.
  - Docs: https://developer.paypal.com/api/orders-v2/crypto · https://developer.paypal.com/crypto
- **PYUSD itself:**
  - An ERC-20/SPL token issued by Paxos (Ethereum, Solana, others). It has **no PayPal developer API**: you integrate with standard chain tooling (Solana docs: https://solana.com/pyusd).
  - Solana promotes **x402** (HTTP 402 pay-per-request in stablecoins) with PYUSD.
  - A PayPal-run x402 integration is `UNVERIFIED`.
  - Consumer PYUSD rewards/yield exist with no API (`UNVERIFIED`).
  - **Sandbox:** none from PayPal. Use devnet or testnet tokens (`UNVERIFIED`).

### E2. Venmo-specific
- **Available:**
  - Venmo checkout (JS SDK, US)
  - **Venmo vaulting** for merchant-initiated charges (A4)
  - **Venmo Payouts** to an @handle or phone, where the note appears in the social feed (B1)
- **No public Venmo social or feed API:** developer.venmo.com returns 404, and there are no business-profile APIs (`UNVERIFIED`).
- **Sandbox:** Yes for checkout (mobile flow) and payouts. No for Venmo on payment links.

### E3. Braintree
- GraphQL and SDK gateway with cards, PayPal, Venmo, ACH, local methods and a vault.
- **Required for ACP (OpenAI) and UCP-via-Braintree** agentic flows.
- **Self-serve sandbox signup** at braintreepayments.com/sandbox.
- Braintree Marketplace is deprecated in favor of PayPal Complete Payments (`UNVERIFIED`).
- Docs: https://developer.paypal.com/braintree/graphql/

### E4. Hyperwallet, Xoom, Honey, Zettle, Paidy
- **Hyperwallet:** public docs; sandbox needs sales or onboarding. **Not hackathon-reachable** (`UNVERIFIED`).
- **Zettle:** developer.zettle.com with self-serve apps, but it needs a Zettle merchant account (country-limited) and has no real sandbox (`UNVERIFIED`).
- **Xoom, Honey, Paidy:** no public developer APIs found (`UNVERIFIED`).

### E5. Currency conversion
- **Supported REST currencies (24):** AUD BRL CAD CNY CZK DKK EUR HKD HUF ILS JPY MYR MXN TWD NZD NOK PHP PLN GBP SGD SEK CHF THB USD.
  - HUF, JPY and TWD have zero decimals.
  - BRL, CNY and MYR are in-country only.
- **Currency Exchange v2:** `POST /v2/pricing/quote-exchange-rates` gives FX quotes with an **"FX Rate Guarantee"** for a period. Its negotiated-rate wording suggests account enablement, so **likely gated** (`UNVERIFIED` in sandbox).
- **Implicit conversion:** Payouts and Orders convert automatically, at a **3–4% spread**.
- **Docs:** https://developer.paypal.com/reports/reference/supported-currencies · https://developer.paypal.com/api/pricing/v2

### E6. PayPal World (cross-wallet interoperability)
- Announced Jul 23 2025: PayPal, Venmo, Mercado Pago (MOU), UPI (NPCI) and Tenpay Global (Weixin Pay), reaching about 2B users.
- Covers PayPal↔Venmo cross-border P2P by phone number and Venmo merchant acceptance in 2026.
- **No developer API is documented. Live status is `UNVERIFIED`.**
- Source: https://newsroom.paypal-corp.com/2025-07-23-Introducing-PayPal-World-a-global-platform-connecting-the-worlds-largest-payment-systems-and-digital-wallets,-starting-with-interoperability-to-PayPal-and-Venmo

---

## F. AI and agentic

### F1. Agent Toolkit (`@paypal/agent-toolkit`, TypeScript, Node 18+; a `python/` dir also exists)
- **Frameworks:** OpenAI Agents SDK, LangChain, Vercel AI SDK, MCP. Per-action allowlist config. `context.sandbox: true`.
- **Exact tools:**

  | Group | Tools |
  |---|---|
  | Invoices (15) | create_invoice, list_invoices, get_invoice, send_invoice, send_invoice_reminder, cancel_sent_invoice, generate_invoice_qr_code, delete_invoice, generate_invoice_number, search_invoicing, update_invoicing, cancel_invoice_auto_reminder, record_payment_for_invoice, record_refund_for_invoice, create_conditional_rules_for_invoice |
  | Recurring invoices (5) | create/activate/get/cancel/delete_recurring_series |
  | Payments (5) | create_order, get_order, pay_order, create_refund, get_refund |
  | Disputes (3) | list_disputes, get_dispute, accept_dispute_claim |
  | Shipment (3) | create/get/update_shipment_tracking |
  | Catalog (3) | create_product, list_products, show_product_details |
  | Subscriptions (7) | create_subscription_plan, list_subscription_plans, show_subscription_plan_details, create_subscription, show_subscription_details, update_subscription, cancel_subscription |
  | Reporting (2) | list_transactions, get_merchant_insights |

- **Absent:** Payouts, Vault, Identity, Disputes evidence/offers, Payment Links. These need direct REST calls, and they are where the gaps are.
- **Sandbox:** Yes.
- **Docs:** https://github.com/paypal/agent-toolkit · https://developer.paypal.com/ai-tools/toolkit · https://developer.paypal.com/ai-tools/agent-tools

### F2. MCP server
- **Local:** `npx -y @paypal/mcp --tools=all` with `PAYPAL_ACCESS_TOKEN` and `PAYPAL_ENVIRONMENT=SANDBOX`.
- **Remote:** `https://mcp.sandbox.paypal.com` and `https://mcp.paypal.com`, over SSE `/sse` or Streamable HTTP `/http` (`/mcp` for Bob). Auth is a Bearer token or browser OAuth.
- **Tools:** same catalog as the toolkit, **plus remote-only `search_product`, `create_cart`, `checkout_cart`**, which search for and buy **gift cards** via PayPal. This is an agent-buys-a-thing primitive.
  - Sandbox behavior of the gift-card tools is `UNVERIFIED`.
- **Docs:** https://developer.paypal.com/ai-tools/mcp-server · https://developer.paypal.com/ai-tools/agent-tools

### F3. AI Toolkit plugin (dev-time)
- For Claude Code, Codex, Cursor and IBM Bob (`/plugin install paypal@claude-plugins-official`).
- Includes the best-practices skill, a PreToolUse hook, and the `/paypal:doctor|explain-error|sandbox|setup|test-accounts` commands.
- It helps you build; it isn't a runtime primitive.
- Docs: https://github.com/paypal/AI-Toolkit

### F4. Agentic Commerce Services (Agent Ready, Store Sync)
- **Agent Ready:** lets merchants accept payment from AI assistants, in supervised and autonomous modes.
  - **ACP** (OpenAI/ChatGPT Instant Checkout): delegated payment tokens via **Braintree**.
  - **UCP with Braintree** (Google AI Mode/Gemini): a Google Pay handler.
  - **UCP with PayPal:** forwards the encrypted Google Pay credential to **Orders v2**.
- **Store Sync:** makes catalogs discoverable to AI assistants (Wix, BigCommerce/Feedonomics, Shopware), with orders flowing into the merchant's existing order system. Reportedly powered by Cymbio (acquisition `UNVERIFIED` date).
- **Access:** **gated** via the form at paypal.ai and onboarding. No public self-serve sandbox was found for ACP/UCP/Store Sync.
  - The UCP-with-PayPal path *ends* in standard Orders v2, so its back half is buildable in sandbox.
- **Docs:** https://developer.paypal.com/agent-ready/overview · https://developer.paypal.com/agent-ready/agentic-commerce-protocol · https://developer.paypal.com/agent-ready/universal-commerce-protocol-with-paypal · https://developer.paypal.com/agentic-commerce-services/about

### F5. "PayPal for agents" announcements

| Date | Item | Status |
|---|---|---|
| May 2025 | Perplexity in-chat checkout with PayPal (US) | Company-sourced: https://poc-dynamic.paypal.com/us/money-hub/article/how-paypal-powers-ai-shopping |
| Jul 23 2025 | PayPal World | Confirmed (newsroom, above) |
| Sep 2025 | Google AP2 (Agent Payments Protocol), PayPal among partners | Secondary only, `UNVERIFIED` |
| Oct 2025 | Agent Ready + Store Sync launch | Confirmed: https://retailboss.co/paypal-launches-agent-ready-to-enable-ai-powered-agentic-payments |
| Oct 28 2025 | PayPal + OpenAI: ACP adoption, PayPal wallet in ChatGPT Instant Checkout, merchant catalogs in ChatGPT (2026 rollout) | Confirmed: https://www.euronews.com/2025/10/28/new-paypal-openai-deal-means-customers-can-buy-directly-on-chatgpt · https://www.eweek.com/news/paypal-openai-chatgpt-shopping/ |
| Jan 2026 | Microsoft Copilot agentic checkout | Confirmed: https://www.crowdfundinsider.com/2026/01/257207-paypal-enables-ai-driven-digital-commerce-with-microsoft-partnership/ |
| 2026 | PYUSD market expansion / agentic launch / x402 | Blogs only, `UNVERIFIED` |
| — | PayPal "agent wallet" / "agentic tokens" product; PayPal + Anthropic partnership (beyond the official Claude plugin) | **Not found, `UNVERIFIED`** |

---

## G. Fees, reach and limits that shape design

| Item | Value | Source |
|---|---|---|
| PayPal Checkout / Venmo / guest | 3.49% + $0.49 | paypal.com/us/business/paypal-business-fees (updated Nov 4 2026) |
| Standard card | 2.99% + fixed | same |
| Pay Later | 4.99% + fixed | same |
| QR code transactions | 2.29% + fixed ($0.09 via integrator) | same |
| **Micropayments** (apply via User Agreement) | **4.99% + $0.09** | same: cheaper below about $12 |
| International | +1.50% | same |
| FX spread | 3–4% | same |
| Payouts (US, API) | **$0.25 flat per item**; international 2%, capped at $20 | same; /payouts/fees |
| Fraud Protection Advanced | about $0.07 per transaction (US) | /expanded/fraud-protection-advanced |
| Payouts reach | 96–156+ countries, 23+ currencies; 15k items per call; $20k per item | /payouts/overview |
| Webhooks | 10 per app; 25 retries over 3 days | /api/rest/webhooks/rest |
| Auth window | 3-day honor, 29-day validity, 115% / +$75 over-capture | /payment-methods/auth-honor |
| Refund window | 180 days | /checkout/refund-payment |
| Delayed disbursement | auto-release at 28 days | /platforms/checkout/delayed-disbursement |
| Dispute window | 180 days; 20-day inquiry | /disputes/overview |
| Reporting | 31-day query window, 3 years history, up to 3 hours' lag | /api/transaction-search/v1 |
| Access tokens | about 8 hours (sandbox 3–8 hours) | doc 07 |

- **Micropayments fee math:** at $1, standard pricing costs $0.52 (52%) and micropayments $0.14 (14%). **Sub-dollar payments still don't make sense per transaction.** Aggregate them instead: Vault UNSCHEDULED or THRESHOLD charges, prepaid balances, or subscriptions.
- **Payouts fee math:** a $0.25 flat payout is cheap for amounts over $12.50 relative to 2%.

---

## Superpowers: things only PayPal can do

1. **Two-sided network of about 430M accounts.** Payers and payees are both already on the network, so money can go *to* an email or phone number, not just *from* a card. Very few rails do both directions with one identity.
2. **Payable identity.** Log in with PayPal returns `verified_account` and a payer ID that can receive Payouts directly. Login, verification and the payout address are one object.
3. **Venmo social graph.** You can pay an @handle and a note appears in a social feed. You can also vault Venmo and charge it later. The feed itself isn't readable by API.
4. **Buyer and seller protection plus a dispute court.** PayPal adjudicates disputes, and the whole lifecycle (open, offer, escalate, adjudicate) is scriptable in sandbox. Tracking numbers feed seller protection and fund release.
5. **Trust at checkout.** The PayPal brand and Fastlane guest recognition, plus PayPal carrying the BNPL credit risk while the merchant is paid up front.
6. **Global payouts without bank details.** 15k recipients per call, 96+ countries, auto-FX, unclaimed money auto-returning after 30 days, and cancel-before-claim.
7. **Held money as a product.** 29-day authorizations, reauthorization, over-capture, platform DELAYED disbursement (28 days), and platform fees: escrow-like mechanics without being a money transmitter.
8. **One Orders API across every rail:** PayPal, Venmo, cards, Apple Pay, Google Pay, EU bank methods and **crypto from any wallet** (settling USD, refunding PYUSD).
9. **Regulated stablecoin.** PYUSD is on public chains (no PayPal API), which gives a programmable-money bridge outside PayPal's closed ledger.
10. **Agent-native surface.** The Agent Toolkit, MCP servers (remote sandbox, with gift-card cart tools) and an official Claude Code plugin. PayPal is the wallet in ChatGPT, Perplexity and Copilot agentic checkout.
11. **PayPal as a ledger.** Invoices can record off-PayPal cash, check or wire payments. Transaction Search keeps 3 years of history with your `custom_id` attached.

---

## Combinable verbs

| Verb | Primitive |
|---|---|
| **HOLD** | AUTHORIZE (29 days), DELAYED disbursement (28 days) |
| **REHOLD** | reauthorize |
| **RELEASE** | capture, void, delayed-disbursement release, tracking-triggered hold release |
| **CAPTURE-PARTIAL / CAPTURE-MANY / OVER-CAPTURE** | partial captures, `final_capture`, 115% / +$75 |
| **REPRICE** | PATCH an approved order; shipping callbacks during approval |
| **SPLIT** | multiple purchase_units with different payees (10); `platform_fees` |
| **ESCROW-LIKE** | AUTHORIZE→capture/void; DELAYED→release; dispute-held funds |
| **CHARGE-LATER** | Vault v3 `vault_id` with MERCHANT-initiated `stored_credential` (UNSCHEDULED, THRESHOLD, INSTALLMENT patterns) |
| **SAVE-MANDATE** | setup token, save-payment session, `usage_pattern` |
| **PAY-MANY** | Payouts (15k items) |
| **PAY-HANDLE** | email, phone, Venmo @handle or PayPal ID as the destination |
| **REVOKE-SEND** | cancel an UNCLAIMED payout; auto-return after 30 days |
| **INVOICE** | hosted bill, multi-recipient, scheduled, QR |
| **INSTALL-PAY** | invoice partial payments; Pay Later (Pay in 4, Pay Monthly) |
| **TIP** | invoice `allow_tip` |
| **DISCOUNT-IF-EARLY / AUTO-CANCEL** | invoice conditional rules |
| **RECORD** | record external payments and refunds on invoices |
| **SUBSCRIBE** | trials, tiers and seats, revise, suspend, capture outstanding balance |
| **LINK** | mint a payable URL or QR (Payment Links API, invoice QR) |
| **DISPUTE / NEGOTIATE / ADJUDICATE** | make-offer, accept or deny offer, send-message, escalate, sandbox adjudicate |
| **REFUND** | full or partial, multiple, with `note_to_payer` |
| **PROVE-DELIVERY** | tracking (order- or item-level) |
| **VERIFY-IDENTITY** | Log in with PayPal `verified_account` + payer ID |
| **ONBOARD** | Partner Referrals |
| **ACT-ON-BEHALF** | PayPal-Auth-Assertion |
| **SCORE-RISK** | FraudNet, STC (gated), FPA |
| **OBSERVE** | webhooks, transaction search, balances, insights |
| **SIMULATE** | webhook simulator, `PayPal-Mock-Response`, sandbox dispute helpers |
| **CONVERT-CURRENCY** | auto-FX in Orders and Payouts; FX quote and rate guarantee (likely gated); `payee_receivable_fx_rate_id` |
| **ACCEPT-CRYPTO** | Orders `payment_source.crypto` (gated) |
| **PROGRAMMABLE** | PYUSD on-chain (outside PayPal APIs); x402 via Solana ecosystem (UNVERIFIED for PayPal) |
| **BUY (agent)** | remote MCP `search_product` → `create_cart` → `checkout_cart` (gift cards) |
| **DONATE** | Donate SDK |
| **STREAM?** | **No native streaming or per-second money.** Approximate it with periodic Vault MIT charges, metered subscriptions (quantity revise + capture), or batched Payouts. |
