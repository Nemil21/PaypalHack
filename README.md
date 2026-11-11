# Holdfast

> **Name your price. Your agent holds it.**
> Shoppers back a product with a PayPal hold. Brands clear overstock privately into money that's already waiting. Agents bid, code clears, PayPal settles.

Holdfast is our entry for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). It is a private, held-bid market for brand overstock. Shoppers' AI agents place real PayPal authorization holds. A deterministic pay-your-bid auction picks the winners. PayPal captures each winner's own bid, releases everyone else, and pays the brand.

> [!IMPORTANT]
> **Status at the feature freeze (03:00 PST, Nov 12, 2026).** Every feature line below shows whether it is merged on `main`. The few **TODO**s left need the live deploy (URL, model id, which settlement runner and webhook path ran the demo) and are filled in at submission. Search this file for `TODO` to find them. The full build plan is in [`docs/spec/`](docs/spec/README.md) and [`docs/tickets/INDEX.md`](docs/tickets/INDEX.md).

- **Live demo:** TODO: deployed Render URL (HF-048a Blueprint is merged; URL to be added after the first deploy)
- **Video:** TODO: public YouTube link, added at submission (HF-050b; shot list and runbook in [`docs/devpost/VIDEO.md`](docs/devpost/VIDEO.md))
- **Licence:** [MIT](LICENSE)

---

## The problem

- **Brands sit on end-of-life inventory every quarter**, like last season's headphones or last year's tent. Their options are bad:
  - Liquidators pay pennies on the dollar. Our demo quote is $38 a unit for $279 headphones.
  - A public markdown breaks the brand's minimum advertised price (MAP) policy, undercuts every retailer, and teaches shoppers to wait for sales.
- **Shoppers have nowhere to say "I'd buy it at $229."** Wishlists and price alerts carry no commitment, so brands ignore them.
- **Earlier "name your price" sites failed** because bids were free, so sellers didn't trust them.

**What's new:** a PayPal authorization hold makes every bid real money (held, not charged). An AI agent makes bidding effortless and protects the shopper. The brand sees committed demand before it sells a unit. MAP rules cover *advertised* prices, so a private sale to committed buyers doesn't break them.

## How it works

Demo brand: the fictional **Aurel Audio**, listing **Aurel A7 Wireless — Midnight** (retail $279, 300 units, floor $199). The seed script (`npm run seed:demo`, HF-045) prints the demo numbers: for 240 units the cutoff is $219 and the 240 winners average $225.55, so $54,133 gross and $49,261.03 net to the brand, against $9,120 from the liquidator.

1. **Bid.** A shopper tells the buyer agent "I'd buy at $229." The agent confirms the exact product through Channel3 and shows the cheapest public price. The shopper approves once with PayPal (wallet or card fields). Result: an `AUTHORIZE` hold of $229, held but not charged. One live bid per shopper per listing.
2. **Protect.** With "Release if cheaper elsewhere" on (the default), a Channel3 price drop below the bid voids the hold automatically and links the cheaper store.
3. **Book.** The brand sees a private book: held demand, a demand curve, a bids grid and a quantity slider that compares recovery with the liquidation quote.
4. **Live rounds (optional).** New bids stop. Bidders below the cutoff are told the real cutoff, and their agents may raise within the shopper's mandate.
5. **Clear.** The brand presses **Clear 240**. Code ranks the bids and the top 240 win. **Each winner pays exactly their own bid; the cutoff is the lowest winning bid.** Nobody pays more than they approved, and nobody else pays the cutoff.
6. **Settle.** One task per bid: capture each winner's own bid (equal to their hold, `final_capture`) and void each loser. If a capture is declined, the next reserve bidder wins that unit **at their own bid** (at most 3 tries per unit).
7. **Pay.** A PayPal Payout sends the brand the captured total minus a 9% success fee.
8. **Tell.** The winner sees "You won at your bid of $229. Charged $229." Everyone else sees "Released, never charged. Your bank may show it as pending for a few days."

**Rule:** agents choose *what* to bid. Plain code decides *who wins and what is charged*. Only the backend calls PayPal.

## Architecture

```
Shopper web/mobile ─┐
Brand console ──────┼─> Render web service (Node 20 / TypeScript, Fastify) ──> Postgres 16
Claude Desktop ─────┤     REST /api · MCP /mcp · SSE · agent loop (Claude API)
Channel3 webhooks ──┤     price watcher (plain code, no AI)
PayPal webhooks ────┘     │ Clear
                          └─> settlement coordinator (in-process; Render Workflows adapter)
                              capture / void / promote → Payout
                                         │
                       PayPal REST (Orders v2, Payments v2, Vault, Payouts v1, Tracking)
```

| Path | What it is | Status |
|---|---|---|
| `packages/shared` | Zod contracts, money helpers, fee math, listing phases, `ListingEvent` union, the pure pay-your-bid `clear()` and eligibility predicate | Merged (HF-001, HF-005) |
| `packages/core` | Config validation, Postgres pool, `landHold`, transitions and locks, audit, the PayPal client and `FakePayPal` stub, Channel3 client, clearing, settlement, payouts, crons | Merged |
| `apps/api` | Fastify server: REST `/api`, MCP `/mcp`, SSE, PayPal and Channel3 webhooks, the agent loop, demo and ops CLIs | Merged |
| `apps/workflows` | Render Workflows service: `hello`, and the settlement tasks `settleListing` / `settleBid` | Merged (HF-048a, HF-030b) |
| `apps/web` | React + Vite brand console (AG Grid, AG Charts, AG Studio) and shopper pages, served from the same origin | Merged |
| `db/` | SQL migrations and a checksummed migration runner | Merged (HF-002) |
| `spikes/` | Day-one PayPal sandbox spikes S1–S4 | Merged |

Design and decisions: [`docs/HOLDFAST-SPEC.md`](docs/HOLDFAST-SPEC.md) (one-file spec), [`docs/spec/`](docs/spec/README.md) (data model, API, screens, features 01–19), [`docs/review/SUMMARY.md`](docs/review/SUMMARY.md) (engineering review, decisions D1–D19).

## PayPal APIs used

We call PayPal's REST APIs directly because the PayPal Agent Toolkit doesn't cover authorize, capture, void or Payouts. Every call type has a fixed `PayPal-Request-Id`, so retries are idempotent.

| API | How Holdfast uses it | Status |
|---|---|---|
| Orders v2 `intent=AUTHORIZE` | Create the order behind every bid (wallet or card fields) | Built (HF-004, HF-014a/b); spikes S1–S3, S7 |
| Orders v2 authorize | Turn the approved order into a hold (`authorizations[0].id`) | Built (HF-014a/b) |
| Payments v2 capture | Capture a winner's own bid with `final_capture: true` | Built (HF-029) |
| Payments v2 void | Release losing, cancelled and price-dropped holds | Built (HF-029, HF-016, HF-042a) |
| Vault + merchant-initiated (MIT) stored credential | Agents place and raise held bids without the shopper present, within the mandate | Built (HF-014b, HF-017a, HF-018); spikes S2, S7 |
| Payouts v1 | Pay the brand the net amount, then poll the batch status | Built (HF-032, HF-034); spikes S4, S7 |
| Webhooks: verify signature | Verify and reconcile authorization, capture and payout events | Built (HF-033) |
| Shipment tracking | Attach carrier and tracking number to each won order | Built (HF-059b) |
| Log in with PayPal | Brand sign-in | Built (HF-010) |
| Negative testing (`PayPal-Mock-Response`) | Inject one `INSTRUMENT_DECLINED` capture to show promotion (`DEMO_MODE` only) | Built (HF-046); spike S3 |

Day-one spike results (2026-11-10, `node spikes/paypal-spikes.mjs all`, US sandbox business account):

- **S1:** 10 holds on one card, 6 `final_capture`s, 4 voids.
- **S2:** a card vaulted on the first hold, then a merchant-initiated hold from the `vault_id` with no buyer present.
- **S3 (local):** 50 parallel holds settled with one injected decline caught on the right bid. A capture replayed with the same request id returned the same capture id.
- **S4:** a payout to the sandbox brand account was created.
- **S5 (Channel3 price webhook on Render, HF-042b):** not run yet. The live webhook, signature check and dedupe are built and tested locally; the Render check is manual ([runbook](docs/deploy/render.md#s5-channel3-price-webhook-reaches-render-hf-042b)). Until it passes, the price-drop beat uses the labelled replay.

- **S7 (HF-063, Nov 11):** card fields and wallet holds both authorize and vault; replay behaviour of every call type recorded; vaulted MIT holds from both; 300 holds in 46 s with 0 rate limits. **The ≈ $50k payout funded only by captures failed:** captured card money was not payable within about an hour (`INSUFFICIENT_FUNDS`), while a $1,000 payout succeeded. So the sandbox merchant balance is pre-funded for the demo payout. Full results: [`spikes/s7-results.md`](spikes/s7-results.md).

## AI models used and how

TODO: final model id. The app reads it from `ANTHROPIC_MODEL` (Anthropic Claude API, tool use). Record the deployed value here.

| Where | What the model does | What it can't do | Status |
|---|---|---|---|
| **Buyer agent** (HF-039) | Claude with tool use: searches Channel3, suggests a ceiling, places, raises and cancels held bids | Exceed the shopper's mandate (max price, total hold cap, allowed products, expiry). The server enforces it, not the prompt. | Merged |
| **Brand agent: recommendation** (HF-051a/b, P1) | Explains the clearing trade-off ("Clear 240, cutoff $219 vs the liquidation quote") and answers questions about the book | Clear, change prices or move money (read-only tools) | Merged |
| **Brand agent: live-round nudges** (HF-036b) | Phrases the truthful "the cutoff is $X, raise to stay in?" message. Template text is the fallback (HF-036a). | Change the cutoff number, which code computes | Merged |
| **Claude Desktop over MCP** (HF-043, HF-044a/b) | Outside agents bid through our MCP server (`get_book`, `place_bid`, `cancel_bid`, `my_bids`, `raise_bid`) under the shopper's mandate and token | Anything outside those five tools | Merged |

The price watcher, the clearing engine and settlement are plain deterministic code, not AI.

## Sponsor tools

We list a sponsor only when the product uses it and we can show where.

| Sponsor | Used for | Evidence | Status |
|---|---|---|---|
| **PayPal** | The whole money path: holds, capture, void, vault, Payouts, webhooks | `packages/core/src/paypal/`, `spikes/` | Merged |
| **Render** | Web service, paid Postgres, Workflows service | [`render.yaml`](render.yaml), [`docs/deploy/render.md`](docs/deploy/render.md), `apps/workflows` | Merged (HF-048a/b). TODO: confirm the live deploy. |
| **Render Workflows** for settlement | Settlement fan-out, one task per bid | HF-030b, `apps/workflows` | Adapter merged (HF-030b). Settlement runs in-process (`SETTLEMENT_RUNNER=inprocess`) unless HF-030b's smoke on Render is green. TODO: say here which path settled the demo. |
| **AG Grid** (Enterprise grid, AG Charts, AG Studio KPI row) | Brand console: bids grid, demand curve, KPI row | `ag-grid-enterprise`, `ag-charts-enterprise`, `ag-studio` in `apps/web` (HF-007, HF-023–HF-025) | Merged |
| **Channel3** | Product search, exact-match gate, live offers, price-change webhooks | `packages/core` Channel3 client (HF-009), price watcher (HF-042a/b) | Merged; S5 on Render pending |
| APIMatic PayPal Context Plugin | Build aid for the PayPal client | No plugin evidence on `main` | Not claimed |
| Bryntum Gantt | Settlement fan-out and order timeline | HF-060 not merged | Not claimed |

We don't use the other sponsor tools (Elastic, KERNEL, Postman, Astropods, Zapier).

## Testing access

- **Deployed URL:** TODO: added at submission.
- **One-click demo logins (`DEMO_MODE=true` on Render):** **Sign in as demo shopper** or **Sign in as demo brand**. No account needed.
- **Pay with PayPal (sandbox):** a sandbox buyer account. The email and password go in the Devpost testing-instructions field only, never in this repo.
- **Pay by card (sandbox):** the labelled **Use sandbox test card** button, or a test card from the PayPal Developer Dashboard's card generator.
- **Claude Desktop over MCP:** sign in as the demo shopper, then **Connect an agent** (`/developer`). Create a token and paste the config into Claude Desktop (server URL `https://<host>/mcp`).
- **Stays live through judging:** a daily `demo:refresh` Render cron resets and reseeds a judge book through Dec 21 (HF-048b).

## Run it locally

A clean clone runs the whole app with no keys: the PayPal stub, recorded Channel3 responses, the seeded Aurel Audio book and the web app.

**Needs:** Node 20+ (`.nvmrc`), Docker or any Postgres 16.

```sh
git clone https://github.com/Nemil21/PaypalHack.git holdfast && cd holdfast
npm ci

# Postgres 16 on localhost:55432
docker run -d --rm --name holdfast-pg -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:55432:5432 postgres:16-alpine

cp .env.example .env    # .env is git-ignored; never commit it
```

Edit `.env` for a keyless run on the PayPal stub and Channel3 fixtures:

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
SESSION_SECRET=<output of: openssl rand -hex 32>
PAYPAL_MODE=stub          # FakePayPal; no sandbox calls
PAYPAL_CLIENT_ID=stub     # required at boot; any value works in stub mode
PAYPAL_CLIENT_SECRET=stub
CHANNEL3_MODE=fixtures    # recorded Channel3 responses, no API key
DEMO_MODE=true            # demo sign-in buttons and labelled demo aids
```

Then:

```sh
npm run build
npm run migrate           # applies db/migrations; re-running is a no-op
npm start                 # or `npm run dev` for watch mode; listens on :3000
curl -s localhost:3000/healthz       # {"status":"ok","db":"ok"}
curl -s localhost:3000/api/healthz   # paypalMode "stub", settlementRunner "inprocess"
npm test                  # unit tests (vitest)
```

Notes:

- `PAYPAL_MODE=stub` uses the `FakePayPal` stub (HF-004). For real sandbox holds set `PAYPAL_MODE=sandbox` with your own sandbox app's client id and secret. Card holds and Payouts need a **US** sandbox business account.
- **AG Grid:** without `AG_GRID_LICENSE_KEY` the Enterprise grid still runs, with a watermark.
- **Claude:** the buyer agent, brand agent and nudge phrasing need `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. Everything else runs without them.
- **Channel3:** `CHANNEL3_MODE=live` needs `CHANNEL3_API_KEY` (and `CHANNEL3_WEBHOOK_SECRET`, the `whsec_…` signing secret of the Channel3 webhook endpoint, for `POST /api/webhooks/channel3`).
- Database integration tests: `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:db`.
- `PAYPAL_MODE=stub npm run seed:demo` seeds Aurel Audio: a deterministic book of labelled SIM bidders with stub holds, and prints the video numbers. The stub holds live in the seed's process, so use it for the console, the book and the numbers; real capture and void need the sandbox.
- The web app is served from the same origin at `/`. Open `/demo` for the demo sign-ins.

**Deploy:** Render Blueprint ([`render.yaml`](render.yaml)). Follow the runbook in [`docs/deploy/render.md`](docs/deploy/render.md): paid instances only, migrations on pre-deploy, never seed on deploy.

## What's real and what's simulated

| Item | Real or simulated | How it's labelled | Status |
|---|---|---|---|
| Foreground shopper holds (offer page, buyer agent, Claude Desktop over MCP) | **Real** PayPal sandbox holds, captures and voids | – | Merged (HF-014a/b, HF-039, HF-044a) |
| Brand payout | **Real** sandbox Payout. The amount comes only from real COMPLETED captures; the sandbox merchant balance is pre-funded because captured money wasn't payable within an hour (S7) | – | Merged (HF-032) |
| Volume bidders | **Simulated** shoppers placed by our seed script. Their holds are real sandbox card holds. | Grey **SIM** chip in every grid and list; KPI tiles show "incl. $X simulated" | Merged (HF-045) |
| No-hold fallback bids | Seeded only if the sandbox rate-limits holds. They have no PayPal authorization, are excluded from Clear (D8), and the seed aborts if more than 10% fall back. | "SIM (no hold)" | 0 in the stub seed; TODO: record the recording seed's count |
| Channel3 price-drop event | Live webhook if it fires during recording; otherwise a replayed recorded fixture | "replayed event" (`replayed=true`) | Live webhook, outage banner and nightly poll built (HF-042b); S5 on Render pending |
| Injected capture decline | PayPal negative testing (`test_decline`) to show promotion | `DEMO_MODE` only | Merged (HF-046) |
| Live rounds in the video | Real raises, time-lapsed | "Time-lapsed" label on screen and in the voiceover | HF-050b ([`VIDEO.md`](docs/devpost/VIDEO.md)) |

## Honest limits

- **Merchant of record.** In the sandbox, Holdfast is the merchant of record and pays the brand through PayPal Payouts. The payout amount comes only from real, COMPLETED captures. In the sandbox, captured card money wasn't payable within an hour (spike S7), so the merchant balance is pre-funded to cover it. The **production path** is PayPal multiparty: the brand as merchant, our fee via `platform_fees`, and delayed disbursement. That needs approved-partner status and isn't built.
- **Released holds** may show as pending at the shopper's bank for a few days.
- **Card holds** in the browser use PayPal card fields, or the labelled sandbox test-card button (a server-side test-card hold). Raw sandbox card numbers are used only by the seed script.
- **Wallet holds** (a PayPal account) need the buyer's approval in a browser.
- **Reauthorization is untested.** The whole timeline stays inside PayPal's 3-day card-hold guarantee: a bidding window of at most 48 h, live rounds of at most 6 h, then Clear within 6 h. Clear releases any hold older than 66 h and refuses to run if a winner's hold would be that old.
- **Simulated liquidity.** Most bidders in the demo are simulated and labelled SIM.
- **One web instance.** Rate limits (REST 60/min per user, MCP 30/min per token, buyer agent 20 turns/min, 3 magic links/min per email), used magic-link tokens, SSE fan-out and background jobs live in the one web process. That is correct only with a single instance, which is how the hackathon deploy runs. Several instances would need a shared store (Postgres or Redis) behind the same limiter interface.
- **Shopper sign-in** is an email magic link, sent through Resend when `RESEND_API_KEY` is set and printed to the server console otherwise (HF-054b). `DEMO_MODE` adds "Sign in as demo brand / demo shopper" for judges.
- **Render Workflows:** the adapter is merged (HF-030b). TODO at submission: state whether Workflows or the in-process coordinator settled the demo.
- **PayPal webhooks:** verification and reconciliation are merged (HF-033); the payout poll and the sweeper's hold checks run either way. TODO at submission: state whether `PAYPAL_WEBHOOK_ID` is registered on the deploy, so webhooks are live.
- **Not built (production path, described only):** disputes and refunds (refund the capture, claw back from the next payout), brand API keys, multiparty `platform_fees`.

## Features and status

Status at the freeze (Nov 12, 2026). **Merged** = on `main`. **In review** = PR open. **Not started** = no merged code.

| Area | Feature | Tickets | Pri | Status |
|---|---|---|---|---|
| Foundation | Monorepo, config validation, shared contracts | HF-001 | P0 | **Merged** |
| Foundation | Postgres schema and checksummed migrations | HF-002 | P0 | **Merged** |
| Money | `landHold`, transitions, locks, void keys, lease | HF-003a | P0 | **Merged** |
| Money | Audit pairs, tenancy, idempotency, webhook dedupe | HF-003b | P0 | **Merged** |
| PayPal | REST client + `FakePayPal` stub | HF-004 | P0 | **Merged** |
| PayPal | Spike pack S7 (card fields, wallet, replays, large payout) | HF-063 | P0 | **Merged** |
| Clearing | Pure pay-your-bid `clear()`, eligibility, `loadClearInput` | HF-005 | P0 | **Merged** |
| Clearing | Clear transaction (locks, outbox, reserve, hold-age release) | HF-027 | P0 | **Merged** |
| Clearing | Clear confirmation modal | HF-028 | P0 | **Merged** |
| Auth | Sessions, anonymous shopper, `DEMO_MODE` logins, CSRF, rate limits | HF-006 | P0 | **Merged** |
| Auth | Brand sign-in with Log in with PayPal | HF-010 | P0 | **Merged** |
| Brand | Admin brand verification and publish guard | HF-011a | P0 | **Merged** |
| Brand | Brand verification onboarding | HF-011b | P0 | **Merged** |
| Brand | Listings API: create, publish, cancel, quantity | HF-012a, HF-012b | P0 | **Merged** |
| Brand | Create listing wizard | HF-013 | P0 | **Merged** |
| Brand console | Web scaffold, design tokens, AG Grid / AG Studio, demo hub | HF-007 | P0 | **Merged** |
| Brand console | Book and simulate API | HF-022 | P0 | **Merged** |
| Brand console | Console shell and AG Studio KPI row | HF-023 | P0 | **Merged** |
| Brand console | Demand curve (AG Charts) and quantity slider | HF-024 | P0 | **Merged** |
| Brand console | Bids grid (AG Grid Enterprise) | HF-025 | P0 | **Merged** |
| Brand console | Brand overview dashboard | HF-026 | P0 | **Merged** |
| Realtime | SSE event bus | HF-008 | P0 | **Merged** |
| Shopper | Bid service core: `placeBid`, vault holds, one live bid, mandate cap | HF-014a | P0 | **Merged** |
| Shopper | Card-fields and PayPal wallet holds | HF-014b | P0 | **Merged** |
| Shopper | Cancel bid, my bids, bid detail | HF-016 | P0 | **Merged** |
| Shopper | Offer page | HF-019 | P0 | **Merged** |
| Shopper | Hold confirmation, error states, my bids, bid timeline | HF-020 | P0 | **Merged** |
| Shopper | Raise bid (atomic hold swap) | HF-018 | P0 | **Merged** |
| Mandates | Mandates core and API / form | HF-017a, HF-017b | P0 | **Merged** |
| Settlement | `settleBid` capture / void with retries | HF-029 | P0 | **Merged** |
| Settlement | In-process settlement coordinator | HF-030a | P0 | **Merged** |
| Settlement | Render Workflows settlement adapter | HF-030b | P0 | **Merged** |
| Settlement | Inline promotion at the promoted bidder's own bid | HF-031 | P0 | **Merged** |
| Settlement | Brand payout and fee math | HF-032 | P0 | **Merged** |
| Settlement | PayPal webhooks: verify, dedupe, reconcile | HF-033 | P0 | **Merged** |
| Settlement | Crons: sweeper, `reconcile:holds`, settlement kick, payout poll | HF-034 | P0 | **Merged** |
| Settlement | Settlement live view | HF-035 | P0 | **Merged** |
| Live rounds | Rounds engine: basic and full (timer, soft close, Claude phrasing) | HF-036a, HF-036b | P0 | **Merged** |
| Live rounds | Rounds console: basic and full | HF-037a, HF-037b | P0 | **Merged** |
| Live rounds | Buyer rounds: raise from bid page; auto-raise runner | HF-038a, HF-038b | P0 | **Merged** |
| Agents | Buyer agent loop, chat API and tools | HF-039 | P0 | **Merged** |
| Agents | Buyer agent chat UI | HF-041 | P0 | **Merged** |
| Agents | Brand agent recommendation card | HF-051a | P1 | **Merged** |
| Agents | Brand agent "Ask about this book" panel | HF-051b | P1 | **Merged** |
| Channel3 | Client, fixtures, product search, exact-match gate | HF-009 | P0 | **Merged** |
| Channel3 | Price watcher: labelled replay and auto-void | HF-042a | P0 | **Merged** |
| Channel3 | Price watcher: live webhook, outage banner, nightly poll | HF-042b | P0 | **Merged** |
| MCP | MCP tokens and connect page | HF-043 | P0 | **Merged** |
| MCP | MCP server (`get_book`, `place_bid`, `cancel_bid`, `my_bids`) | HF-044a | P0 | **Merged** |
| MCP | MCP `raise_bid` | HF-044b | P0 | **Merged** |
| Demo | Demo seed (Aurel Audio, SIM bidders) | HF-045 | P0 | **Merged** |
| Demo | Demo scripts: `sim:stream`, `demo:decline`, `demo:reset` | HF-046 | P0 | **Merged** |
| Ops | Cross-tenant tests, secret scan, security checklist | HF-047 | P0 | **Merged** |
| Ops | Render deploy: web, Postgres, env, `/healthz`, Workflows hello-world | HF-048a | P0 | **Merged** |
| Ops | Render crons, daily `demo:refresh`, judge book | HF-048b | P0 | **Merged** |
| Submission | README and licence | HF-049 | P0 | **Merged** |
| Submission | Devpost draft | HF-050a | P0 | **Merged** |
| Submission | Demo video and submission | HF-050b | P0 | Runbook in [`VIDEO.md`](docs/devpost/VIDEO.md); recording and submission are manual |
| Intents | Multi-product intents and the move rule | HF-052 | P1 | **Merged** |
| Mandates | Auto-roll (merchant-initiated re-bids) | HF-053 | P1 | **Merged** |
| Notifications | In-app bell; email, web push | HF-054a, HF-054b | P1 | **Merged** |
| Growth | Embed widget and share links | HF-055 | P1 | **Merged** |
| Brand | Brand settings: DNS verification, team invites, retailer allowlist | HF-056 | P1 | **Merged** |
| Growth | Marketing landing page | HF-057 | P1 | **Merged** |
| Ops | Ops / audit screen, health, nightly capture reconcile | HF-058 | P1 | **Merged** |
| Shopper | Won page | HF-059a | P1 | **Merged** |
| Brand | Payouts and reports; shipment tracking | HF-059b | P1 | **Merged** |
| Brand console | Bryntum Gantt: settlement fan-out, then order timeline | HF-060 | P1 | Not started |
| Brand | Brand mobile alert and clear approval | HF-061 | P1 | Not started |

**Production path (described, not built):** disputes and refunds, brand API keys, PayPal multiparty `platform_fees` with delayed disbursement.

## How we differ

| | Liquidator | Public markdown | Free "name your price" bids | Hold-based auction demos | **Holdfast** |
|---|---|---|---|---|---|
| Brand recovery | Pennies on the dollar | Retail minus discount, for everyone | Unreliable: bids are free | Varies | Each winner's own held bid |
| Public price change / MAP risk | None | Yes | None | Usually public | **None:** private book, fills never advertised |
| Bid is real money | – | – | No | Yes | **Yes:** PayPal hold, captured only if it wins |
| Shopper protection | – | – | – | Rarely | Agent voids the hold if any store goes cheaper |
| Who decides the winner | Liquidator | – | Seller | Code | Deterministic pay-your-bid code; agents only bid |
| Outside agents can bid | No | No | No | Rarely | Yes, over MCP, under the shopper's mandate |
| Brand sees demand before selling | No | No | Weakly | Sometimes | Private demand curve backed by held money |

## Repository notes

- `docs/` holds the hackathon context pack, product spec, research and tickets. The team's Claude Code skill setup moved to [`skill/README.md`](skill/README.md).
- Third-party material is **not** covered by our MIT licence. That includes everything under `docs/_sources/` (copies of PayPal and Devpost pages, kept for reference) and the PayPal docs quoted in `docs/`. It belongs to its owners. We will remove it before the repository goes public.
- Secrets live in `.env` (git-ignored) and in the Render dashboard, never in the repository. A full-history secret scan (HF-047) runs before the repository goes public.

## Licence

[MIT](LICENSE) © 2026 Holdfast contributors. Applies to the source code in this repository, excluding the third-party material noted above.
