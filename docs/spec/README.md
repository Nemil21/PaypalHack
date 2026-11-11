# Holdfast: Build Spec

> Brands clear overstock into money that's already waiting. Shoppers' agents bid with PayPal holds. Code clears. PayPal settles.

This folder is the build plan. Each file is meant to be implementable on its own.
Product background: [../HOLDFAST.md](../HOLDFAST.md). Sandbox proof: [../../spikes/paypal-spikes.mjs](../../spikes/paypal-spikes.mjs) (S1, S2, S3-local and S4 passed on 2026-11-10).

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
| [features/10-clearing-engine.md](features/10-clearing-engine.md) | Pay-your-bid call auction and hold-age guard |
| [features/11-settlement-workflows.md](features/11-settlement-workflows.md) | Settlement coordinator (in-process, then Render Workflows): capture, void, inline promotion |
| [features/12-payouts-fees-tracking.md](features/12-payouts-fees-tracking.md) | Payouts, platform fee, shipment tracking |
| [features/13-notifications.md](features/13-notifications.md) | In-app messages (P0), email and push (P1) |
| [features/14-embed-widget.md](features/14-embed-widget.md) | "Make an offer" button and share links |
| [features/15-audit-ops.md](features/15-audit-ops.md) | Audit log and ops/admin |
| [features/16-auth-security-tenancy.md](features/16-auth-security-tenancy.md) | Auth, security, multi-tenancy, concurrency |
| [features/17-demo-seeding.md](features/17-demo-seeding.md) | Demo seed data and simulated bidders (labelled) |
| [features/18-landing-page.md](features/18-landing-page.md) | Marketing landing page |
| [features/19-live-rounds.md](features/19-live-rounds.md) | Live rounds: brand agent nudges, buyer agents raise |

## Glossary

| Term | Meaning |
|---|---|
| **Hold** | A PayPal authorization (`intent: AUTHORIZE`). The shopper's money is reserved, not charged. |
| **Capture** | Charging a hold. We capture the winner's **own bid**, which equals the hold, with `final_capture: true`. |
| **Void** | Releasing a hold without charging anything. |
| **Bid** | One held offer: listing, max price, hold ID, status. |
| **Intent** | A shopper's want that can cover several products ("any of Aurel A7 / A5 up to $230"). An intent owns 0–1 live bids at a time. |
| **Mandate** | Hard limits the shopper gives their agent: max price, total held cap, allowed products, expiry, auto-roll on/off. Enforced in code. |
| **Listing** | One product a brand is clearing: quantity, floor (minimum price), window. |
| **Book** | All live bids on a listing. Private to that brand. |
| **Window** | The time a listing accepts bids: ≤ 48 h, then optional live rounds (≤ 6 h), then ≤ 6 h to Clear. Keeps every capture inside PayPal's 3-day card-hold guarantee. |
| **Live rounds** | Optional final phase (once per listing, may start before the window closes): new bids stop, the brand agent tells bidders below the cutoff the real cutoff, and their agents may raise until `rounds_end_at` (19). |
| **Pay-your-bid** | Each winner pays exactly their own final bid, never more. |
| **Cutoff** | The lowest winning bid for the chosen quantity. Used in nudges and the console; nobody else pays it. |
| **Floor** | The brand's minimum price. No winner is below it. |
| **Promotion** | When a winner's capture fails, the next-best reserve bid wins that unit at its own bid, inline in the same transaction; at most 3 promotions per unit (`unit_root_bid_id`). |
| **Reserve list** | Every loser at or above the floor; their holds stay until captures finish. Shown to the shopper as "on the reserve list". |
| **`landHold`** | The only code path that turns a bid HELD; re-checks the listing and mandate under locks (data-model rule 3). |
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
                                    Settlement coordinator (in-process; Render Workflows adapter)
                                    capture / void / inline promote → Payout
                                                          │
                                              PayPal REST (Orders v2, Payments v2, Payouts v1, Vault)
```

Rule: **agents choose what to bid; code decides who wins and what is charged; only the backend calls PayPal.**

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node 20+ / TypeScript, Fastify, Zod validation |
| DB | Postgres (Render **paid** instance; the free one expires in ~30 days and judging runs to Dec 21) |
| Jobs | In-process settlement coordinator first, then the Render Workflows adapter (settlement fan-out); Render cron (5-min sweeper, 1-min settlement kick and payout poll, deadlines, daily `demo:refresh`) |
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
    src/channel3/ client.ts, match.ts (two-stage exact match)
    src/agents/   buyer.ts, brand.ts, tools.ts
    src/mcp/      server.ts
    src/webhooks/ channel3.ts, paypal.ts
  workflows/      Render Workflows adapter over the same packages/core tasks
  web/            React app (served by Fastify, same origin): brand console + shopper pages + landing
packages/core/    db, transition, landHold, audit, PayPal client (+ FakePayPal stub), auction, settleBid, promoteWithin, payoutBrand
packages/shared/  zod schemas, types, isBiddable/isRaisable, listingPhase, eligibility, feeCents, likelyBand, ListingEvent union
db/migrations/    SQL
spikes/           existing sandbox spikes
docs/spec/        this folder
```

## Build order (deadline **Nov 12, 12:00 pm PST**; submit by 10:00 PST)

Builders are Agent Orchestrator workers running many tickets in parallel, so there are no owner tracks. The dependency-ordered **wave plan**, the critical path (money spine and bid chain), checkpoints CP1–CP5 (PST and IST) and the circuit breakers live in [../tickets/INDEX.md](../tickets/INDEX.md). Feature files keep an "Owner" letter as a grouping label only.

Every feature stays in scope. Where a fallback exists (`DEMO_MODE` logins before Log in with PayPal, the labelled test-card button before card fields, the in-process coordinator before Render Workflows, template nudges before Claude-phrased ones, the replayed price event before the live Channel3 webhook), the fallback is built first and the full version after it.

P0 = must ship for the demo. P1 = ship after the P0 money spine. P2 = describe in README only (only items that were P2 before the engineering review).

## Definition of done (whole product)
- [ ] One brand lists a product; shoppers place real sandbox holds from the offer page.
- [ ] Claude Desktop places a bid over MCP; it appears live on the console.
- [ ] A Channel3 price drop (real or replayed fixture, labelled) voids a bid.
- [ ] Live rounds: SIM agents and one real bidder raise after a nudge.
- [ ] Clear runs the auction; settlement captures each winner at their own bid, voids losers, promotes after one injected decline (at the promoted bidder's own bid), on Render Workflows (in-process coordinator as the fallback).
- [ ] Payout to the brand's sandbox account is created.
- [ ] Every money action has an audit row with PayPal IDs.
- [ ] Simulated bidders are labelled SIM everywhere.
- [ ] Deployed on Render; README covers problem, APIs, sponsors, setup, honest limits; MIT license.
- [ ] Video under 3 min, public on YouTube.

## Designs
Figma file **PayPal-Hack26** (https://www.figma.com/design/BRS9LZjjFKWxvZqv5sQZcG/PayPal-Hack26), page **Holdfast — v3** is canonical (D16):
- Geist for headlines and body, Geist Mono UPPERCASE for nav, buttons and labels; white page with thin guide lines, square corners; orange (#F26B2C) for the main action, charcoal for the secondary (see `../HOLDFAST-SPEC.md` §9).
- Build app screens from v3 components and tokens without waiting for per-screen frames; screen content and states come from [screens.md](screens.md).
- Earlier "SO v2" and "UI v1" pages are superseded; don't build from them.
- Order status uses a **Bryntum Gantt**: the W08 settlement fan-out first, then the other placements (window → price watch → signal → lock → capture fan-out → payout → shipping).
