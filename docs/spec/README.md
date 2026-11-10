# Standing Orders: Build Spec

> Brands clear overstock into money that's already waiting. Shoppers' agents bid with PayPal holds. Code clears. PayPal settles.

This folder is the build plan. Each file is meant to be implementable on its own.
Product background: [../STANDING-ORDERS.md](../STANDING-ORDERS.md). Sandbox proof: [../../spikes/paypal-spikes.mjs](../../spikes/paypal-spikes.mjs) (S1, S2, S3-local and S4 passed on 2026-11-10).

## Index

| File | What's in it |
|---|---|
| [data-model.md](data-model.md) | Postgres tables, state machines, locking and idempotency |
| [api.md](api.md) | REST endpoints, MCP tools, webhooks, and the exact PayPal calls |
| [screens.md](screens.md) | Every web (W01–W21) and mobile (M01–M12) screen, with states and interactions |
| [features/01-brand-onboarding.md](features/01-brand-onboarding.md) | Brand sign-in and verification |
| [features/02-listing-creation.md](features/02-listing-creation.md) | Create a listing; Channel3 product match |
| [features/03-offer-page-held-bid.md](features/03-offer-page-held-bid.md) | Shopper offer page; PayPal AUTHORIZE hold and vault |
| [features/04-buyer-agent-intent-bids.md](features/04-buyer-agent-intent-bids.md) | Buyer agent chat; multi-product intent bids |
| [features/05-mandates-rolling.md](features/05-mandates-rolling.md) | Mandates; autonomous bid rolling |
| [features/06-price-watcher.md](features/06-price-watcher.md) | Channel3 price watcher and auto-void |
| [features/07-mcp-server.md](features/07-mcp-server.md) | MCP server for outside agents |
| [features/08-brand-console.md](features/08-brand-console.md) | AG Grid book, demand curve, quantity slider |
| [features/09-brand-agent.md](features/09-brand-agent.md) | Brand agent recommendations (read-only) |
| [features/10-clearing-engine.md](features/10-clearing-engine.md) | Uniform-price call auction |
| [features/11-settlement-workflows.md](features/11-settlement-workflows.md) | Render Workflows: capture, void, promote |
| [features/12-payouts-fees-tracking.md](features/12-payouts-fees-tracking.md) | Payouts, platform fee, shipment tracking |
| [features/13-notifications.md](features/13-notifications.md) | Email, push and in-app messages |
| [features/14-embed-widget.md](features/14-embed-widget.md) | "Make an offer" button and share links |
| [features/15-audit-ops.md](features/15-audit-ops.md) | Audit log and ops/admin |
| [features/16-auth-security-tenancy.md](features/16-auth-security-tenancy.md) | Auth, security, multi-tenancy, concurrency |
| [features/17-demo-seeding.md](features/17-demo-seeding.md) | Demo seed data and simulated bidders (labelled) |
| [features/18-landing-page.md](features/18-landing-page.md) | Marketing landing page |

## Glossary

| Term | Meaning |
|---|---|
| **Hold** | A PayPal authorization (`intent: AUTHORIZE`). The shopper's money is reserved, not charged. |
| **Capture** | Charging a hold. We capture the **clearing price**, which is at most the hold, with `final_capture: true`; PayPal releases the rest. |
| **Void** | Releasing a hold without charging anything. |
| **Bid** | One held offer: listing, max price, hold ID, status. |
| **Intent** | A shopper's want that can cover several products ("any of XM5 / QC45 / M4 up to $230"). An intent owns 0–1 live bids at a time. |
| **Mandate** | Hard limits the shopper gives their agent: max price, total held cap, allowed products, expiry, auto-roll on/off. Enforced in code. |
| **Listing** | One product a brand is clearing: quantity, floor (minimum price), window. |
| **Book** | All live bids on a listing. Private to that brand. |
| **Window** | The time a listing accepts bids (default 72 h; must be ≤ 72 h). |
| **Clearing price** | The lowest winning bid. Every winner pays it (uniform price). |
| **Floor** | The brand's minimum price. The clearing price is never below it. |
| **Promotion** | When a winner's capture fails, the next-best losing bid becomes a winner. |
| **Simulated bidder** | A seeded demo bidder. Always labelled "SIM" in the UI. |

## System overview

```
                       ┌──────────────────────────── Render web service (Node/TS) ───────────────────────────┐
 Shopper (web/mobile) ─┤  Offer page + chat API ──┐                                                          │
 Brand (web/mobile)  ──┤  Brand console API ───────┼──> Core: bids · listings · mandates · auction · audit ──> Postgres
 Claude Desktop etc. ──┤  MCP endpoint /mcp ───────┘        │            │                 │                 │
 Channel3 webhooks  ───┤  /webhooks/channel3 ─> Watcher (plain code) ──> void bids          │                 │
 PayPal webhooks    ───┤  /webhooks/paypal  ─> reconcile settlements                         │                 │
                       │  Agent loop (Claude API): buyer agent, brand agent (read-only tools) │                 │
                       └──────────────────────────────────┬──────────────────────────────────┴─────────────────┘
                                                          │ Clear
                                              Render Workflows: one task per bid
                                              capture / void / promote → Payout
                                                          │
                                              PayPal REST (Orders v2, Payments v2, Payouts v1, Vault)
```

Rule: **agents choose what to bid; code decides who wins and what is charged; only the backend calls PayPal.**

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node 20+ / TypeScript, Fastify, Zod validation |
| DB | Postgres (Render **paid** instance; the free one expires in ~30 days and judging runs to Dec 21) |
| Jobs | Render Workflows (settlement fan-out), Render cron (window close, hold expiry) |
| Frontend | React + Vite, AG Grid Enterprise / AG Charts / AG Studio (licence in `AG_GRID_LICENSE_KEY`), Tailwind |
| Mobile | Responsive web / PWA (no native app for the hackathon) |
| AI | Claude API (latest Claude model) with tool use; MCP via `@modelcontextprotocol/sdk` |
| Payments | PayPal REST, direct (the Agent Toolkit lacks authorize/capture/void/payouts) |
| Product data | Channel3 API and webhooks |
| Realtime | Server-sent events (SSE) from the backend |
| Email | Resend, or console log in demo |
| Build aid | APIMatic PayPal Context Plugin (mention in README) |

## Repo layout (proposed)

```
apps/
  api/            Fastify server: REST, MCP, webhooks, agent loop
    src/core/     auction.ts (pure), mandates.ts, bids.ts, listings.ts
    src/paypal/   client.ts (token cache, request-id), orders.ts, payouts.ts
    src/channel3/ client.ts, match.ts (GTIN/MPN exact match)
    src/agents/   buyer.ts, brand.ts, tools.ts
    src/mcp/      server.ts
    src/webhooks/ channel3.ts, paypal.ts
  workflows/      Render Workflows tasks: settleBid, promoteNext, payoutBrand
  web/            React app: brand console + shopper pages + landing
packages/shared/  zod schemas, types
db/migrations/    SQL
spikes/           existing sandbox spikes
docs/spec/        this folder
```

## Build order and owners (deadline **Nov 12, 12:00 pm PST**)

| Owner | Track | Features | Must be done by |
|---|---|---|---|
| **A: money** | DB, PayPal client, auction, settlement | 16 (core), 10, 11, 12, 15 | Nov 11, 12:00 PST: Clear works end to end in sandbox |
| **B: brand UI** | Brand console in AG Grid | 01, 02, 08, 09, 18 | Nov 11, 18:00: console hero screen polished |
| **C: shopper and agents** | Offer page, holds, buyer agent, mandates | 03, 04, 05, 13, 14 | Nov 11, 18:00: shopper bids with a real hold |
| **D: integrations and demo** | Channel3, watcher, MCP, seeding, video | 06, 07, 17, README, video | Nov 11, 22:00: video recorded |

Timeline:
- **Nov 10 evening:** schema, PayPal client, auction unit tests, console skeleton, offer page skeleton.
- **Nov 11 morning:** holds from the offer page; Clear → Workflows → captures/voids/payout.
- **Nov 11 afternoon:** price watcher, MCP, brand agent, seeding, polish.
- **Nov 11 night:** record the video; deploy to Render.
- **Nov 12 by 10:00 PST:** Devpost submitted (public repo, OSS license in About, YouTube video under 3 min). The last 2 hours are a buffer.

P0 = must ship for the demo. P1 = ship if time allows. P2 = describe in README only.

## Definition of done (whole product)
- [ ] One brand lists a product; shoppers place real sandbox holds from the offer page.
- [ ] Claude Desktop places a bid over MCP; it appears live on the console.
- [ ] A Channel3 price drop (real or replayed fixture, labelled) voids a bid.
- [ ] Clear runs the auction; Workflows captures winners at the clearing price, voids losers, promotes after one injected decline.
- [ ] Payout to the brand's sandbox account is created.
- [ ] Every money action has an audit row with PayPal IDs.
- [ ] Simulated bidders are labelled SIM everywhere.
- [ ] Deployed on Render; README covers problem, APIs, sponsors, setup, honest limits; MIT license.
- [ ] Video under 3 min, public on YouTube.

## Designs
All screens are in Figma: file **PayPal-Hack26** (https://www.figma.com/design/BRS9LZjjFKWxvZqv5sQZcG/PayPal-Hack26), page **"Standing Orders — UI"**.
- Boards: 00 Foundations · 01 Web Marketing & Brand (W01–W11) · 02 Web Shopper (W12–W18) · 03 Web Developers, Ops & States (W19–W21) · 04 Mobile Shopper (M01–M09, M12) · 05 Mobile Brand & Notifications (M10a, M10b, M11).
- W05 is split into W05a (product match) and W05b (terms & review); M10 into M10a (lock-screen alert) and M10b (approve clear).
- Type: Instrument Sans (headings/UI) + Geist Mono (labels). Backgrounds come from the file's "bgs" page.
