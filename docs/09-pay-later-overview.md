# 09 — PayPal Pay Later: Overview & Rules

Sources: https://developer.paypal.com/pay-later/overview (updated Oct 20, 2026) and https://developer.paypal.com/pay-later/reference.
⚠️ `https://developer.paypal.com/pay-later/rules` currently returns **404**. The "rules" below are the eligibility/compliance requirements from the Overview plus best practices from the Reference — the current official source for these.

## What it is
Pay Later lets **customers buy now and pay in installments while merchants get paid up front.** Offers vary by country.

**Merchant benefits:** higher conversion, new customers, larger order values · **dynamic messages** based on cart contents · messaging at **multiple touch points** (product page, cart, checkout).

## Products by country

| Country | Product | Installments | Frequency | Purchase amount |
|---|---|---|---|---|
| **US** | Pay in 4 | 4 | Every 2 weeks | $10 – $2,000 |
| US | Pay Monthly | 3, 6, 12, or 24 | Monthly | $49 – $10,000 |
| **Australia** | Pay in 4 | 4 | Every 2 weeks (interest-free) | AUD 1 – 1,999.99 |
| **Canada** | Pay in 4 | 4 | Every 2 weeks | CAD 10 – 2,000 |
| **France** | Pay in 4X | 4 | Monthly | €20 – €3,000 |
| France | Pay in 6, 12 or 24X | 6, 12, 24 | Monthly | €120 – €2,900 |
| **Germany** | PayPal Ratenzahlung | 3, 6, 12, 24 | Monthly | €99 – €10,000 |
| Germany | Pay in 30 Days | 1 | Due after 30 days | €1 – €3,000 |
| **Italy** | Pay in 3 | 3 | Monthly | €20 – €3,000 |
| Italy | Pay in installments | 6, 12, 24 | Monthly | €120 – €5,000 |
| **Spain** | Pay in 3 | 3 | Monthly | €20 – €2,000 |
| Spain | Pay in installments | 6, 12, 24 | Monthly | €120 – €5,000 |
| **UK** | Pay in 3 | 3 | Monthly | £20 – £3,000 |
| UK | Pay in 30 Days | 1 | Due within 30 days | £1 – £900 |

### Country notes / legal disclosures
- **US:** Pay in 4 loans to CA residents made under a CA Financing Law License. PayPal, Inc. is a GA Installment Lender Licensee (NMLS #910457) and RI Small Loan Lender Licensee. **Pay Monthly** subject to credit approval; fixed APR **9.99–35.99%**; lender is **WebBank**.
- **Australia:** Provided by PayPal Credit Pty Limited (ABN 66 600 629 258), Australian Credit Licence 568848. First payment due at purchase.
- **Canada:** Pay in 4 buttons support English and French. Pass `locale: "fr-CA"` / `"en-CA"`.
- **UK:** Pay in 3 — first payment at purchase, rest over the next 2 months. Pay in 30 Days — no interest or fees, no down payment; limited availability.
- **France, Germany, Italy, Spain:** eligibility/availability depend on merchant status, sector, and integration. **Cross-border messaging requires PayPal approval.**

## The rules (eligibility & compliance — all countries)

Merchants must:
1. Be a PayPal merchant **based in the target country**.
2. Have a website facing that country's customers (French sites must also be accessible in French).
3. Transact in the **local currency**.
4. Have a **PayPal one-time payment** integration (https://developer.paypal.com/checkout).
5. Follow the **Acceptable Use Policy**, **Pay Later Messaging Center terms**, and **User Agreement**.
6. **Display Pay Later messages in full, without edits** — no added wording, no removed content: *"Render the Pay Later messaging in its entirety with all the links and language provided by PayPal."*
7. **Use PayPal's official code** — do **not** create or host your own Pay Later content.

**Not eligible:** Reference Transaction and Recurring Payment integrations. → Pay Later is for one-time payments; don't pitch it on top of Subscriptions/vaulted recurring billing.

### What this means for an AI project
- An AI agent/LLM **must not generate its own Pay Later/BNPL wording** ("pay $75 x 4 interest-free!") in the UI. Render PayPal's `<paypal-message>` component instead, and let PayPal supply the text, links, and Learn More modal.
- The AI can *decide where/when* to show the message, or pass the right `amount`, but the message content itself must be PayPal's, unmodified.
- Don't store/duplicate message interaction data locally unless needed (PayPal retains it).
- Recalculate amounts **server-side** before updating the message.

### Best practices (from the Reference)
- Use `clientId` (public, frontend-safe) for most integrations; `clientToken` only if specifically required (needs a backend endpoint).
- Messages only render on **HTTPS** pages.
- Messages SDK is client-side only (no SSR) — load in a client component in Next.js/Nuxt.
- Unsupported country/currency → `fetchContent()` throws; wrap in try/catch and hide gracefully.

## Legal/terms links
- Pay Later Messaging Center Program terms — https://www.paypal.com/legalhub/paypal/pay-later-messaging-tnc
- Acceptable Use Policy — https://www.paypal.com/legalhub/paypal/acceptableuse-full
- User Agreement — https://www.paypal.com/legalhub/paypal/useragreement-full
- Advertising Program terms — https://www.paypal.com/legalhub/paypal/useragreement-full#advertising-program
- Canada Pay in 4 Messaging Program Terms — https://www.paypalobjects.com/crc-merchant-lifecycle/docs/CA_Pay_in_4_Messaging_Centre_Program_Terms.pdf
- Consumer BNPL info — https://www.paypal.com/us/digital-wallet/ways-to-pay/buy-now-pay-later

## Integration options
- **JS SDK v6 (low-code):** https://developer.paypal.com/pay-later/integrate → doc 10
- **Commerce platforms:** https://developer.paypal.com/v5/pay-later/commerce-platforms
- Pay Later **button** (checkout, not just messaging): via JS SDK v6 `paypal-payments` component and `<paypal-pay-later-button>` — https://developer.paypal.com/sdk/js/set-up
- Sandbox testing: `/paypal:test-accounts` in the PayPal AI Toolkit covers BNPL test scenarios; test with amounts ~$50–$1,000.
