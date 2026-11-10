---
name: paypalhack
description: Rules, deadlines, judging criteria, submission requirements, prizes, sponsor tools (AG Grid, APIMatic, Astropods, Bryntum, Channel3, Elastic, KERNEL, Postman, Render, Zapier) and PayPal developer context (sandbox, JS SDK v6, Agent Toolkit, MCP server, Pay Later, agentic commerce) for the PayPal AI Hackathon 2026. Use whenever working on our PayPal AI Hackathon project — planning features, writing PayPal or AI integration code, choosing sponsor tools, checking eligibility or rules, preparing the README/demo video/Devpost submission, or answering any question about the hackathon.
---

# PaypalHack — PayPal AI Hackathon team context

Everything the team agent needs about the PayPal AI Hackathon (Devpost, 2026). The key facts are below; full details live in `references/` — read the matching file before answering detailed questions or writing integration code.

## Hard facts (memorize)

- **Deadline: Thu Nov 12, 2026, 12:00 pm PST** (20:00 UTC · 3:00 pm EST · Fri 1:30 am IST). Submissions lock after; no edits.
- Judging Dec 1–15, 2026. Winners ~Dec 21, 2026.
- Theme: "Build what's next with PayPal and AI." **No tracks.** Anything goes.
- **Only fundamental requirement: meaningfully use BOTH PayPal (free sandbox is fine) AND AI.** Any AI model/tool works.
- All PayPal services count: PayPal APIs/SDKs, Venmo, Braintree, Xoom, Honey, Zettle, Paidy, Hyperwallet, etc.
- New project, or existing one **significantly updated after Oct 1, 2026** (must explain what changed).
- No team size limit. One Representative submits; teammates join via the Devpost project invite link.
- Ineligible residents include Brazil, Quebec, Russia, Crimea, Cuba, Iran, North Korea, OFAC-sanctioned countries — applies to **every** member. Employees of PayPal/Devpost and of any judge's employer are ineligible.

## Submission requirements (Stage One is pass/fail on these)

1. Text description of features & functionality.
2. **Functional demo**: hosted URL **or** complete setup/run instructions in the repo. Mockups/static/non-functional demos fail.
3. Name the AI tools/models used and explain how.
4. **Public repo** (GitHub/GitLab/Bitbucket): all source, assets, instructions; **open-source LICENSE file detectable in the repo's About section**.
5. **Demo video < 3 min, public on YouTube**, showing it working on its target device; no unlicensed music or third-party trademarks.
6. Testing access free until judging ends: include sandbox buyer login / app login / setup needed to run it. **Never commit secrets** — env vars only.
7. All materials in English.
8. Select every sponsor tool used on the submission form (needed for sponsor prizes).

## Judging (Stage Two): five equally weighted criteria, each scored 1–5

1. **Technological Implementation** — thorough, skillful, non-trivial use of PayPal Developer Platform + AI. (Also the #1 tie-breaker.)
2. **Design** — complete, coherent product experience, not just a PoC.
3. **Potential Impact** — credible, specific real problem for a real audience, actually solved in the demo.
4. **Innovation/Idea** — creative, novel, different from existing concepts.
5. **Presentation** — video shows it working end to end; says what problem, for whom, why it matters.

**Judges are not required to run the project; the video carries a lot of weight.** Judging may include automated AI-driven analysis. Make PayPal and AI impossible to miss in the description, "Built With", and video.

## Prizes ($67,500 cash + $2,250 Render credits)

- Grand: 1st $12,000 · 2nd $8,000 · 3rd $5,000
- Honorable Mentions, $5,000 each: Most Creative · Most Impactful · Best Demo Delivery · Best Use of PayPal + AI · Best Use of Agentic Commerce
- Sponsor: AG Grid $5k/$2k/3×$1k · APIMatic 3×($1k + 6 mo Business) · Bryntum 3×$1k · Channel3 $1.5k · Render $1k/$750/$500 credits
- **Cap per project (Rules §8):** "A project can only win up to one (1) Grand Prize and one (1) Sponsor Prize OR one (1) Honorable Mention Prize and one (1) Sponsor Prize."
  - That makes the per-project ceiling **$17,000** (1st $12k + AG Grid 1st $5k). This number is derived, not stated in the rules. The Honorable Mention route tops out at $10k ($5k + $5k).
  - Grand and Honorable Mention are separate groups, and a project can win one or the other, never both. In practice the Honorable Mentions work as the fallback if a project misses the top 3.
- **Every eligible submission is automatically considered for all Grand and Honorable Mention prizes.** There's no opt-in.
- **Sponsor prizes:** you can use several sponsor tools. You're considered for each one you **use meaningfully and tick on the submission form**, but you can win only one. Channel3 explicitly rejects projects that only reference it without calling the API.
- **Multiple submissions (§4):** allowed if each is "unique and substantially different." Each has its own cap. People may be on several teams and also enter solo (§3).
- Sponsors with **no prize**: Elastic, Astropods, KERNEL, Postman, Zapier. Using them adds zero prize chances.

## Sponsor quick reference (full detail: references/08-sponsor-tools.md)

| Sponsor | Free access | Prize criterion |
|---|---|---|
| AG Grid (AG Studio) | 45-day trial; boilerplate github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate | Polish (custom widgets, theming, layout) + Studio Agent Framework |
| APIMatic | PayPal Context Plugin for coding agents, no extra creds; claim via form | Use the plugin to build the PayPal integration |
| Bryntum | 45-day trial `npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial` | Best Gantt/Scheduler/Calendar use, ideally agent-driven |
| Channel3 | trychannel3.com/developers, code **PAYPAL-HACKATHON-2026** = 20k credits | Must actually call the API/MCP (search, enrichment, recs) |
| Render | $50 credits: credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon | Deploy on Render + use Render Workflows |
| KERNEL | $50: dashboard.onkernel.com/hackathon?code=KERNELDEVPOST2026 | (no prize) cloud browsers for agents |
| Elastic | 14-day trial ela.st/elastic-paypal-hackathon (+30d extension) | (no prize) |
| Zapier | 14-day Pro trial; Zapier MCP includes PayPal | (no prize) |

Watch trial expirations: the demo must keep working until Dec 21.

## PayPal technical essentials (full detail: references/06, 07)

- Sandbox API base: `https://api-m.sandbox.paypal.com` (live `api-m.paypal.com`). Approve test payments at `www.sandbox.paypal.com` with **generated sandbox accounts** (Personal = buyer, Business = seller), not your real login.
- Credentials: Developer Dashboard → Apps & Credentials → Sandbox. Token: `POST /v1/oauth2/token` with Basic auth `CLIENT_ID:SECRET`, `grant_type=client_credentials` (expires ~3–9 h). Client Secret stays server-side.
- JS SDK v6: `<script src="https://www.sandbox.paypal.com/web-sdk/v6/core">`, then `window.paypal.createInstance({ clientId, components: ["paypal-payments"] })`. Components: `paypal-payments`, `venmo-payments`, `googlepay-payments`, `applepay-payments`, `fastlane`, `paypal-messages`. Use v6, not v5.
- **Agent Toolkit** (`npm i @paypal/agent-toolkit`): tools for orders, refunds, invoices (incl. recurring), subscriptions, disputes, shipment tracking, catalog, transactions/insights. Works with Vercel AI SDK, OpenAI Agents SDK, LangChain, MCP. Set `configuration.context.sandbox = true`.
- **MCP server**: local `npx -y @paypal/mcp --tools=all` (env `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX`) or remote `https://mcp.sandbox.paypal.com/sse` | `/http`.
- **PayPal AI Toolkit** plugin for Claude Code: `/plugin install paypal@claude-plugins-official`; commands `/paypal:setup`, `/paypal:doctor`, `/paypal:explain-error`, `/paypal:sandbox`, `/paypal:test-accounts`.
- Negative testing: header `PayPal-Mock-Response: {"mock_application_codes": "INSTRUMENT_DECLINED"}` (sandbox only).
- Agentic commerce (ACP for ChatGPT, UCP for Gemini/Google AI Mode) needs PayPal access approval. For the hackathon, build agents that **actually transact** in sandbox (checkout, pay contractors, agent-to-agent settlement).

## Pay Later rules (full detail: references/09, 10)

- Show messaging only with PayPal's `<paypal-message>` component (JS SDK v6, `paypal-messages`), **rendered in full and unmodified**. Never write or host our own BNPL wording, so the AI must never generate Pay Later copy.
- Not eligible with Reference Transaction / Recurring Payment integrations. It needs a one-time payment integration in the merchant's local currency.
- Only on HTTPS, client-side only (no SSR). Recalculate amounts server-side. Wrap `fetchContent()` in try/catch (unsupported country/currency throws).
- US: Pay in 4 ($10–$2,000, every 2 weeks) and Pay Monthly ($49–$10,000, 3/6/12/24 months, APR 9.99–35.99%, WebBank).

## Our team strategy (updated 2026-11-10)

**Goal: maximize reward.** Every submission is built to compete for **all 3 Grand Prizes AND all 5 Honorable Mentions**, plus up to **5 sponsor prizes** (we can win at most one of them).

### Honorable Mention lanes: the project must be visibly strong in each
Four Honorable Mentions follow from the judging criteria, so scoring high everywhere covers them. **Agentic Commerce is a theme**, so the project must be agentic commerce at its core or it isn't in that race.

| Honorable Mention | Matching criterion | What the project must clearly show |
|---|---|---|
| Best Use of Agentic Commerce | (theme) | An agent that finds, decides, and **pays** in PayPal sandbox, not just recommends |
| Best Use of PayPal + AI | Technological Implementation | Several PayPal APIs used for real (orders, invoices, payouts, refunds, disputes, webhooks), driven by AI tool calls |
| Most Impactful | Potential Impact | A named audience with a concrete, measurable pain |
| Most Creative | Innovation/Idea | Something new: agent-to-agent negotiation and settlement |
| Best Demo Delivery | Presentation | A tight video under 3 minutes showing money actually moving end to end |

Risk: a project built entirely around one theme can beat an all-rounder in that category, so each lane must be clearly strong, not merely present.

### Lead submission: Standing Orders (decided 2026-11-10; replaces the café purchasing agent)
Full spec: references/STANDING-ORDERS.md. API map and risks: references/first-principles/05-gstack-standing-orders.md.
- **One line:** a private "dark pool" for brand overstock. Shoppers' AI agents place bids backed by **PayPal AUTHORIZE holds**; the brand sees committed demand and clears it without posting a public price (no MAP damage).
- **Flow:** buyer agent anchors on Channel3 prices → AUTHORIZE hold → Channel3 price webhook voids the hold if a retailer undercuts → outside agents bid via our MCP server (`get_book`, `place_bid`, `cancel_bid`, `my_bids`) → brand console (AG Grid/AG Studio) with a brand agent → 72-hour uniform-price call auction → Render Workflows captures winners at the clearing price, voids losers, promotes the next bidder on a decline → Payouts to the brand.
- **Pitch line:** "Agents negotiate by bidding; code clears; PayPal settles."
- **Status:** GO (2026-11-10). Spikes S1, S2, S3-local and S4 passed in sandbox (results in references/STANDING-ORDERS.md §6). Use a US sandbox business account. Script: `spikes/paypal-spikes.mjs`. Fallback on the same engine: **Fair Drop**.
- **Second submission:** not locked. Candidates ProofLoop or SafeHandoff (references/research/00-shortlist.md); it must lead a different Honorable Mention lane (Most Impactful).

### Sponsors for Standing Orders
| Sponsor | Prize | Role in the product |
|---|---|---|
| AG Grid / AG Studio | $5k / $2k / 3 × $1k (largest pool) | Brand console: held-demand curve, bids grid, clearing simulation. Polish this most. Licence key in `.env` as `AG_GRID_LICENSE_KEY` (trial ends 24 Dec 2026) |
| Channel3 | $1.5k | Product lookup, live offers, `offer.price.changed` webhooks (real API calls on the critical path) |
| Render | $1k / $750 / $500 credits | Hosting + Render Workflows clearing fan-out (`idempotencyKey`, retries). Avoid free Postgres (expires ~30 days) |
| APIMatic | 3 × $1k + 6 mo Business | PayPal Context Plugin used while building the REST money path (say so in README and video) |
| Bryntum | 3 × $1k | Cut-list item; only if time remains |
| KERNEL, Elastic, Postman, Astropods, Zapier | No prize | Skip |

**Cut order:** reauthorize → multiparty/platform fees → free-form haggling → multi-brand books → Bryntum → pre-season books → Pay Later. Never cut the hold → clear → capture/void → payout path or the AG Grid polish.

**PayPal path:** mostly direct REST, because the Agent Toolkit lacks authorize/capture/void and Payouts. In the sandbox we are merchant of record and pay the brand via Payouts; production would use multiparty (`platform_fees`, delayed disbursement), which needs approved-partner status.

### Execution priorities
1. The video decides a lot (judges may never run it). Record by **Nov 11**; upload to YouTube early.
2. Make PayPal and AI unmissable in the description, "Built With", and video. Name every sponsor tool too.
3. Submit a Devpost draft early and keep editing until **Nov 12, 12:00 pm PST**.
4. Keep the demo, sandbox creds, and sponsor trials and credits alive until **Dec 21**. AG Grid and Bryntum trials last 45 days, so start them after Nov 6 or extend them.
5. A second submission is allowed only if it's substantially different. Give it a different Honorable Mention lane so it doesn't compete with this one. Don't split the team unless both can be polished.

## When writing code for this project

- Default to the sandbox; read credentials from env vars; add `.env.example`, never a real `.env`.
- Make the README cover: problem, persona, features, PayPal APIs used, AI models used, sponsor tools used, architecture, setup/run steps, test sandbox accounts, LICENSE.
- Prefer real end-to-end flows that show a transaction landing in the sandbox seller account. They make strong demo footage.

## Reference files (read as needed)

| File | Read when |
|---|---|
| references/01-hackathon-overview.md | About, prizes table, judges, webinars |
| references/02-dates-timeline.md | Any date/timezone question; post-deadline obligations |
| references/03-official-rules.md | Eligibility, IP, licensing, prize delivery, any rules question |
| references/04-judging-and-submission.md | Submission checklist, video script, judging strategy |
| references/05-faqs-and-updates.md | Official FAQ answers and organizer announcements |
| references/06-paypal-developer-platform.md | Sandbox setup, auth, JS SDK v6, testing, doc links |
| references/07-paypal-ai-and-agent-tools.md | Agent Toolkit tool list & code, MCP config, agentic commerce |
| references/08-sponsor-tools.md | Any sponsor's access, credits, prize criteria, ideas |
| references/09-pay-later-overview.md | Pay Later products/eligibility/compliance |
| references/10-pay-later-integration.md | Pay Later messaging code & full option reference |
| references/11-inspiration-and-strategy.md | Official idea categories, prize strategy |
| references/_sources/ | Raw page snapshots (verbatim rules text, full PayPal docs) |

If something conflicts, the **Official Rules prevail** (references/03 and references/_sources/devpost-rules.txt). For anything time-sensitive, check the live site: https://paypalaihackathon.devpost.com/ (updates, FAQs) or ask on the PayPal Discord https://discord.gg/sJ2G6DyvSK.
