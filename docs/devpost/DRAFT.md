# Devpost draft: Holdfast (HF-050a)

Paste-ready text for the Devpost submission form at https://paypalaihackathon.devpost.com/. One section per form field. Copy the text **inside** each `<!-- paste:start -->` / `<!-- paste:end -->` pair; everything outside those pairs is a note for us.

HF-050b status (Nov 12): every `[[verify]]` marker is cleared. Each ticket is merged on `main`, and the claims were checked against the code, the stub seed and the HF-046 rehearsal test; lines that overstated the build were reworded. The CP5 dry run on the deployed URL ([VIDEO.md](VIDEO.md) runbook §1) is the last check that they work there. The `[[fill]]` markers left need the live deploy, an account or a person: URLs, the model id, sandbox credentials, the settlement runner and webhook status, the video link and the screenshots. Credentials go into the Devpost form only, so run the `--final` check on the text copied back from Devpost, not on this file.

Markers we must clear before the final submit (HF-050b); `node scripts/check-devpost-draft.mjs --final` fails while any remain:

- ``: the claim depends on that ticket. Keep the line if the ticket shipped and works in the deployed demo. Otherwise reword it as partial or remove it (README "honest limits" is the source of truth, HF-049).
- Every product claim carries a `[[verify]]` marker. Unmarked lines are design rationale, day-one spike results (labelled as such), lessons or roadmap.
- `[[fill: …]]`: a value we don't have yet (URL, model id, seed numbers, sandbox login).

Copy rules (checked by the script):

- **D14 pay-your-bid copy.** Each winner pays exactly their own bid. The cutoff is the lowest winning bid, and nobody else pays it. Never "one fair price" or "everyone pays the cutoff".
- **D15 fictional brand.** The demo brand is Aurel Audio / Aurel A7. Don't name real retailers, brands or competitors. The tools we use (PayPal, Claude, Channel3, AG Grid, Render, …) are fine.
- **No secrets.** Sandbox buyer passwords and card numbers go only into the Devpost form, never into this file.

---

## Project name

<!-- paste:start -->
Holdfast
<!-- paste:end -->

## Elevator pitch (Devpost limit: 200 characters)

<!-- paste:start -->
A private, held-bid market for brand overstock. Shoppers' AI agents bid with PayPal authorization holds; code clears the book; PayPal captures each winner's own bid and pays the brand.
<!-- paste:end -->

## About the project (Markdown)

<!-- paste:start -->
## Inspiration

Every quarter, consumer brands are left holding end-of-life stock: last season's headphones, last year's tent. They have two bad options. A liquidator pays pennies on the dollar. A public markdown breaks the brand's minimum advertised price (MAP) policy, undercuts every retailer that carries the product, and teaches shoppers to wait for the next sale.

MAP rules cover **advertised** prices, so a private sale to committed buyers is allowed. Private price negotiation has already facilitated hundreds of millions of dollars in sales. Earlier "name your price" marketplaces failed because bids were free, so they meant nothing, and sellers wouldn't supply.

Two things are new. **AI agents make bidding effortless for shoppers**, and **PayPal authorization holds make every bid real money**. Put them together and a brand can see committed demand before it sells a single unit.

## What it does

Holdfast is a private, held-bid book for brand overstock. Pitch line: **agents negotiate by bidding; code clears; PayPal settles.**

1. **The shopper's agent bids with real money.** A shopper tells our buyer agent (Claude) "I'd buy the Aurel A7 if it hit $229." The agent looks the product up on **Channel3** (canonical product, live offers, cheapest public price), suggests a ceiling, and the shopper approves once. **PayPal places an AUTHORIZE hold for $229: held, not charged.**
2. **The agent protects its owner.** We subscribe to Channel3 price changes for the product. If an authorized retailer drops below the bid and the shopper left "Release if cheaper elsewhere" on, the hold is **voided automatically** and the shopper gets a link to the cheaper offer.
3. **Any agent can bid.** Our **MCP server** (`get_book`, `place_bid`, `cancel_bid`, `my_bids`, `raise_bid`) lets outside agents such as Claude Desktop place held bids into the same book under the shopper's mandate.
4. **The brand sees a private book.** The brand console, built on **AG Grid** and **AG Studio**, shows the held-demand curve, a live bids grid and a quantity slider that compares recovery against the liquidation quote. A **brand agent** explains the trade-off, for example "Clear 240 units, cutoff $219: $54.1k recovered vs $9.1k from the liquidator, with no public price change."
5. **Live rounds.** Optionally, the brand runs live rounds of up to 6 hours. New bids stop, bidders below the cutoff are told the real cutoff, and their agents may raise within their mandate.
6. **Code clears.** Clearing is a deterministic pay-your-bid call auction. The top N bids win and **each winner pays exactly their own final bid**, never more than they approved. The cutoff is just the lowest winning bid. Agents advise; code decides who wins and what is charged.
7. **PayPal settles.** A settlement coordinator captures each winner's hold at their own bid (`final_capture`), voids every loser, and, if a capture is declined, **promotes the next reserve bidder at their own bid** inside the same transaction (at most 3 tries per unit). It then sends a **PayPal Payout** to the brand from the captured money, net of our fee. The coordinator runs in the web process, or on **Render Workflows** as one `settleListing` run with a child `settleBid` task per settlement, chosen by a flag.
8. **The shopper sees the truth.** "You won at your bid of $229. Charged $229." Losers see "Released. Your bank may show it as pending for a few days."

Every money action writes an audit row with its PayPal IDs. Simulated bidders are labelled **SIM** everywhere.

## How we built it

- **Backend:** Node 20, TypeScript, Fastify and Zod, on Postgres. A single `landHold` path is the only way a bid becomes HELD. It re-checks the listing and the mandate under row locks, so a late hold can never dangle after Clear, Cancel or Expire.
- **PayPal (direct REST, sandbox).** We call the REST APIs directly because the Agent Toolkit doesn't cover authorize, capture, void or Payouts:
  - Orders v2 `intent=AUTHORIZE`, via the PayPal wallet or card fields
  - Authorize, capture (`final_capture`), void, and authorization lookup for reconciliation
  - Vault and merchant-initiated stored-credential holds, so agents can place and raise bids without the shopper present
  - Payouts to the brand, with batch status polling
  - Webhook signature verification and reconciliation
  - Order shipment tracking
  - Log in with PayPal for brands
  - A fixed `PayPal-Request-Id` per call type, so every retry is idempotent
  - Negative testing (`PayPal-Mock-Response: INSTRUMENT_DECLINED`) to inject the decline that shows promotion
- **AI:**
  - **Claude** (Anthropic API, model `[[fill: ANTHROPIC_MODEL value]]`) with tool use runs the **buyer agent**. It searches Channel3, proposes a ceiling, and places, raises and cancels held bids. The server enforces the mandate (max price, total hold cap, allowed products, expiry), so the model can't exceed it.
  - The **brand agent** explains the clearing recommendation and phrases live-round nudges.
  - **Claude Desktop** bids from outside our app through our **MCP server** (`@modelcontextprotocol/sdk`).
  - Agents choose what to bid. Only plain code decides who wins and what is charged, and only the backend calls PayPal.
- **Channel3:** product search, a two-stage exact-match gate when a brand creates a listing, live offers for price anchoring, and price-change webhooks for auto-void.
- **AG Grid Enterprise, AG Charts and AG Studio:** the brand console (book, demand curve, bids grid, KPI row, clearing simulation).
- **Render:** web service, Postgres, a daily cron that refreshes the judge book through judging (`demo:refresh`), and **Render Workflows** for the settlement fan-out. The background jobs (sweeper, hold reconciliation, settlement kick, payout poll, live-round tick) run in the web process under Postgres advisory locks.
- **Realtime:** server-sent events push new bids, raises and settlement progress to the console.

## Challenges we ran into

- **Holds vs. time.** PayPal guarantees card holds for 3 days, so the timeline is absolute: a bidding window of up to 48 h, live rounds of up to 6 h, then Clear within 6 h. Clear is refused if any hold is older than 66 h.
- **Races around money.** A raise racing Clear could have charged a shopper twice. We fixed it with one lock order (listing, then mandate, then bids), a single `landHold` path, one live bid per shopper per listing (a partial unique index) and conditional state transitions. Any 0-row update rolls back.
- **Idempotency everywhere.** Each PayPal call type has a fixed request id (`authz-<bidId>`, `void-<bidId>`, the settlement id for a capture, the payout attempt id for a payout). Replaying a capture with the same request id returned the same capture id in our day-one spikes.
- **Failure in the middle of settlement.** Declined captures promote the next reserve bidder inline. The payout runs exactly once after every capture is final.
- **Sandbox quirks.** Card holds and Payouts need a US sandbox business account. Proven in day-one spikes, before any product code: 10 holds on one buyer, partial `final_capture`, a vaulted card plus a merchant-initiated hold, 50 parallel holds with an injected decline, and a payout to the brand.

## Accomplishments that we're proud of

- An agentic-commerce loop where agents **actually move money**: real PayPal sandbox holds, captures, voids and a payout to the brand, not a mocked checkout.
- A clearing rule that is simple, fair and auditable. Each winner pays their own bid, and nobody pays more than they approved.
- Outside agents (Claude Desktop over MCP) and our own buyer agent trade in the same book under the same guardrails.
- An honest demo: simulated bidders are labelled SIM, replayed price events are labelled, and the README lists what is real and what is simulated.

## What we learned

- Authorization holds are an underused primitive. A hold turns a cheap signal ("I'd buy at $229") into committed demand a brand can plan around.
- LLM agents are great at deciding *what* to bid. They should never decide *who wins* or *what gets charged*: that belongs in deterministic code with database guarantees.

## What's next for Holdfast

- **Production money path:** PayPal multiparty (partner referrals, `platform_fees`, delayed disbursement) so the brand is merchant of record and we take a platform fee, instead of us paying out from captured funds.
- **A storefront plug-in** for consumer-electronics and outdoor brands, starting with end-of-life SKUs.
- **Pre-season demand books:** held bids become production orders.
- A **neutral intent exchange for AI shopping agents**: any agent can bring committed, money-backed demand to any brand.

## Testing access

- **Live demo:** [[fill: deployed Render URL (HF-048a)]]. Click **Sign in as demo shopper** or **Sign in as demo brand**; no account is needed (`DEMO_MODE`). The demo book is refreshed daily through Dec 21 (`demo:refresh`).
- **Pay with PayPal (sandbox):** sandbox buyer `[[fill: sandbox buyer email]]`, password `[[fill: sandbox buyer password; type it into the Devpost form only]]`.
- **Pay by card (sandbox):** use the labelled **Use sandbox test card** button, or a card made with the credit card generator in the PayPal developer dashboard (sandbox).
- **Claude Desktop over MCP:** sign in as the demo shopper, open **Connect an agent** (`/developer`), create a token and paste the generated config into Claude Desktop.
- **Run it locally:** see the README. Clone, `cp .env.example .env`, set `PAYPAL_MODE=stub` and `CHANNEL3_MODE=fixtures` for a run with no keys, then `npm ci`, `npm run build`, `npm run migrate`, `npm run seed:demo`, `npm start`.

## What's real and what's simulated

- **Real:** PayPal sandbox holds, captures, voids and the brand payout; Channel3 API calls; Claude agent tool calls; the MCP bid from Claude Desktop.
- **Simulated, labelled SIM:** the volume bidders that fill the book. Their holds are real sandbox card holds placed by our seed script, not by real people.
- **Replayed, labelled:** a price-drop event, if Channel3 doesn't fire a live price change during the recording.
- **Demo decline:** injected through PayPal negative testing to show promotion. It only works in `DEMO_MODE`.

## Honest limits

- In the sandbox **we are the merchant of record** and pay the brand through PayPal Payouts. The payout amount comes only from real, COMPLETED captures, net of our fee. In our sandbox spikes, captured card money was not yet payable an hour later, so the sandbox merchant account is pre-funded to cover the payout. Production would use PayPal multiparty with `platform_fees` and delayed disbursement, which needs approved-partner status.
- Released holds may show as pending at the shopper's bank for a few days. We say so in the product.
- Browser card holds use PayPal card fields. Raw sandbox card numbers are used only by the seed script and the labelled test-card button. PayPal wallet holds need the shopper's approval in a browser.
- Reauthorizing holds older than 3 days is untested, so the timeline keeps every capture inside the 3-day guarantee.
- Render Workflows status: [[fill: "settlement runs on Render Workflows" or "the in-process coordinator runs settlement; the Workflows adapter is <status>" (HF-030b)]].
- PayPal webhooks status: [[fill: live and verified, or the polling fallback (HF-033)]].

## Built during the hackathon

Holdfast is a new project started for the PayPal AI Hackathon in November 2026. All code in the repository was written during the submission period.
<!-- paste:end -->

## Built with (tags)

Type each tag into the "Built with" field. Keep only what the final build actually uses.

<!-- paste:start -->
paypal, paypal-orders-v2, paypal-payments-api, paypal-payouts, paypal-vault, paypal-webhooks, log-in-with-paypal, claude, anthropic, claude-desktop, mcp, channel3, ag-grid, ag-charts, ag-studio, render, render-workflows, typescript, node.js, fastify, zod, postgresql, react, vite, tailwindcss, server-sent-events
<!-- paste:end -->

Conditional tags (HF-050b, Nov 12): `log-in-with-paypal` is in (HF-010 merged). `apimatic` stays out: no APIMatic plugin note or trailer on `main` (M26). `bryntum` stays out: HF-060 hasn't merged. Recheck both before submitting.

## "Try it out" links

<!-- paste:start -->
[[fill: deployed Render URL (HF-048a)]]
[[fill: public GitHub repo URL]]
<!-- paste:end -->

## Video demo link

<!-- paste:start -->
[[fill: public YouTube URL, under 3:00 (HF-050b)]]
<!-- paste:end -->

## Image gallery and thumbnail

Upload 3:2 images showing only Aurel Audio (D15) and no real retailer names or logos: the brand console (AG Grid book and demand curve), the buyer agent chat with a hold, Claude Desktop placing a bid over MCP, the settlement view, and the PayPal sandbox merchant view with captures and the payout. Capture them during the HF-050b recording. [[fill: screenshots]]
