# 11 — Inspiration & Strategy

Source: Resources page "Inspiration" section (official), plus our own strategy notes (marked as such).

## Official inspiration categories

### AI Agents or Automation
Autonomous agents/workflows that use PayPal to **take action on a user's behalf — not just recommend, but actually transact.**
- An AI agent that shops and checks out for you
- A scheduling assistant that pays contractors automatically when a job is marked complete
- Two agents negotiating and settling a payment between themselves (**agent-to-agent commerce**)

### Money Movement Experiences
A new way to move money that's faster, simpler, or more flexible.
- Send a friend money with just a phone number
- Dashboard of every payment a freelancer received across clients
- Gig-worker payout tool that pays the moment a task is approved
- Auto-split a group dinner bill by scanning a receipt
- Fundraising page splitting one donation across multiple causes in one transaction

### Business Solutions
Tools for merchants, freelancers, creators, platforms, marketplace operators.
- Multi-currency invoicing for freelancers
- Tipping/membership payments for creators
- Marketplace checkout that auto-splits between platform and sellers
- POS add-on for small merchants

### Consumer Experiences
Easier for everyday people to pay, get paid, or track money.
- Budgeting app auto-categorizing PayPal transactions
- "Request money" embedded in a chat app
- Simpler checkout for a niche audience (students, families, seniors)

### Social Impact Ideas
Use PayPal to expand access or drive good.
- Accessible donation platform (screen-reader friendly, multi-language)
- Microloan/fundraising for underbanked users (financial inclusion)
- Nonprofit tool automating recurring donor payouts to field partners
- Neighbors pooling money for a shared community/climate project (block solar co-op, local cleanup fund)

## Strategy notes (ours, not official)

**Prize-stacking target:** 1 Grand/Honorable + 1 Sponsor. Pick one Honorable Mention lane deliberately — **Best Use of Agentic Commerce** and **Best Use of PayPal + AI** are the most aligned with what PayPal judges are pushing.

**Highest-leverage sponsor combos:**
- **APIMatic** — 3 prizes, minimal effort: use the PayPal Context Plugin in Claude Code while building, say so in README + video.
- **Channel3** — fits shopping/agentic-commerce ideas; must make real API calls.
- **AG Grid** — biggest sponsor pool ($10k across 5 winners); needs a polished AG Studio dashboard + Studio Agent Framework.
- **Render** — host the demo (solves the "hosted URL" requirement) + use Render Workflows for agent orchestration.

**What scores (mapped to criteria):**
- Tech Implementation (also tie-breaker #1): multiple PayPal APIs actually exercised in sandbox; AI with tool-calling (Agent Toolkit / MCP); webhooks closing the loop.
- Design: a complete product, not a script — real UI, onboarding, errors handled.
- Impact: named persona + measurable pain.
- Innovation: avoid generic "PayPal chatbot."
- Presentation: video is decisive since judges may not run it.

**Time reality:** Deadline is Nov 12 12:00 PST. Lock scope early, record the video by Nov 11, upload to YouTube early (processing can take hours), submit a draft on Devpost early and keep editing.

**Pay Later angle (if used):** must render PayPal's own `<paypal-message>` unmodified — the AI can choose placement/amount but must never write BNPL copy itself (doc 09).
