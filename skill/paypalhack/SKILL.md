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
- **Cap per project: 1 Grand OR 1 Honorable Mention, plus 1 Sponsor prize.** Multiple submissions are allowed if substantially different, and each is judged separately.
- Sponsors with **no prize**: Elastic, Astropods, KERNEL, Postman, Zapier.

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
