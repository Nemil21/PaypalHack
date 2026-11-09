# 00 — Research Shortlist (merged from reports 01–06)

Compiled 2026-11-09 from five parallel research reports plus the Cloudflare gap analysis. Each idea links to its full section (evidence, quotes, repos, competitors). **All evidence claims come from those reports.** Items they marked UNVERIFIED stay unverified here.

## The big findings that change our plan

1. **Our original lineup is already being built by other teams.** Public GitHub repos tagged for this hackathon (private ones are invisible, so these counts are minimums):
   - About 14 spend-limit, "allowance" or agent-firewall repos, including two named `leash`.
   - About 15 escrow repos (hold the money, AI verifies the work, then capture), plus 35 or more milestone-escrow repos.
   - **54** "paypal dispute" repos, plus about 10 dispute-defense repos.
   - About 11 shopping agents (`cartpilot` ×2).
   - 15 or more invoice and collections agents, 25 or more bill splitters, and 20 or more scam shields.
   → **Leash, Errand, the Hybrid, Pulse/Dispute Autopilot, Ledgerline, Agent Toll as a headline, and Outcome Escrow are all crowded.** [01 §meta, 02 §0.3, 03 §landscape, 05 #5]
2. **Buyer-side agentic demand is weak.**
   - OpenAI scaled back ChatGPT Instant Checkout (March 2026).
   - Only 3.5% of 14,865 x402 listings get repeat use, about $3–6k a month across the whole registry. [01]
   - The real pain is with merchants and service providers absorbing the costs agents create.
3. **PayPal constraints every idea must respect:**
   - **Agent Toolkit gaps:** no Payouts, no authorize/capture/void, no dispute `provide-evidence` / `make-offer`. These need direct REST calls. [01, 03]
   - **Fees:** standard US checkout costs 3.49% + $0.49, and API Payouts cost $0.25 each. Anything priced per call needs a **prepaid ledger with batch settlement**. [01]
   - **Authorization holds:** a 3-day honor period, with reauthorization possible from day 4 to day 29. [01, 03]
   - **Creating disputes by API** needs the `DISPUTE_CREATE` scope from a PayPal account manager, and **downloading buyer evidence** needs `DOCUMENTS_DISPUTES_DOWNLOAD`. Fallback: open disputes by hand in the sandbox buyer account, then use the sandbox-only `require-evidence` / `adjudicate` endpoints to finish the lifecycle on camera. [03] *(Report 05 says buyer credentials suffice. Report 03 read the set-up doc in detail, so trust 03 and test early.)*
   - **Subscriptions** has no metered-usage endpoint. [01]
   - **The hosted sandbox MCP server is flaky** (agent-toolkit issue #119), so run the toolkit locally. [05]
   - **Transaction Search** lags up to 3 hours and covers at most 31 days per query. [05]
   - **No API reads or controls a consumer's own PayPal wallet**, so consumer products route money through our app. [04]
4. **Research gap:** Reddit and X were blocked to server-side fetching. Reddit evidence came via archives and mirrors (Arctic Shift, sentinel snapshots, RSS), and X wasn't searched directly. **Next step: browse Reddit and X through the user's real browser to confirm the top picks.**

## Ranked shortlist (uncrowded, evidenced, buildable)

Scores are the source report's hackathon-fit score (1–5). "Crowding" is the risk that another team builds the same thing, from the GitHub scans.

| Rank | Idea | One line | Evidence | Crowding | Complexity | Best lane | Natural sponsor | Source |
|---|---|---|---|---|---|---|---|---|
| 1 | **ProofLoop** | Chain-of-custody for shipped items: pack-out photos → live-capture claims → AI comparison → PayPal refund, offer or evidence | **Strong** (Signifyd: "damaged item" abuse +158% in 2025; Forter: AI damage claims "fastest-growing" abuse; eBay seller reports, Jan 2026) | **Medium** (0 hackathon repos; 2 tiny Shopify apps, no PayPal) | Medium | Most Impactful / Best Demo | AG Grid | [03 #1](03-merchants-fraud.md) |
| 2 | **SafeHandoff** | Hold-then-release payment for local-pickup deals: authorize → QR scan at meetup captures it → payout to the seller's Venmo; no-show voids; AI flags scam scripts | **Strong** (r/venmo $1,900 reversal; r/Scams stolen iPhone, 56 pts / 72 comments; Ask HN on selling safely; PayPal excludes in-person pickup) | Low–Med | Medium | Most Impactful / PayPal + AI | Channel3 (price comps), Render | [04 #1](04-consumers-communities.md) |
| 3 | **Mandate Receipts** | Merchant-side "intent ledger": verify an AI agent's signed purchase mandate, void out-of-scope orders before capture, win "my agent didn't do that" disputes | Medium (industry voices: Worldpay, FraudBeat; few seller complaints yet) | **Low–Med** (0 repos) | Med–High | **Agentic Commerce** | Channel3, AG Grid | [03 #2](03-merchants-fraud.md) |
| 4 | **QuoteBond** | Refundable "look fees" for AI agents hammering quote and availability endpoints, credited back when they book | Strong industry-side (OAG: up to 200k searches per ticket; one agent pulled 881k fares in a session; HN 569 + 355 pts on bot costs), thin from small operators | **Low** (0 repos) | Medium | Agentic Commerce / Most Creative | AG Grid, Render | [01 #1](01-agentic-payments.md) |
| 5 | **LicenseLeak** | Detects brands running a creator's video in ads past the license, then bills via PayPal invoice plus a "keep running" subscription; agent negotiates | Medium (Digiday Aug 2025 / Jan 2026, UGC newsletter; no Reddit counts) | **Low** (0 repos; adjacent `usagepass`) | Med–High (**ad-library coverage risk:** Meta API may return commercial ads for the EU only, UNVERIFIED) | Most Creative | Bryntum (license windows), Render | [02 #1](02-freelancers-creators.md) |
| 6 | **PayPal Integration Doctor** | AI generates payment scenarios from your code, runs them in the real sandbox, delays, duplicates and reorders webhooks, and opens fix PRs (+ SDK migration) | **Strong** (many sandbox-webhook threads, Stack Overflow, no `stripe listen` equivalent, missing idempotency in agent-toolkit #98; deprecated SDK ≈137k weekly npm installs) | Low–Med | Med–High | PayPal + AI | **APIMatic** (strongest fit of all), Render | [05 #1+#2](05-developers-b2b.md) |
| 7 | PayScore | Opt-in payment-behavior bureau from real PayPal invoice timestamps; sets each client's terms (deposit hold, partial payment) | Medium | Low–Med | Medium | Most Impactful | AG Grid | [02 #2](02-freelancers-creators.md) |
| 8 | Mutual Aid Treasurer / CareKitty | Agent triages aid requests and pays out by Venmo with a public ledger / a family care fund for an aging parent | Strong (Open Collective Foundation shutdown, ~600 groups; r/AgingParents 555 pts) | Med | Medium | Most Impactful | AG Grid | [04 #2–3](04-consumers-communities.md) |
| 9 | Marketplace Dispute & Abuse Copilot | Cross-seller dispute waves on multiparty platforms | Strong (HN 291 pts) | Med (dispute bucket crowded) | Med–High | Most Impactful | AG Grid | [05 #3](05-developers-b2b.md) |
| 10 | Agent Toll (PayPal-funded 402 meter) | Agents pay per call for APIs and MCP tools; no crypto | Medium (supply-push) | Medium | Medium | Agentic Commerce | Render | [01 #3](01-agentic-payments.md), [06](06-cloudflare-gap-analysis.md) |

**Demoted, crowded or weak:** spend firewalls and allowances, shopping agents, dispute copilots, milestone escrow, invoice and collections bots, bill splitters, scam shields, the runaway-loop circuit breaker, Hold-to-Cash (sandbox can't simulate holds), reconciliation (PayPal shipped QuickBooks sync in June 2026), Second Signature (scams run on rails PayPal can't intercept), TiltPool, remittances, and teen money. Reasons are in each report's "Dropped" section.

## Ways to combine ideas (one product, not two half-products)
- **Mandate Receipts + QuoteBond = "AgentGate," a merchant's front door for AI-agent traffic.** Charge agents that only look, verify buyers' mandates, void out-of-scope orders, and win agent disputes. It's the strongest single **Agentic Commerce** story on the seller side, where the research says the real pain is. Scope risk is high, so QuoteBond's ledger is the cut line.
- **ProofLoop + SafeHandoff** share "verified handoff of a physical item." **Keep them separate** (shipped vs local pickup, merchant vs consumer); together they would muddy the pitch.
- **LicenseLeak + Crew Waterfall:** when a brand pays the usage fee, collaborators (editor, manager) get their split by Payouts automatically.

## Recommended lineup (4 builders, 4 different lanes, 4 different main sponsors)

| Builder | Submission | Lead HM lane | Main sponsor | Backup sponsors |
|---|---|---|---|---|
| 1 | **AgentGate** (Mandate Receipts, with QuoteBond look fees if time allows) | Best Use of Agentic Commerce | Channel3 (buyer agent's product search) | APIMatic, Render |
| 2 | **ProofLoop** | Most Impactful | AG Grid (claims grid, "money saved" widgets) | APIMatic, Render |
| 3 | **LicenseLeak** | Most Creative | Bryntum (license windows with "still live past expiry" overlays) | APIMatic, Render |
| 4 | **SafeHandoff** *or* **PayPal Integration Doctor** | PayPal + AI / Best Demo | Render (Workflows: honor-period timers or scenario runs) · Integration Doctor is APIMatic's strongest fit | APIMatic |

**Choosing slot 4:**
- **SafeHandoff** has the stronger consumer story, a Venmo demo, and real Reddit evidence. Production would need PayPal's partner-only delayed-disbursement feature, but sandbox works fine.
- **Integration Doctor** speaks directly to PayPal's developer-relations judges and is the only idea where APIMatic is central rather than incidental. It's weaker on "commerce."
- Recommendation: SafeHandoff, unless the slot-4 builder is a strong backend or dev-tools engineer.

## Before locking: verify these first (day-1 spikes)
1. **ProofLoop / Mandate Receipts / SafeHandoff:** open a sandbox dispute by hand from the buyer account, then run `require-evidence` → `provide-evidence` → `adjudicate`. Confirm `process-chargeback` works without extra scopes. [03]
2. **SafeHandoff:** confirm a `payee` works with `intent=AUTHORIZE`, and that Payouts to a Venmo recipient works in sandbox. [04]
3. **QuoteBond / Agent Toll:** check vaulted-payment, merchant-initiated top-ups in sandbox. Fallback: a manual top-up approval in the demo. [01]
4. **LicenseLeak:** confirm Meta Ad Library API coverage outside the EU from the official docs (it returned 403 to the agent). If it's EU-only, plan a demo with one real EU lookup plus seeded fixtures, stated honestly in the README. [02]
5. **All:** Reddit and X confirmation via the user's browser (see finding 4). Then rerun the gstack questions (doc 12) on this new lineup.
