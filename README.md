# Holdfast

> **Name your price. Your agent holds it.**
> Shoppers back a product with a PayPal hold. Brands clear overstock privately into money that's already waiting. Agents bid, code clears, PayPal settles.

Holdfast is our entry for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). It is a private, held-bid market for brand overstock. Shoppers' AI agents place real PayPal authorization holds. A deterministic pay-your-bid auction picks the winners. PayPal captures each winner's own bid, releases everyone else, and pays the brand.

> [!IMPORTANT]
> **This README is a draft written while the app is still being built.** Every feature line below shows its real status. Sections marked **TODO** depend on tickets that have not merged yet and get a final pass after the feature freeze (03:00 PST, Nov 12). Search this file for `TODO` to find them all. The full build plan is in [`docs/spec/`](docs/spec/README.md) and [`docs/tickets/INDEX.md`](docs/tickets/INDEX.md).

- **Live demo:** TODO: deployed Render URL (HF-048a Blueprint is merged; URL to be added after the first deploy)
- **Video:** TODO: public YouTube link (HF-050b)
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

Demo brand: the fictional **Aurel Audio**, listing **Aurel A7 Wireless — Midnight** (retail $279, 300 units, floor $199). The dollar figures below are the spec's target demo numbers. The seed script (HF-045) will print the real ones.

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
| `packages/core` | Config validation, Postgres pool, `loadClearInput`; later `landHold`, audit, PayPal client and stub, settlement tasks | Partly merged (HF-001, HF-005); the rest is TODO |
| `apps/api` | Fastify server: `/healthz`, `/api/healthz`; later REST, MCP, webhooks and the agent loop | Skeleton merged (HF-001, HF-048a) |
| `apps/workflows` | Render Workflows service; a `hello` task now, settlement tasks in HF-030b | Hello-world merged (HF-048a) |
| `apps/web` | React + Vite brand console and shopper pages | Placeholder only; TODO: HF-007 |
| `db/` | SQL migrations and a checksummed migration runner | Merged (HF-002) |
| `spikes/` | Day-one PayPal sandbox spikes S1–S4 | Merged |

Design and decisions: [`docs/HOLDFAST-SPEC.md`](docs/HOLDFAST-SPEC.md) (one-file spec), [`docs/spec/`](docs/spec/README.md) (data model, API, screens, features 01–19), [`docs/review/SUMMARY.md`](docs/review/SUMMARY.md) (engineering review, decisions D1–D19).

## PayPal APIs used

We call PayPal's REST APIs directly because the PayPal Agent Toolkit doesn't cover authorize, capture, void or Payouts. Every call type has a fixed `PayPal-Request-Id`, so retries are idempotent.

| API | How Holdfast uses it | Status |
|---|---|---|
| Orders v2 `intent=AUTHORIZE` | Create the order behind every bid (wallet or card fields) | Proven in day-one spikes S1–S3; app code TODO (HF-004, HF-014a/b) |
| Orders v2 authorize | Turn the approved order into a hold (`authorizations[0].id`) | Spikes; app TODO (HF-014a/b) |
| Payments v2 capture | Capture a winner's own bid with `final_capture: true` | Spikes; app TODO (HF-029) |
| Payments v2 void | Release losing, cancelled and price-dropped holds | Spikes; app TODO (HF-029, HF-016, HF-042a) |
| Vault + merchant-initiated (MIT) stored credential | Agents place and raise held bids without the shopper present, within the mandate | Spike S2; app TODO (HF-014b, HF-017a, HF-018) |
| Payouts v1 | Pay the brand the net amount, then poll the batch status | Spike S4; app TODO (HF-032, HF-034) |
| Webhooks: verify signature | Verify and reconcile authorization, capture and payout events | TODO (HF-033) |
| Shipment tracking | Attach carrier and tracking number to each won order | TODO (HF-059b, P1) |
| Log in with PayPal | Brand sign-in | TODO (HF-010) |
| Negative testing (`PayPal-Mock-Response`) | Inject one `INSTRUMENT_DECLINED` capture to show promotion (`DEMO_MODE` only) | Spike S3; app TODO (HF-046) |

Day-one spike results (2026-11-10, `node spikes/paypal-spikes.mjs all`, US sandbox business account):

- **S1:** 10 holds on one card, 6 `final_capture`s, 4 voids.
- **S2:** a card vaulted on the first hold, then a merchant-initiated hold from the `vault_id` with no buyer present.
- **S3 (local):** 50 parallel holds settled with one injected decline caught on the right bid. A capture replayed with the same request id returned the same capture id.
- **S4:** a payout to the sandbox brand account was created.

TODO: add the S7 spike pack results (card fields, wallet, replays, a ≈ $50k payout funded by captures) when HF-063 merges.

## AI models used and how

TODO: final model id. The app reads it from `ANTHROPIC_MODEL` (Anthropic Claude API, tool use). Record the deployed value here.

| Where | What the model does | What it can't do | Status |
|---|---|---|---|
| **Buyer agent** (HF-039) | Claude with tool use: searches Channel3, suggests a ceiling, places, raises and cancels held bids | Exceed the shopper's mandate (max price, total hold cap, allowed products, expiry). The server enforces it, not the prompt. | TODO |
| **Brand agent: recommendation** (HF-051a/b, P1) | Explains the clearing trade-off ("Clear 240, cutoff $219 vs the liquidation quote") and answers questions about the book | Clear, change prices or move money (read-only tools) | TODO |
| **Brand agent: live-round nudges** (HF-036b) | Phrases the truthful "the cutoff is $X, raise to stay in?" message. Template text is the fallback (HF-036a). | Change the cutoff number, which code computes | TODO |
| **Claude Desktop over MCP** (HF-043, HF-044a/b) | Outside agents bid through our MCP server (`get_book`, `place_bid`, `cancel_bid`, `my_bids`, `raise_bid`) under the shopper's mandate and token | Anything outside those five tools | TODO |

The price watcher, the clearing engine and settlement are plain deterministic code, not AI.

## Sponsor tools

We list a sponsor only when the product uses it and we can show where.

| Sponsor | Used for | Evidence | Status |
|---|---|---|---|
| **PayPal** | The whole money path: holds, capture, void, vault, Payouts, webhooks | `spikes/paypal-spikes.mjs`; `PAYPAL_*` config in `packages/core/src/config.ts`; the app client is HF-004 | Spikes merged; app TODO |
| **Render** | Web service, paid Postgres, Workflows service | [`render.yaml`](render.yaml), [`docs/deploy/render.md`](docs/deploy/render.md), `apps/workflows` | Blueprint merged (HF-048a). TODO: confirm the live deploy. |
| **Render Workflows** for settlement | Settlement fan-out, one task per bid | HF-030b | TODO. Settlement runs in-process (`SETTLEMENT_RUNNER=inprocess`) until HF-030b's smoke on Render is green. We'll say here which path settled the demo. |
| **AG Grid** (Enterprise grid, AG Charts, AG Studio KPI row) | Brand console: bids grid, demand curve, KPI row | HF-007, HF-023, HF-024, HF-025 | TODO: no AG Grid dependency is merged yet |
| **Channel3** | Product search, exact-match gate, live offers, price-change webhooks | HF-009, HF-042a/b | TODO: not merged yet |
| APIMatic PayPal Context Plugin | Build aid for the PayPal client | Claimed only if the HF-004 PR keeps plugin evidence | TODO: not claimed yet |
| Bryntum Gantt | Settlement fan-out and order timeline | Claimed only if HF-060 ships | TODO: not claimed yet |

We don't use the other sponsor tools (Elastic, KERNEL, Postman, Astropods, Zapier).

## Testing access

> **TODO (HF-006, HF-045, HF-048a/b, HF-014b):** none of this works until those tickets merge and the app is deployed. Final pass after the freeze.

- **Deployed URL:** TODO.
- **One-click demo logins (`DEMO_MODE=true` on Render):** **Sign in as demo shopper** or **Sign in as demo brand**. No account needed.
- **Pay with PayPal (sandbox):** a sandbox buyer account. The email and password go in the Devpost testing-instructions field only, never in this repo.
- **Pay by card (sandbox):** the labelled **Use sandbox test card** button, or a test card from the PayPal Developer Dashboard's card generator.
- **Claude Desktop over MCP:** sign in as the demo shopper, then **Developer → Connect an agent**. Create a token and paste the config into Claude Desktop (server URL `https://<host>/mcp`).
- **Stays live through judging:** a daily `demo:refresh` Render cron resets and reseeds a judge book through Dec 21 (HF-048b).

## Run it locally

What works on a clean clone today is the server skeleton, the migrations and the tests. Seeding and the UI are TODO.

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

- `PAYPAL_MODE=stub` uses the `FakePayPal` stub (HF-004, TODO). Until it merges, nothing calls PayPal anyway. For real sandbox holds set `PAYPAL_MODE=sandbox` with your own sandbox app's client id and secret. Card holds and Payouts need a **US** sandbox business account.
- **AG Grid:** without `AG_GRID_LICENSE_KEY` the Enterprise grid still runs, with a watermark.
- **Claude:** the buyer agent, brand agent and nudge phrasing need `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. Everything else runs without them.
- **Channel3:** `CHANNEL3_MODE=live` needs `CHANNEL3_API_KEY` (and `CHANNEL3_WEBHOOK_SECRET` for the price watcher).
- Database integration tests: `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:db`.
- TODO (HF-045): `npm run seed:demo` (Aurel Audio, a deterministic book, labelled SIM bidders).
- TODO (HF-007): the web app is served from the same origin at `/`.

**Deploy:** Render Blueprint ([`render.yaml`](render.yaml)). Follow the runbook in [`docs/deploy/render.md`](docs/deploy/render.md): paid instances only, migrations on pre-deploy, never seed on deploy.

## What's real and what's simulated

| Item | Real or simulated | How it's labelled | Status |
|---|---|---|---|
| Foreground shopper holds (offer page, buyer agent, Claude Desktop over MCP) | **Real** PayPal sandbox holds, captures and voids | – | TODO (HF-014a/b, HF-039, HF-044a) |
| Brand payout | **Real** sandbox Payout, funded from real COMPLETED captures only | – | TODO (HF-032) |
| Volume bidders | **Simulated** shoppers placed by our seed script. Their holds are real sandbox card holds. | Grey **SIM** chip in every grid and list; KPI tiles show "incl. $X simulated" | TODO (HF-045) |
| No-hold fallback bids | Seeded only if the sandbox rate-limits holds. They have no PayPal authorization, are excluded from Clear (D8), and the seed aborts if more than 10% fall back. | "SIM (no hold)" | TODO: record the count from the final seed here (expected 0) |
| Channel3 price-drop event | Live webhook if it fires during recording; otherwise a replayed recorded fixture | "replayed event" (`replayed=true`) | TODO (HF-042a/b) |
| Injected capture decline | PayPal negative testing (`test_decline`) to show promotion | `DEMO_MODE` only | TODO (HF-046) |
| Live rounds in the video | Real raises, time-lapsed | Labelled in the video | TODO (HF-050b) |

## Honest limits

- **Merchant of record.** In the sandbox, Holdfast is the merchant of record and pays the brand through PayPal Payouts. The payout covers only real, COMPLETED captures and is funded from the captured winners' money. The **production path** is PayPal multiparty: the brand as merchant, our fee via `platform_fees`, and delayed disbursement. That needs approved-partner status and isn't built.
- **Released holds** may show as pending at the shopper's bank for a few days.
- **Card holds** in the browser use PayPal card fields, or the labelled sandbox test-card button (a server-side test-card hold). Raw sandbox card numbers are used only by the seed script.
- **Wallet holds** (a PayPal account) need the buyer's approval in a browser.
- **Reauthorization is untested.** The whole timeline stays inside PayPal's 3-day card-hold guarantee: a bidding window of at most 48 h, live rounds of at most 6 h, then Clear within 6 h. Clear releases any hold older than 66 h and refuses to run if a winner's hold would be that old.
- **Simulated liquidity.** Most bidders in the demo are simulated and labelled SIM.
- **Render Workflows:** TODO (HF-030b). State whether Workflows or the in-process coordinator settled the demo.
- **PayPal webhooks:** TODO (HF-033). State whether webhooks are live and verified, or whether the payout and order polls are the only path.
- **Not built (production path, described only):** disputes and refunds (refund the capture, claw back from the next payout), brand API keys, multiparty `platform_fees`.

## Features and status

Status as of this draft (Nov 11, 2026). **Merged** = on `main`. **In review** = PR open. **Not started / in progress** = no merged code yet. Final statuses (shipped / partial / not demo-ready) come after the freeze.

| Area | Feature | Tickets | Pri | Status |
|---|---|---|---|---|
| Foundation | Monorepo, config validation, shared contracts | HF-001 | P0 | **Merged** |
| Foundation | Postgres schema and checksummed migrations | HF-002 | P0 | **Merged** |
| Money | `landHold`, transitions, locks, void keys, lease | HF-003a | P0 | In review |
| Money | Audit pairs, tenancy, idempotency, webhook dedupe | HF-003b | P0 | Not started |
| PayPal | REST client + `FakePayPal` stub | HF-004 | P0 | Not started |
| PayPal | Spike pack S7 (card fields, wallet, replays, large payout) | HF-063 | P0 | In review |
| Clearing | Pure pay-your-bid `clear()`, eligibility, `loadClearInput` | HF-005 | P0 | **Merged** |
| Clearing | Clear transaction (locks, outbox, reserve, hold-age release) | HF-027 | P0 | Not started |
| Clearing | Clear confirmation modal | HF-028 | P0 | Not started |
| Auth | Sessions, anonymous shopper, `DEMO_MODE` logins, CSRF, rate limits | HF-006 | P0 | Not started |
| Auth | Brand sign-in with Log in with PayPal | HF-010 | P0 | Not started |
| Brand | Admin brand verification and publish guard | HF-011a | P0 | Not started |
| Brand | Brand verification onboarding | HF-011b | P0 | Not started |
| Brand | Listings API: create, publish, cancel, quantity | HF-012a, HF-012b | P0 | Not started |
| Brand | Create listing wizard | HF-013 | P0 | Not started |
| Brand console | Web scaffold, design tokens, AG Grid / AG Studio, demo hub | HF-007 | P0 | Not started |
| Brand console | Book and simulate API | HF-022 | P0 | Not started |
| Brand console | Console shell and AG Studio KPI row | HF-023 | P0 | Not started |
| Brand console | Demand curve (AG Charts) and quantity slider | HF-024 | P0 | Not started |
| Brand console | Bids grid (AG Grid Enterprise) | HF-025 | P0 | Not started |
| Brand console | Brand overview dashboard | HF-026 | P0 | Not started |
| Realtime | SSE event bus | HF-008 | P0 | Not started |
| Shopper | Bid service core: `placeBid`, vault holds, one live bid, mandate cap | HF-014a | P0 | Not started |
| Shopper | Card-fields and PayPal wallet holds | HF-014b | P0 | Not started |
| Shopper | Cancel bid, my bids, bid detail | HF-016 | P0 | Not started |
| Shopper | Offer page | HF-019 | P0 | Not started |
| Shopper | Hold confirmation, error states, my bids, bid timeline | HF-020 | P0 | Not started |
| Shopper | Raise bid (atomic hold swap) | HF-018 | P0 | Not started |
| Mandates | Mandates core and API / form | HF-017a, HF-017b | P0 | Not started |
| Settlement | `settleBid` capture / void with retries | HF-029 | P0 | Not started |
| Settlement | In-process settlement coordinator | HF-030a | P0 | Not started |
| Settlement | Render Workflows settlement adapter | HF-030b | P0 | Not started (hello-world task merged in HF-048a) |
| Settlement | Inline promotion at the promoted bidder's own bid | HF-031 | P0 | Not started |
| Settlement | Brand payout and fee math | HF-032 | P0 | Not started (fee helper merged in HF-001) |
| Settlement | PayPal webhooks: verify, dedupe, reconcile | HF-033 | P0 | Not started |
| Settlement | Crons: sweeper, `reconcile:holds`, settlement kick, payout poll | HF-034 | P0 | Not started |
| Settlement | Settlement live view | HF-035 | P0 | Not started |
| Live rounds | Rounds engine: basic and full (timer, soft close, Claude phrasing) | HF-036a, HF-036b | P0 | Not started |
| Live rounds | Rounds console: basic and full | HF-037a, HF-037b | P0 | Not started |
| Live rounds | Buyer rounds: raise from bid page; auto-raise runner | HF-038a, HF-038b | P0 | Not started |
| Agents | Buyer agent loop, chat API and tools | HF-039 | P0 | Not started |
| Agents | Buyer agent chat UI | HF-041 | P0 | Not started |
| Agents | Brand agent recommendation card | HF-051a | P1 | Not started |
| Agents | Brand agent "Ask about this book" panel | HF-051b | P1 | Not started |
| Channel3 | Client, fixtures, product search, exact-match gate | HF-009 | P0 | Not started |
| Channel3 | Price watcher: labelled replay and auto-void | HF-042a | P0 | Not started |
| Channel3 | Price watcher: live webhook, outage banner, nightly poll | HF-042b | P0 | Not started |
| MCP | MCP tokens and connect page | HF-043 | P0 | Not started |
| MCP | MCP server (`get_book`, `place_bid`, `cancel_bid`, `my_bids`) | HF-044a | P0 | Not started |
| MCP | MCP `raise_bid` | HF-044b | P0 | Not started |
| Demo | Demo seed (Aurel Audio, SIM bidders) | HF-045 | P0 | Not started |
| Demo | Demo scripts: `sim:stream`, `demo:decline`, `demo:reset` | HF-046 | P0 | Not started |
| Ops | Cross-tenant tests, secret scan, security checklist | HF-047 | P0 | Not started |
| Ops | Render deploy: web, Postgres, env, `/healthz`, Workflows hello-world | HF-048a | P0 | **Merged** |
| Ops | Render crons, daily `demo:refresh`, judge book | HF-048b | P0 | Not started |
| Submission | README and licence | HF-049 | P0 | This draft |
| Submission | Devpost draft | HF-050a | P0 | **Merged** |
| Submission | Demo video and submission | HF-050b | P0 | Not started |
| Intents | Multi-product intents and the move rule | HF-052 | P1 | Not started |
| Mandates | Auto-roll (merchant-initiated re-bids) | HF-053 | P1 | Not started |
| Notifications | In-app bell; email, web push | HF-054a, HF-054b | P1 | Not started |
| Growth | Embed widget and share links | HF-055 | P1 | Not started |
| Brand | Brand settings: DNS verification, team invites, retailer allowlist | HF-056 | P1 | Not started |
| Growth | Marketing landing page | HF-057 | P1 | Not started |
| Ops | Ops / audit screen, health, nightly capture reconcile | HF-058 | P1 | Not started |
| Shopper | Won page | HF-059a | P1 | Not started |
| Brand | Payouts and reports; shipment tracking | HF-059b | P1 | Not started |
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
