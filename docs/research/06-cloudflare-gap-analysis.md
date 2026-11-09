# 06 — Cloudflare Pay per Crawl & Monetization Gateway: status, gaps, and a PayPal version

Verified 2026-11-09 against Cloudflare's own docs and blog. Each claim is marked **[docs]** (stated by Cloudflare) or **[inference]** (our reading).

## Current status

| Product | What it is | Status |
|---|---|---|
| **Pay per crawl** | Site owner charges AI crawlers a price per page via HTTP 402 | **Still closed beta.** "Pay per crawl is currently in closed beta" (docs updated Jul 28, 2026). Launched Jul 1, 2025. [docs] |
| **Pay per use / pay per answer** | Publishers paid when content is used in an answer (partners Ceramic.ai, You.com) | Announced Jul 1, 2026 as an "experiment"; broad availability "later in 2026", no date. [secondary source: ppc.land] |
| **Monetization Gateway** | Charge agents per request for any page, API, dataset or MCP tool behind Cloudflare, settled over x402 | **Waitlist only** (announced Jul 1, 2026). "The Monetization Gateway waitlist is open now for Cloudflare customers." [docs: blog] |

Cloudflare itself has concluded that **a crawl is the wrong unit to price**. Over half of legitimate bot crawl traffic re-fetches unchanged pages, so it is moving toward pricing by usage or value. [secondary source]

## How Pay per crawl works [docs]
- The site owner sets **one price per zone** (minimum $0.001). Optional "dynamic pricing" lets the origin send a `crawler-price` header for each response.
- A crawler without payment gets `402` + `crawler-price: USD 0.01`. It retries with `crawler-exact-price` or `crawler-max-price`. On success it gets `200` + `crawler-charged: USD 0.01`.
- The crawler must be a **verified bot**: submit a form to Cloudflare and sign requests with **Web Bot Auth** (HTTP message signatures). The price headers must be part of the signature.
- **Cloudflare is the merchant of record.** Payments go through **Stripe**: both sides need Stripe, and publishers need a **new, dedicated Cloudflare Stripe Connect account** ("pre-existing Stripe accounts are not compatible").
- Charges only on successful responses; errors aren't billed. `/robots.txt`, `/sitemap.xml`, `/security.txt` and `/crawlers.json` are always free.
- A Discovery API (`GET crawlers-api.ai-audit.cfdata.org/charged_zones`) lists domains that charge your crawler, and only the domains.

## What they missed: gaps that matter to end users

### For the person or business whose agent is paying (buyer side)
1. **No spending limits.** "Cloudflare is not responsible for configuring spending limits… Crawlers are responsible for setting and enforcing their own spending limits." [docs]
2. **No buyer ledger or receipts.** Buyers are told to "track and save" the `crawler-charged` headers themselves to know their bill. [docs] There's no answer to "what did my agent buy, from whom, and why?"
3. **Charged again for every re-crawl of the same page,** even unchanged. "Will I be charged for re-crawling the same page? Yes." [docs] There's no "already bought" receipt or access window.
4. **No refunds or disputes when content is junk.** A `200` with useless, irrelevant or bait content is still billed. The Gateway touts stablecoins' "zero chargebacks," which is a seller benefit and a buyer risk. [docs + inference]
5. **No human-approval middle ground.** The Gateway says approving every payment is impractical [docs], but nothing in between is offered, such as auto-approve under $X and a tap to approve above it. [inference]
6. **Only big, verified crawlers can pay.** It needs a form-based bot verification plus Web Bot Auth, so an individual's personal agent, or a small developer's agent, can't easily take part. [docs + inference]
7. **No price before buying.** The Discovery API returns domain names only: no prices, catalog, terms or preview. [docs]
8. **Crypto required (Gateway).** Settlement is stablecoin-only (USDC / Open USD) at launch. Most consumers and small businesses have no crypto wallet. [docs]

### For the creator or seller being paid
9. **Can't see your own earnings.** "Your accrued balance is not currently visible in the dashboard. You can request balance updates from your Cloudflare team." [docs]
10. **Slow payouts with minimum thresholds.** Monthly payouts, "subject to settlement periods and minimum payout thresholds." [docs]
11. **Extra account setup.** A new dedicated Stripe Connect account is required, even if you already use Stripe. [docs]
12. **One price for every crawler** that's charged. "You can only set a single price that applies to all crawlers configured with the 'Charge' option." [docs] There are no per-buyer tiers, free quotas, or bulk or subscription deals.
13. **Only works if you use Cloudflare.** It's tied to a Cloudflare zone, so APIs and MCP servers hosted elsewhere are excluded. [docs]
14. **No usage terms attached to a payment.** A payment buys access but carries no license (search vs training, attribution). The pay-per-use pivot only partially addresses this. [inference]
15. **No invoices or tax statements** for either side. Not mentioned. [inference]

## What we can borrow
- **The 402 handshake and header shape:** price → retry with exact or max price → charged receipt. This is a simple, proven interface, and we could stay compatible with x402-style clients.
- **The buyer's max price** (`crawler-max-price`) as a per-request cap. We extend it into full budgets.
- **Only charge on successful responses**; never bill errors.
- **Always-free paths** (robots, sitemap), so agents can discover what's for sale.
- **Price set per response by the seller's server** (dynamic pricing via a response header).
- **Signed agent identity** (Web Bot Auth is an open standard draft), but made optional and open to individuals' agents.
- **A discovery endpoint**, extended to include prices, terms and previews.

## The PayPal version ("Agent Toll"): fixes each gap
| Gap | Our answer, built on PayPal |
|---|---|
| No spending limits (#1, #5) | The agent's owner sets budgets per agent, per merchant and per day. Auto-approve under $X, **one tap to approve above it**. |
| No receipts or ledger (#2) | Every charge is logged with agent, merchant, price, reason and content hash. The owner sees a plain-English feed: "your research agent spent $0.42 on 3 articles today." |
| Paying twice (#3) | **A receipt grants an access window** (e.g. 24 h or until the content changes). Re-fetching unchanged content is free. |
| No buyer protection (#4) | **Refunds and disputes**: an AI check flags "paid but useless" responses; refunds go through PayPal refunds, and disputes through PayPal's dispute process. |
| Only big crawlers (#6) | Any agent can pay once linked to a PayPal account; verification optional. |
| No price before buying (#7) | The discovery endpoint returns price, terms and a free preview snippet, so the agent can decide before paying. |
| Crypto only (#8) | **Ordinary money**: a PayPal balance, card or bank via PayPal. No wallet setup. |
| Seller can't see earnings (#9) | Live seller dashboard (could be AG Grid): earnings per agent and per resource, in real time. |
| Monthly payouts (#10) | Seller payouts through PayPal Payouts on a schedule or a low threshold; no special accounts. |
| Extra account setup (#11) | Sellers use the **PayPal account they already have**. |
| One price for all (#12) | Per-buyer prices, free quotas, bulk credit packs, subscriptions (PayPal Subscriptions). |
| Cloudflare-only (#13) | A drop-in **middleware or SDK for any server or MCP server** (Express/Fastify/Hono/Python), not tied to one network. |
| No usage terms (#14) | A machine-readable license travels with each receipt (search-only, training allowed, attribution required). |
| No invoices or statements (#15) | Monthly statements for sellers; expense reports for the agent's owner. |

### Honest constraints for the PayPal design
- **Tiny payments are uneconomical per transaction** on card or PayPal rails (fixed fees). So: the buyer **prepays a balance** (e.g. a $5 top-up via a PayPal order), we **debit per call** in our own ledger, and sellers are **paid out in batches** via PayPal Payouts. All of this is buildable in sandbox. [inference: standard aggregation pattern]
- Holding user balances raises **stored-value and money-transmission questions** for a real company. At hackathon scale it's fine to demo; long term it would need PayPal's platform/marketplace structure or licensing. [inference]
- Stay **compatible with x402 clients** where possible, so we join that standard rather than fight it, and add PayPal ordinary-money settlement.

## Sources
- Cloudflare docs, What is Pay Per Crawl: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/what-is-pay-per-crawl/
- Pay Per Crawl FAQ: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/faq/
- Crawl pages (headers): https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/crawl-pages/
- Connect Stripe (buyer limits): https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/connect-to-stripe/
- Discover payable content: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/discover-payable-content/
- Verify AI crawler: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/verify-ai-crawler/
- Set a price: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-site-owner/set-a-pay-per-crawl-price/
- Manage payouts: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-site-owner/manage-payouts/
- Advanced configuration: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-site-owner/advanced-configuration/
- Error codes: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/error-codes/
- Monetization Gateway announcement: https://blog.cloudflare.com/monetization-gateway/
- Pay-per-answer pivot (secondary): https://ppc.land/cloudflare-stops-charging-ai-per-crawl-and-starts-paying-per-answer/
- Criticism (secondary): https://www.techradar.com/pro/cloudflares-pay-per-crawl-is-built-to-fail-heres-why · https://growthshuttle.com/cloudflares-pay-per-crawl-a-promising-concept-undermined-by-practical-limitations/
