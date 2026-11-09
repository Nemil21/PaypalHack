# 08 — Sponsor Tools (all 10)

Source: https://paypalaihackathon.devpost.com/details/<sponsor>. All sponsors answer questions in the **PayPal Discord** (https://discord.gg/sJ2G6DyvSK).
Optional — but using one makes you eligible for its sponsor prize (if it has one). **Select the sponsor tools on the submission form** to be considered.

## Summary

| Sponsor | What it is | Free access | Prize |
|---|---|---|---|
| **AG Grid** | AG Studio embedded analytics (dashboards, charts, grids) + Studio Agent Framework | 45-day trial license | **$5k / $2k / 3×$1k** |
| **APIMatic** | Context Plugin giving coding agents PayPal API context | 1 month Basic (form) | **3× $1k + 6 mo Business** |
| **Astropods** | Agent OS for running AI agents in production | Free account | — |
| **Bryntum** | Gantt, Scheduler, Calendar components | 45-day trial | **3× $1k** |
| **Channel3** | Product data API/MCP: 100M+ products, 25k+ retailers | 20,000 free credits (code) | **$1.5k** |
| **Elastic** | Elasticsearch, vector/hybrid search, Agent Builder | 14-day trial (+30d extension) or local | — |
| **KERNEL** | Cloud browsers for AI agents | $50 credits | — |
| **Postman** | API platform; PayPal collection | Free plan | — |
| **Render** | Cloud hosting + Render Workflows | $50 credits | **$1k / $750 / $500 credits** |
| **Zapier** | Zapier MCP — AI actions across 9,000+ apps incl. PayPal | 14-day Pro trial | — |

---

## AG Grid — https://paypalaihackathon.devpost.com/details/aggrid
AG Grid powers data grids/charts/dashboards for half the Fortune 500. **AG Studio** = embedded analytics / self-serve dashboard component: dashboards + charts + grids in one; devs set guardrails, end users build dashboards without code; built-in data engine, cross-filtering, and the **Studio Agent Framework** (agents build, query, edit dashboards).

**Prize judging:** "covers both what your dashboard looks like and how you build it." Show **polish: custom widgets, theming, layout tools** — not just AG Grid/Charts alone. Try the **Studio Agent Framework**: a custom agent talking to Studio's built-in agents, or a swapped-in harness.

**Ideas (theirs):** storefront analytics (revenue-by-product, refund-rate tiles, geo sales maps); anomaly-alert agent auto-building widgets for refund spikes/failed payments; nonprofit donation dashboard (live PayPal feed, donor leaderboard, progress bars); NL finance agent ("show PayPal revenue by customer segment this month" → live widget); "nudge-bot" that drafts friendly reminders for unpaid invoices with a friendly scoreboard widget.

**Start:** 45-day trial — https://www.ag-grid.com/studio/license-pricing/ · **Boilerplate with AG Studio + PayPal:** https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate
**Docs:** Quick Start https://www.ag-grid.com/studio/react/quick-start/ · Custom Widgets & Theming https://www.ag-grid.com/studio/react/custom-widgets/ · Studio Agent Framework https://www.ag-grid.com/studio/react/ai-agents/ · Blog https://www.ag-grid.com/blog/introducing-the-ag-studio-agent-framework/ · Session "Self-serve dashboards in 30 lines" https://app.livestorm.co/ag-grid/self-service-dashboards-30-lines-of-code · "1 prompt, 88 seconds" blog https://www.ag-grid.com/blog/1-prompt-88-seconds-i-added-a-new-chart-type-to-ag-studio-dashboard/ · Webinar recording https://www.youtube.com/watch?v=LGfG44i1Fj8

## APIMatic — https://paypalaihackathon.devpost.com/details/apimatic
Turns API contracts into SDKs, API portals, and **Context Plugins for AI coding agents**. The **APIMatic Context Plugin for PayPal** gives tools like Claude Code the PayPal API context to integrate PayPal — your agent pulls in relevant API info on demand. PayPal is already enabled; **no extra APIMatic credentials needed.**
- Claim free subscriptions: https://docs.google.com/forms/d/e/1FAIpQLScc2oCgAFACm7d6H3R4mgzv-O34DdyVnLIBNiwmUNggr_-hhA/viewform
  - Used the Context Plugin for your PayPal integration → **1 month APIMatic Basic free**
  - Winning teams that used it → **6 months APIMatic Business** (Context Plugins, SDKs, docs portal)
- Setup instructions (resource page): https://drive.google.com/file/d/1qa7Xkjt3PGJllHQVCP1IuE-XxlRNz4mN/view
- Webinar: https://youtu.be/zRWixN68tDg
- Prize: **3 × ($1,000 + 6 months Business)** — easiest sponsor prize to qualify for if we code with Claude Code anyway; mention it explicitly in README/video.

## Astropods — https://paypalaihackathon.devpost.com/details/astropods
Agent operating system for production AI agents: models, knowledge bases, tool integrations, observability, runtime + guardrails. Declarative agent spec → build/push with CLI → deploy via API or dashboard.
- Free account: https://astropods.com/ · Docs: http://docs.astropods.com · Walkthrough: https://blog.postman.com/build-ai-agents-with-astropods/
- Videos (in order): What is Astropods https://www.youtube.com/watch?v=5pIqjeyIKAc · Build first local project https://www.youtube.com/watch?v=rIeP9YADEZM · Deploy blueprints https://www.youtube.com/watch?v=WlKHRIdc3fs · Connect agent to Slack https://www.youtube.com/watch?v=P9DamZDrrFU
- No dedicated prize.

## Bryntum — https://paypalaihackathon.devpost.com/details/bryntum
Gantt (tasks + dependencies), Scheduler (events on resources timeline, drag/drop/resize), Calendar (day/week/month/year/agenda/resource).
**Prize:** best use of Gantt/Scheduler/Calendar — cleanest timeline, smartest resource booking, or **an agent that drives the schedule itself**.
**Ideas (theirs):** agency delivery board with payment tranches as Gantt dependencies (late PayPal payment blocks next phase); equipment rental Scheduler locked only once PayPal payment clears; event ticketing calendar with PayPal sales per event; subscription revenue radar (billing periods, renewals, failed payments, refunds per customer row); dispute triage board (per support agent; amount, deadline, evidence readiness; flag unallocated deadlines); agent-driven rescheduler reacting to PayPal payment events.
- Trial (45 days): https://bryntum.com/download/ · `npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial`
- Docs: Gantt https://bryntum.com/products/gantt/ · Scheduler https://bryntum.com/products/scheduler/ · Calendar https://bryntum.com/products/calendar/ · Examples https://bryntum.com/examples/ · Intro session https://app.livestorm.co/ag-grid/intro-to-bryntum?s=8d4683b4-11bb-4512-b2cb-ffd17cdc536a

## Channel3 — https://paypalaihackathon.devpost.com/details/channel3
One API for clean, normalized product data (titles, images, prices, variants, availability, buy links) across **100M+ products from 25,000+ retailers** — no scraping. Used for shopping agents, gift finders, AI stylists, comparison tools, conversational search.
**Requirement:** use the Channel3 API or MCP server as a *meaningful* part of the product (search, enrichment, recommendations). **Only referencing without calling it doesn't count.**
- Sign up: https://trychannel3.com/developers — key from dashboard, no credit card. **Promo code `PAYPAL-HACKATHON-2026` → 20,000 free API credits** (20k searches). Run out → ask in #channel3 on PayPal Discord for top-up; key stays active.
- Docs https://docs.trychannel3.com · MCP https://trychannel3.com/mcp · Examples: https://penny.shop, https://signup.zamana.com, https://www.folk.com · Channel3 Discord https://discord.com/invite/6J6MjctXrH
- Prize **$1,500** (1 winner). Natural fit for agentic-commerce/shopping-agent projects.

## Elastic — https://paypalaihackathon.devpost.com/details/elastic
Elasticsearch: open-source distributed search & analytics; structured/unstructured/vector data; hybrid + vector search; real-time analytics.
Suggested use: multi-step AI agent using Elasticsearch + a **Jina embedding model**, optionally Elastic Agent Builder, Elastic Workflows, Search, ES|QL, Observability, Security, A2A/MCP connectivity.
- 14-day trial: https://ela.st/elastic-paypal-hackathon → sign up → name/company → project type **Search or Vector Search** → region → Launch → wait for serverless cluster → Kibana.
- Extend 30 more days: https://www.elastic.co/trialextension · Or run locally free: https://www.elastic.co/downloads/elasticsearch
- Resources: https://www.elastic.co/getting-started · https://www.elastic.co/docs · https://www.elastic.co/training · https://www.elastic.co/community
- No dedicated prize (judge from Elastic on panel).

## KERNEL — https://paypalaihackathon.devpost.com/details/kernel
Cloud infrastructure for AI agents to act on the internet: <30 ms browser spin-up, bot anti-detection, 24fps live view + replay, durable auth (agents stay logged in), real headful Chromium (pop-ups, iframes, new windows). Works with every agent harness and CUA model.
- **$50 credits:** https://dashboard.onkernel.com/hackathon?code=KERNELDEVPOST2026 · Docs: https://www.kernel.sh/docs
- No dedicated prize. Good for browser-using shopping/checkout agents.

## Postman — https://paypalaihackathon.devpost.com/details/postman
Unified API platform (design, test, document, monitor).
- Free: https://www.postman.com/ · **PayPal API collection:** https://www.postman.com/paypal · Learning path "Building with AI": https://www.postman.com/liftoff/learning-paths/building-with-ai/?utm_source=paypal-hackathon
- No dedicated prize.

## Render — https://paypalaihackathon.devpost.com/details/render
Cloud platform: web services, databases, workflows, long-lived workers; autoscaling, zero-downtime deploys.
**How to use for the prize:** deploy on Render **and** use **Render Workflows** (https://render.com/docs/workflows) — orchestration engine for distributed tasks to coordinate AI agents, background jobs, data pipelines; define tasks as functions with Render's SDK, dispatch across hundreds of instances.
- **$50 credits:** https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon · Apply credits: https://render.com/docs/credits · Render Discord https://render.com/discord
- Prize: $1,000 / $750 / $500 Render credits. Also solves "hosted demo URL" requirement.

## Zapier — https://paypalaihackathon.devpost.com/details/zapier
**Zapier MCP** lets AI tools (Claude, ChatGPT, Cursor) take real actions across 9,000+ apps including PayPal; Zapier handles logins/permissions.
- New account → 14-day Professional trial, no card, then Free plan: https://zapier.com/sign-up
- Quickstart https://docs.zapier.com/mcp/get-started/quickstart · Docs https://docs.zapier.com/mcp/home · Overview https://zapier.com/mcp
- No dedicated prize. Note 14-day trial may expire before Dec 21 judging end.
