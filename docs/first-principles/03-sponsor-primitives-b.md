# 03 — Sponsor Primitives (B): APIMatic, Astropods, Postman, Render, Zapier

First-principles capability inventory. **No product ideas here** — only what each tool can do, its unusual levers, its limits, and how it pairs technically with PayPal primitives.

Researched 2026-11-10. Sources are official docs unless noted. Anything not confirmed in an official source is marked **UNVERIFIED**.

**Timeline that limits every trial** (from `docs/02-dates-timeline.md`): submissions close **Thu Nov 12, 2026, 12:00 pm PST**. Judging runs **Dec 1 – Dec 15**. Winners are announced **~Dec 21**. Organizers ask that the demo and its credentials keep working through Dec 21. A trial that starts today (Nov 10) has to last about **41 days**.

Prize lines (Devpost overview, https://paypalaihackathon.devpost.com/):
- "Best Use of APIMatic — $1,000 in cash, 3 winners, 6 months of APIMatic business subscription"
- "Best Use of Render — 1st Place $1,000 Render Credits / 2nd Place $750 Render Credits / 3rd Place $500 Render Credits"
- Astropods, Postman, Zapier: **no dedicated prize**

---

## 1. APIMatic

Sponsor page: https://paypalaihackathon.devpost.com/details/apimatic · Docs: https://docs.apimatic.io (index: https://docs.apimatic.io/llms.txt)

**Key finding:** the resource PDF on Drive **was accessible** ("APIMatic Context Plugins for PayPal – Getting Started.pdf", 2 pages). It says to run `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview`. I read the repo through the GitHub API and **did not run** the installer.
- The PayPal Context Plugin is a **bundle of agent skills (SKILL.md files), not an MCP server**. It ships manifests for Claude Code (`.claude-plugin/plugin.json`), Codex (`.codex-plugin`) and Cursor (`.cursor-plugin`).
- It covers the **APIMatic-generated PayPal Server SDK** (`@paypal/paypal-server-sdk` v2.5.0) in 6 languages: C#, Java, PHP, Python, Ruby and TypeScript. Each language has 8 skills: getting-started, authentication, client-initialization, calling-endpoints, models, error-handling, configuration-resilience and testing.
- The repo README says: "This is a preview repo and is experimental for the hackathon… not an official long term supported PayPal product and may be removed at any time."
- The SDK it covers has **only these controllers**: `orders`, `payments`, `subscriptions`, `transactionSearch`, `vault` and `oAuthAuthorization`. These come from the `paypal/PayPal-TypeScript-Server-SDK` `src/controllers` listing. **Payouts, Invoicing, Disputes and Webhooks management are not in the SDK.** The plugin gives no grounded context for them.

### 1.1 Core primitives
| Verb | What it does |
|---|---|
| **Ground** (Context Plugin) | Gives a coding agent version-pinned SDK facts at the moment it writes code, so it doesn't rely on model memory. The skills tell the agent to read the SDK source on disk to confirm signatures. ([overview](https://docs.apimatic.io/context-plugins/overview/)) |
| **Generate SDK** | Builds an OpenAPI spec into typed SDKs in up to 7 languages, with retries, OAuth, pagination and typed errors. ([SDK overview](https://docs.apimatic.io/generate-sdks/overview-sdks/)) |
| **Generate plugin** | `apimatic plugin generate` / `apimatic plugin publish` builds a Context Plugin for your *own* API from its published SDKs. |
| **Publish portal** | Docs-as-code static developer portal with API reference, code samples and `llms.txt`. Can be hosted on Netlify, Cloudflare or Vercel. ([portal](https://docs.apimatic.io/publish-apis/api-portal-overview/), [hosting](https://docs.apimatic.io/docs-as-code/hosting-your-generated-portal/)) |
| **Copilot** | API Copilot: a natural-language chat inside a generated portal that returns code grounded in the generated SDKs. Command: `apimatic portal copilot`. ([API Copilot](https://docs.apimatic.io/ai-capabilities/api-copilot/)) |
| **Transform** | Converts a spec between formats. Inputs: OpenAPI 1.x–3.1, RAML, Postman 1/2, Insomnia, HAR, API Blueprint, WADL, WSDL, Google Discovery, I/O Docs, APIMatic. Outputs: OpenAPI, RAML, Postman, Insomnia, Blueprint, WSDL, WADL, **GraphQL schema**, APIMatic. ([Transformer](https://docs.apimatic.io/api-transformer/overview-transformer/)) |
| **Merge** | Combines several API definitions into one portal or spec. ([merging](https://docs.apimatic.io/manage-apis/api-merging/)) |
| **Generate MCP server** | Builds an MCP server (stdio or HTTP, npm-packaged) from the TypeScript SDK, with tag-based tool filtering. **Alpha: access by request to support@apimatic.io.** ([MCP generator](https://docs.apimatic.io/generate-mcp-servers/mcp-server-overview/)) |

### 1.2 Unusual or under-used capabilities
- **Transformer has a REST API that works at runtime.** It has "Transform via File", "Transform via URL" and "Download Transformed File" endpoints ([transform-api-spec](https://docs.apimatic.io/api-transformer/transform-api-spec/)). An app or agent can call it to convert, for example, a HAR capture or a Postman collection into OpenAPI or a GraphQL schema on the fly. This is the only APIMatic primitive confirmed to be callable by a running app. Plan quota for the API is **UNVERIFIED**.
- **HAR → OpenAPI** input means recorded browser traffic can become a formal spec.
- **Skills are API-agnostic except getting-started.** Seven of the eight skills per language describe *any* APIMatic-generated SDK. A plugin generated for your own API inherits the same agent behaviors.
- **The MCP generator builds on the TypeScript SDK**, so the tools inherit the SDK's retries, OAuth client-credentials handling and typed models. It is still alpha.
- **`llms.txt` generation** for portals ([llms-txt](https://docs.apimatic.io/ai-capabilities/llms-txt/)) gives agents a machine-readable view of the API.

### 1.3 Inputs and outputs
- **Inputs:** an OpenAPI (or other) spec plus `APIMATIC-BUILD.json` metadata; for the PayPal plugin, nothing (it's prebuilt).
- **Outputs:**
  - SDK packages (npm, PyPI and others, published to GitHub)
  - Static portal (HTML)
  - Context plugin (git repo of SKILL.md files)
  - Transformed spec files
  - MCP server npm package (alpha)

### 1.4 Limits
- **PayPal Context Plugin:** free, and needs no APIMatic credentials (sponsor page: "Since PayPal is already enabled, you won't need any extra credentials"). It's a preview repo and "may be removed at any time".
- **Free subscription** (claim form, Google Form). Terms, quoted:
  - "Subscriptions start upon approval, not a fixed date."
  - "Claims are tied to the submitter's email address, cross-checked against PayPal's participant/winner records."
  - "Every claim goes through manual verification… no auto-trigger."
  - "Non-transferable."
  - The form asks for a project/GitHub link and a "Description of Context Plugin usage" and says "Must Show APIMatic Context Plugin Usage".
  - Participants get **1 month Basic**. Winners get **$1,000 + 6 months Business**.
- **Plans** ([pricing](https://www.apimatic.io/pricing)):
  - **Basic:** $300/mo per language, up to 5 languages, Code Sample API, OAuth 2.0.
  - **Business:** quote-based. All 7 languages, up to 100 endpoints/API, white-label, pagination and webhooks SDK features, **API Copilot and Context Plugins**.
  - **Free trial:** 14 days.
  - Context Plugins and Copilot for *your own* API therefore need **Business**. Basic does not include them.
- **MCP server generation:** alpha, by request only. Expect it not to be available within the hackathon window (UNVERIFIED).
- **Web Dashboard is being retired.** The CLI is the current path.
- **Timing vs Dec 21:** the plugin itself has no expiry. Subscriptions start on approval, so Basic (1 month) may or may not cover the judging window (UNVERIFIED).

### 1.5 Prize criteria
The sponsor page has no judging rubric. It says: "Participants who used the Context Plugin to build their PayPal integration → 1 month of APImatic Basic, free. Winning teams that used the plugin → 6 months of APIMatic Business, free." The claim form adds: "**Must Show APIMatic Context Plugin Usage**". The overview lists the prize as "Best Use of APIMatic — $1,000 in cash, 3 winners, 6 months of APIMatic business subscription."

### 1.6 Combines naturally with PayPal primitives like…
- Context Plugin `typescript-calling-endpoints` ↔ **Orders v2** create/capture/authorize (`OrdersController`)
- Context Plugin `*-configuration-resilience` (SDK retry config) ↔ **`PayPal-Request-Id` idempotency** on retried captures and refunds
- Context Plugin `*-error-handling` (typed `ApiError` subclasses) ↔ **PayPal error `name`/`details[].issue`** branches such as `INSTRUMENT_DECLINED` and `ORDER_NOT_APPROVED`
- `SubscriptionsController` ↔ **Billing Plans / Subscriptions** lifecycle
- `TransactionSearchController` ↔ **Transaction Search / reporting** reads
- `VaultController` ↔ **Vault payment tokens** (saved payment methods)
- Transformer API (Postman → OpenAPI) ↔ the **PayPal Postman collection** or `paypal/paypal-rest-api-specifications` OpenAPI files
- **Gap:** no plugin coverage for **Payouts, Invoicing or Disputes**. Those need raw REST or another tool.

---

## 2. Astropods

Sponsor page: https://paypalaihackathon.devpost.com/details/astropods · Docs: https://docs.astropods.com (index: https://docs.astropods.com/llms.txt). There is also a docs MCP server at `https://docs.astropods.com/_mcp/server`.

### 2.1 Core primitives
| Verb | What it does |
|---|---|
| **Declare** | `astropods.yml` (RFC-1 spec, `spec: blueprint/v1`) declares the agent container, `models`, `knowledge`, `integrations`, custom `providers`, `ingestion` jobs, `interfaces` and `sandbox`. ([spec](https://docs.astropods.com/astropods-package-spec.md)) |
| **Build / run locally** | `ast project` / `ast project start`. The CLI uses Docker. `ast create my-agent --model gateway` scaffolds an agent. ([CLI](https://docs.astropods.com/cli.md)) |
| **Publish** | `ast blueprint` pushes a versioned snapshot (image + spec) to the registry. Blueprints are private by default and can be made public. ([blueprints](https://docs.astropods.com/blueprints.md)) |
| **Deploy** | Turns a blueprint into a live agent with its own URL, through the CLI, dashboard or REST API. ([deploy](https://docs.astropods.com/deploy-agent.md), [API](https://docs.astropods.com/api-reference.md)) |
| **Infer** | The AI Gateway is OpenAI-compatible and needs no provider key. It injects `ASTRO_GATEWAY_URL`, `ASTRO_GATEWAY_API_KEY` and `MODEL_<NAME>`. It also has a native Anthropic Messages passthrough, embeddings, vision and web search (GPT models). ([gateway](https://docs.astropods.com/ai-gateway.md)) |
| **Decide** | `POST /v1/decisions` sends a state plus named typed questions (yes/no-style, choice, score). It returns typed answers rather than prose and uses the model `jev-1-13-0`. ([decisions](https://docs.astropods.com/ai-gateway/decisions.md)) |
| **Remember** | Knowledge stores are provider-managed `qdrant`, `redis`, `postgres` or `neo4j` (persistent volumes), `pinecone` (cloud), or any container (e.g. pgvector). Postgres credentials are auto-injected. ([knowledge](https://docs.astropods.com/knowledge-stores.md)) |
| **Ingest** | `ingestion` jobs are containers triggered `schedule` (cron) or `startup`. They bill per run. |
| **Converse** | The Messaging SDK runs over gRPC to Slack, web chat and Teams. It supports streaming text, status updates, prompts, attachments, reactions/feedback, audio bytes and files. ([messaging](https://docs.astropods.com/messaging-sdk.md)) |
| **Ask (HITL)** | Pauses mid-turn, renders a typed form in chat and resumes with structured data (MCP "elicitation"). ([ask-for-input](https://docs.astropods.com/ask-for-input.md)) |
| **Act-as-user** | Connections: declared per spec, the end user consents in chat and the agent gets that user's token. Providers supported: **GitHub, Postman, Box only**. ([connections](https://docs.astropods.com/agent-connections.md)) |
| **Connect MCP** | Connects to OAuth 2.1 MCP servers at runtime, using the public agent URL (`ASTRO_EXTERNAL_AGENT_URL`) as the redirect. ([mcp-oauth](https://docs.astropods.com/mcp-oauth.md)) |
| **Sandbox** | A VM for running agent-generated code. Spec section 9 has `SandboxPython`, `SandboxNode` and `SandboxBrowser`. **Experimental.** ([sandbox](https://docs.astropods.com/remote-sandbox.md)) |
| **Observe** | Automatic tracing of tokens, tool calls and latency, plus OpenTelemetry. Drop-in instrumentation exists for Vercel AI SDK, Mastra and the Claude Agent SDK, and it can ingest Claude Code telemetry. Health page shows app, memory, CPU and alerts. ([monitor](https://docs.astropods.com/monitor-agents.md)) |
| **Evaluate** | `EVALUATION.yaml` evaluators grade production traces after the fact, for PII exposure, leaked credentials, sentiment and unnecessary tool calls. `ast eval`, `ast dataset`. ([evals](https://docs.astropods.com/evals.md)) |
| **Govern** | Policies (experimental): a natural-language rule becomes a trigger plus steps (pause agent, notify, refuse, branch). Triggers are spend, request count, deployment events and member actions. ([policies](https://docs.astropods.com/policies.md)) |
| **Gate access** | Per-interface access: a person, an org, "Anyone" (any signed-in Astropods user) or an **Audience** list. Frontends sit behind Astropods OIDC sign-in, and the identity is forwarded to the container. ([access](https://docs.astropods.com/access-control.md), [audiences](https://docs.astropods.com/audiences.md)) |
| **Store secrets** | Account vault plus per-environment variables and secrets (`ast secrets`, `ast env`). |

### 2.2 Unusual or under-used capabilities
- **Typed decision endpoint** (`/v1/decisions`): answers come back as a probability, option or score. This is a deterministic-shaped classifier call that doesn't need prompt parsing.
- **Human-in-the-loop as a platform primitive.** Docs frame confirmations as a **prompt-injection defense before irreversible actions ("spending money")**. The same call works in Slack and web chat.
- **Spend-triggered governance:** policies can auto-pause an agent when its spend crosses a threshold. Account-level hard spend limits stop all agents.
- **Agent ships its own frontend** (`interfaces.frontend: true`) behind managed OIDC, with the caller's identity forwarded. You get auth without writing auth.
- **Evaluators on production traces** for PII and credential leaks, with curated datasets for regression.
- **Agent Mesh Protocol (AMP)** and AstroAgent: an open broker protocol for agent↔agent and agent↔person tasks, interoperable with A2A, with a NATS JetStream binding. ([AMP](https://docs.astropods.com/amp.md))
- **Save a conversation from another source:** imports a Slack thread or email chain into a user's chat history.
- **Users can pick the model per turn in chat** (model picker driven by `serve(agent, { models })`).

### 2.3 Inputs and outputs
- **Inputs:**
  - An agent container (any framework). Adapters exist for Mastra, LangChain/LangGraph, Vercel AI SDK, plus custom Node and Python adapters.
  - The YAML spec
  - Secrets
  - Chat or Slack messages and files/audio
  - Inbound HTTP on the agent URL
- **Outputs:**
  - A hosted agent URL (chat or custom frontend)
  - Slack, Teams or web-chat responses
  - Traces and eval scores
  - REST API objects (deployments, accounts, audit log)
  - An SSE stream of account agent events

### 2.4 Limits
- **Free tier** ([usage](https://docs.astropods.com/usage.md)): "Each account's oldest running agent is free, whatever size you give it." That covers **compute only, not model usage** through the AI Gateway. New accounts get **one-time signup credits** with the amount shown once at signup (amount **UNVERIFIED**). The messaging sidecar is free.
- **When credits run out without a card,** "every agent in the account stops". To keep a demo up through Dec 21, either keep gateway spend inside the signup credits or bring your own provider key (`provider: anthropic` with your key; [own-provider-key](https://docs.astropods.com/own-provider-key.md)).
- **AI Gateway gaps** ([limits](https://docs.astropods.com/ai-gateway/limits.md)):
  - No Anthropic server-side tools (web_search, code execution, computer use)
  - No image generation
  - No BYO models
  - Returns 429 on rate or usage limits
- **Experimental features:** Policies and Sandboxes are both marked experimental.
- **Viewer access:** judges must **sign in to Astropods** ("Anyone" = any signed-in Astropods user) unless you serve your own frontend. Whether fully anonymous public access is possible is **UNVERIFIED**.
- **Local build** needs Docker.

### 2.5 Prize criteria
None. The sponsor page has no prize section; support is via the PayPal Discord.

### 2.6 Combines naturally with PayPal primitives like…
- Ask-for-input (HITL form) ↔ **Orders v2 capture**, **Refunds** or **Payouts** as the irreversible step behind a confirmation
- `/v1/decisions` typed answers ↔ **Disputes** (accept/contest choice) and **refund-eligibility** checks over order and transaction data
- Ingestion `schedule` jobs ↔ **Transaction Search** pulls and **Invoicing** status polls into a knowledge store
- `postgres` / `qdrant` knowledge stores ↔ persisting **webhook events** and **order and transaction history** for retrieval
- Agent public URL (`ASTRO_EXTERNAL_AGENT_URL`) ↔ **PayPal webhook listener** and OAuth redirect target (UNVERIFIED that the agent URL accepts unauthenticated webhook POSTs, since frontends are OIDC-gated by default)
- Connect-to-MCP (OAuth 2.1) ↔ the **PayPal MCP server** / Agent Toolkit tools
- Evaluators (PII and credential-leak checks) ↔ **payer data** in PayPal responses (emails, addresses)
- Spend policies ↔ a hard ceiling on agent LLM cost. This does not limit PayPal money movement.

---

## 3. Postman

Sponsor page: https://paypalaihackathon.devpost.com/details/postman · Docs: https://learning.postman.com (index: https://learning.postman.com/llms.txt). There is also a docs MCP server at `https://learning.postman.com/_mcp/server`.

**PayPal collection:** https://www.postman.com/paypal (the page is JS-rendered and I couldn't read it directly). PayPal's guide ([developer.paypal.com/api/rest/postman](https://developer.paypal.com/api/rest/postman/)) says:
- Use "Run in Postman" → Fork, then set `client_id` and `client_secret` in the collection Variables.
- "A script generates and manages the `access_token`", and the walkthrough uses sandbox accounts.
- A third-party listing describes the collection as covering Checkout Orders, Payments, Payouts, Subscriptions, Webhooks and more (exact list **UNVERIFIED** against the live workspace).

### 3.1 Core primitives
| Verb | What it does |
|---|---|
| **Request** | Sends HTTP, GraphQL, gRPC, WebSocket, **MCP** and **AI (LLM)** requests. Has pre-request and test scripts (`pm.*`). ([MCP requests](https://learning.postman.com/docs/use/send-requests/protocols/mcp-requests/overview.md)) |
| **Collect** | Collections hold requests, examples, variables, auth helpers and scripts. They can be forked from the API Network. |
| **Run** | The Collection Runner is unlimited on 2026 plans, and runs are data-driven via iterations. The Postman CLI runs collections in CI or from coding agents. ([resource usage](https://learning.postman.com/docs/billing/resource-usage.md)) |
| **Mock** | Two kinds: (a) a collection mock server that returns saved examples, and (b) a **code-based mock** in JavaScript with `pm.mock`, **`pm.state` (stateful, per-caller session via `x-mock-session`)**, `pm.datasets` (SQL over datasets) and `pm.test`. Code mocks can be deployed as hosted mock servers. ([customize a mock](https://learning.postman.com/docs/design-apis/mock-apis/mocks/customize-a-mock.md)) |
| **Simulate** | Postman Simulator groups several mocks behind one address, with scenarios and behaviors (latency, errors, rate limits). ([behaviors](https://learning.postman.com/docs/design-apis/mock-apis/mocks/scenarios-and-behaviors.md), [Simulator](https://learning.postman.com/docs/design-apis/simulate-conditions/overview.md)) |
| **Monitor** | Scheduled cloud runs of a collection with tests, plus alerting. ([monitors](https://learning.postman.com/docs/monitoring-your-api/intro-monitors.md)) |
| **Flow** | A low-code canvas of blocks (HTTP, If/Condition, Evaluate in TypeScript or FQL, AI Request, **AI Agent block**, connectors). **Deployed flows become public HTTP endpoints** on Postman Cloud. They can be triggered by API or **MCP**, and are composable. ([Flows](https://learning.postman.com/flows/overview.md)) |
| **Agent Mode** | A natural-language agent inside Postman that sends requests, fixes errors, writes tests, creates mocks and builds flows. ([Agent Mode](https://learning.postman.com/docs/getting-started/basics/about-agent-mode.md)) |
| **Plug into coding agents** | `npm i -g postman-cli` then `postman init` loads Postman skills into Claude Code, Codex, Cursor and others. ([plugin](https://learning.postman.com/docs/postman-plugin/overview.md)) |
| **MCP server (Postman's own)** | Remote server at `mcp.postman.com` with Minimal, Full (~100+ tools) and Code modes. It uses OAuth or an API key, and there's also an npm package `@postman/postman-mcp-server` ([GitHub](https://github.com/postmanlabs/postman-mcp-server); tool counts vary by version). |
| **Generate MCP server** | The MCP Generator builds a local MCP server from selected public API Network requests. ([MCP Generator](https://learning.postman.com/docs/postman-ai/mcp-servers/overview/)) |
| **Generate SDK / CLI** | The SDK Generator and CLI Generator build clients from collections or specs. ([SDK gen](https://learning.postman.com/docs/sdk-generator/overview.md), [CLI gen](https://learning.postman.com/docs/cli-generator/overview.md)) |
| **Store secrets** | Postman Vault, plus `postman secret` from the CLI. |
| **Automate Postman** | The Postman API manages collections, mocks, monitors and environments programmatically. ([Postman API](https://learning.postman.com/docs/reference/postman-api/intro-api.md)) |

### 3.2 Unusual or under-used capabilities
- **Stateful hosted mocks with per-caller sessions** (`pm.state` + `x-mock-session`) plus SQL datasets. A mock can behave like a real service instead of returning static JSON.
- **Failure-injection behaviors** (latency, errors, rate limits) on mocks and the Simulator.
- **Deployed Flows = hosted webhook and API endpoints** with an AI Agent block, which can call external MCP tools.
- **MCP request type** to test any MCP server inside a collection, with assertions.
- **Agent skills for coding agents** (`postman init`) parallel APIMatic's plugin, but cover the *testing, mocking and monitoring* side.
- **Astropods supports Postman as a user "connection" provider.** An Astropods agent can act as the chatting user's Postman account ([agent-connections](https://docs.astropods.com/agent-connections.md)).

### 3.3 Inputs and outputs
- **Inputs:**
  - OpenAPI or other specs
  - Collections, including forks of the PayPal collection
  - Environments and vault secrets
  - Datasets
  - Inbound HTTP to deployed flows or mock servers
- **Outputs:**
  - HTTP responses from mocks and flows
  - Test results and monitor alerts
  - Generated SDKs, CLIs and MCP servers
  - CLI exit codes and machine-readable output for CI

### 3.4 Limits
**Free plan** ([pricing](https://www.postman.com/pricing/), [flows usage](https://learning.postman.com/docs/billing/flows-usage.md)):
- 1 user
- **100 AI credits**
- **10,000 Postman API calls/mo**
- Mock servers and manual Flows included
- Collection Runner unlimited
- **Flows: 25 complimentary credits/mo** with no pay-as-you-go on Free. Automated (API- or MCP-triggered) runs cost credits per block: HTTP 1, If 1, Evaluate 1, Connector 2, AI Request 1 + BYOK, and AI Agent per model and tool. **So a deployed Flow on Free can handle only a handful of runs per month.**
- Exact Free monitor-request and mock-call caps were **UNVERIFIED**: the pricing page lists them as limited without numbers in the portion I read.

Other limits:
- **No trial expiry on Free.** It stays usable through Dec 21, within the monthly caps above.
- Insights is Enterprise only. Paid tiers: Solo $9/mo, Team $19/user/mo (billed annually).

### 3.5 Prize criteria
None. The sponsor page lists only resources (free signup, the PayPal collection and the "Building with AI" learning path).

### 3.6 Combines naturally with PayPal primitives like…
- Fork of PayPal collection + auto `access_token` script ↔ **OAuth2 client-credentials** for any sandbox REST call
- Stateful code mock (`pm.state`) ↔ a fake **Orders v2 lifecycle** (CREATED → APPROVED → COMPLETED) or a **Payouts batch** status progression
- Mock behaviors (latency, errors, 429) ↔ PayPal **retry and idempotency** paths (`PayPal-Request-Id`)
- Deployed Flow endpoint ↔ **PayPal webhook receiver** (e.g. `PAYMENT.CAPTURE.COMPLETED`)
- Monitors ↔ scheduled **sandbox smoke tests** for Orders, Subscriptions and Webhooks
- MCP request type ↔ testing the **PayPal MCP server** / Agent Toolkit tool calls with assertions
- Postman ↔ APIMatic Transformer (collection → OpenAPI) round-trips

---

## 4. Render

Sponsor page: https://paypalaihackathon.devpost.com/details/render · Workflows docs: https://render.com/docs/workflows

### 4.1 Core primitives
| Verb | What it does |
|---|---|
| **Serve (web)** | Public HTTP service from a Git repo or Docker image, with zero-downtime deploys. |
| **Serve (private)** | Private service: no public URL, reachable on the private network, any port or protocol. ([private services](https://render.com/docs/private-services)) |
| **Work (background)** | Background worker: no inbound traffic, long-running, typically pulls from a queue such as Key Value. |
| **Schedule** | Cron job. This is also the only way to schedule Workflow runs, since Workflows have no native scheduler. |
| **Store** | **Postgres** (managed) and **Key Value** (Redis-compatible). |
| **Orchestrate** (Workflows) | *Tasks* run each call on its **own instance**. A task chains tasks (or itself) with `ctx.run()` for **fan-out** via `Promise.all` / `asyncio.gather`. *Flows* are sequential `ctx.step()`s on one instance that **persist each step result and replay** after interruption. ([defining tasks](https://render.com/docs/workflows-defining-tasks), [flows](https://render.com/docs/workflows-defining-flows)) |
| **Retry** | Default 3 retries (4 attempts) with exponential backoff starting at 1 s. Retries fire on exceptions, timeouts, compute-limit breaches and instance errors. Each retry runs on a fresh instance. |
| **Trigger** | SDK `startTask` / `runTask` (TypeScript), `start_task` / `run_task` (Python async and sync), REST "Run task" / "Run flow" with an **`idempotencyKey`**, the CLI, or the Dashboard. ([running](https://render.com/docs/workflows-running)) |
| **Scale** | Manual scaling up to 100 instances on paid plans. Autoscaling on CPU and/or memory targets needs a Pro workspace. ([scaling](https://render.com/docs/scaling)) |
| **Preview** | Preview environments copy the whole Blueprint stack per PR, with `previewValue` env overrides and `initialDeployHook` seeding. They need a Pro workspace and **skip Workflows**. ([previews](https://render.com/docs/preview-environments)) |
| **Declare** | Blueprints (`render.yaml`) are infrastructure-as-code. They support Workflows, but not Workflow previews or replication. ([blueprint spec](https://render.com/docs/blueprint-spec)) |
| **Sandbox** (public beta) | Isolated, on-demand environments for untrusted or agent code via CLI or SDK, with exec, file upload and download, **snapshots**, egress restrictions and auto suspend/resume. ([sandboxes](https://render.com/docs/sandboxes)) |

### 4.2 Unusual or under-used capabilities
- **Per-run instance isolation with second-level billing.** Fan-out to hundreds of instances costs only what each run uses. On the `flex` plan that's $0.20/CPU-hr and $0.05/GB-hr.
- **Built-in run idempotency key** on the trigger API (`idempotencyKey`), so duplicate triggers can be deduplicated at the orchestrator.
- **Flows replay from persisted step results.** Completed side-effecting steps are not re-executed after an infrastructure interruption (checkpointing for free). Up to 10,000 steps per flow run and up to 100 attempts per step.
- **Runs up to 24 h**, configurable per task from 30 s up.
- **Run history and arguments retained 30 days.** That is an audit trail of inputs and outputs, billed at $0.25/GB-month.
- **Workflows reach Postgres and Key Value over the private network, but can't receive inbound connections.** They are pure compute that gets triggered.
- **Local task server** (`render workflows dev -- npm start`, port 8120) lets you develop without deploying.
- **Sandboxes have guides for Claude Managed Agents, Cursor Cloud Agents and the OpenAI Agents API**, which gives agent code execution on the same platform. In beta they have no private networking and no public URLs.

### 4.3 Inputs and outputs
- **Inputs:**
  - Git repo or Docker image
  - `render.yaml`
  - Environment variables and secret files
  - HTTP to web services
  - Workflow run triggers: a JSON positional-args array, up to 4 MB
- **Outputs:**
  - Public URLs (`*.onrender.com`)
  - Run status (`completed`/`failed`/`canceled` for tasks; `succeeded`/`failed`/`canceled` for flows)
  - JSON return values, up to 4 MB per step
  - Logs and Dashboard run history

There is **no completion webhook** documented for Workflow runs: you poll, await, or use the Python `task_run_events` iterator.

### 4.4 Limits
**Free instances** ([free](https://render.com/docs/free)):
- **Web services** spin down after 15 min idle (~1 min cold start), get 750 instance-hours per month per workspace, use an ephemeral filesystem and run as a single instance.
- **Free Postgres** is 1 GB, one per workspace, and **expires 30 days after creation** (then a 14-day grace period). A DB created Nov 10 expires ~Dec 10, **before the end of judging**.
- **Free Key Value** is in-memory only.
- **Background workers and cron jobs have no free tier.**

**Workflows** ([limits](https://render.com/docs/workflows-limits)):
- Compute plans:
  - `flex` (≤1 CPU / 4 GB, usage-based)
  - `2c-4g` $0.40/hr
  - `2c-8g` $0.70/hr
  - `4c-8g` $1.00/hr
  - `4c-16g` $1.50/hr
  - `8c-32g` $2.50/hr
- 2 h default timeout per attempt, configurable up to 24 h
- 4 MB args per run, 4 MB output per step
- 500 tasks and flows per service
- New compute per minute: **Hobby 16 CPU / 64 GB**, Pro 32 CPU / 128 GB. Excess is queued.
- Root-run API rate: **Hobby 50 req/min**, Pro 1,500. Excess gets a 429 and is *not* queued.
- Chained runs: 1,000/min
- Total active: 10,000 CPU / 40,000 GB per service

The limits page names Hobby, so Workflows look usable on the free Hobby workspace plan with paid compute (**UNVERIFIED**). Whether Render calls Workflows beta wasn't stated on the pages I read (**UNVERIFIED**).

**Credits** ([credits doc](https://render.com/docs/credits)):
- $50 through the hackathon portal. The portal page is JS-rendered, so I didn't read its terms and **didn't redeem anything**.
- Credits are applied **at the end of each monthly billing period**, cover plan fees, compute and bandwidth, are not transferable between workspaces, and don't upgrade the plan.
- "Promo codes distributed during an event (such as a hackathon) usually expire shortly after the event ends." The exact expiry of this code is **UNVERIFIED**.
- Redeeming may require a payment method on file (**UNVERIFIED**).

**Languages:** Workflows support TypeScript and Python only ("SDKs for other languages are planned"). The SDK is `@renderinc/sdk` ≥1.7.0 or `render` ≥1.7.0 for Python.

### 4.5 Prize criteria
Sponsor page, quoted: "Deploy your project on Render and use Render Workflows, an orchestration and execution engine for distributed tasks, to coordinate AI agents, background jobs, and data pipelines. Define tasks as standard functions using Render's lightweight SDK and dispatch them across hundreds of concurrent instances." The overview lists the prizes as 1st $1,000, 2nd $750 and 3rd $500, all in Render credits. **Both conditions apply: the app is hosted on Render *and* it uses Workflows.**

### 4.6 Combines naturally with PayPal primitives like…
- Task fan-out (`ctx.run` + `Promise.all`) ↔ **Payouts batch** item preparation, per-recipient checks, or parallel **Orders/Captures** lookups
- `idempotencyKey` on run trigger ↔ **`PayPal-Request-Id`**: the same key end-to-end, from webhook to run to PayPal call
- Flow `ctx.step()` persisted results ↔ multi-step money movement (**authorize → capture → refund-on-failure**) without double-executing completed steps on replay
- Automatic retries with backoff ↔ PayPal **429 / 5xx** and **webhook redelivery**
- Web service endpoint ↔ **PayPal webhook listener** with signature verification (`/v1/notifications/verify-webhook-signature`), which then triggers a Workflow run
- Cron job → Workflow ↔ periodic **Transaction Search**, **Subscription** billing status sweeps, **Invoice** reminders and **Dispute** deadline scans
- 24 h run limit ↔ long waits on **payer approval** or **dispute evidence windows**. Beyond 24 h you need cron re-entry.
- Postgres or Key Value over the private network ↔ storing **order IDs, capture IDs and webhook event IDs** for dedup
- Sandboxes ↔ running agent-generated code against **sandbox PayPal credentials**, with egress restricted to `api-m.sandbox.paypal.com`

---

## 5. Zapier

Sponsor page: https://paypalaihackathon.devpost.com/details/zapier · Docs: https://docs.zapier.com/mcp/home

### 5.1 Core primitives
| Verb | What it does |
|---|---|
| **Connect (MCP)** | A single endpoint, `https://mcp.zapier.com/api/v1/connect`, **Streamable HTTP only (no SSE)**. ([connections](https://docs.zapier.com/mcp/overview/how-connections-work.md)) |
| **Authenticate** | Two paths. (1) OAuth for supported clients: Claude, ChatGPT, Cursor, Grok Bot, VS Code. (2) A **connection token** for your own Python or TypeScript code, sent as `Authorization: Bearer <token>`. The token is tied to one server, long-lived and shown once. |
| **Act** | Runs actions across 9,000+ apps and 40,000+ actions, using Zapier-held app credentials. The MCP client never sees third-party keys. |
| **Discover** | In *agentic mode*, 16 meta-tools let the agent find, enable and run actions itself: `execute_zapier_read_action`, `execute_zapier_write_action`, connection management, and skills CRUD. ([tools](https://docs.zapier.com/mcp/overview/how-tools-work.md)) |
| **Constrain** | *Managed mode* exposes each action as its own tool, with **locked field values**. |
| **Code fallback** | `write_code_action` creates a custom code action when no built-in action exists. Its HTTP goes via Zapier's Proxy API (available on "some servers"). |
| **Bundle** | Tool bundles share a copy of the tool list on any plan. Sharing a server needs Team or Enterprise. |
| **Trigger (Zaps)** | Classic Zaps react to app events and run multi-step automations. Multi-step needs a paid plan. |
| **Tables / Agents / Chatbots** | Tables (records DB), Zapier Agents (activity-metered) and Chatbots. ([pricing](https://zapier.com/pricing)) Interfaces limits were **UNVERIFIED**. |

**PayPal app on Zapier** ([integrations](https://zapier.com/apps/paypal/integrations)):
- **Triggers (9):**
  - Billing Plan Webhooks
  - Billing Subscription Webhooks
  - Canceled Recurring Payment Webhooks
  - Failed Payment Webhooks
  - New Invoice
  - Payment Capture Webhooks
  - Payment Refund Webhooks
  - Payment Sale Webhooks
  - Recurring Payment Webhooks
- **Actions (3):**
  - Create Invoice (draft)
  - **Create Payment** ("new payment order using PayPal Orders v2 API")
  - Send Invoice
- **Searches (8), each by ID:**
  - Authorized Payment
  - Captured Payment
  - Invoice
  - Order
  - Plan
  - Product
  - Refund
  - Billing Subscription
- **Missing:** no Payouts, Refund-create, Capture, Disputes or Transaction-list actions.

### 5.2 Unusual or under-used capabilities
- **Sandbox is supported.** The PayPal connection form has an **"Is sandbox?" = Yes** field and uses a sandbox app's Client ID and Secret ([Zapier help](https://help.zapier.com/hc/en-us/articles/8495999676045-How-to-Get-Started-with-Paypal)). Turn on **Transaction search** on the sandbox app, or the capture and refund triggers can't return test records.
- **Credential custody:** the agent never holds PayPal or other third-party secrets. Zapier holds them, with audit history and SOC 2 Type II.
- **Agentic self-provisioning:** the model can discover and enable new app actions mid-conversation, so the toolset isn't fixed at build time.
- **Locked fields in managed mode** constrain what the model can change. For example, you can pin a recipient or currency and let the AI fill only the amount.
- **Skills** (agentic mode) are saved, reusable instruction sets managed through MCP tools.
- **Failed calls cost nothing.** Only successful calls consume tasks.

### 5.3 Inputs and outputs
- **Inputs:** MCP tool calls from any Streamable-HTTP MCP client (natural-language-filled params), plus app events for Zap triggers.
- **Outputs:** actions in 9,000+ apps (email, Slack, Sheets, CRM, PayPal invoices and orders), search results returned to the model, Zap runs, and Tables rows.
- The output format returned to the model wasn't documented on the pages I read (**UNVERIFIED**).

### 5.4 Limits
- **Task metering:** "Each successful tool call uses two tasks". Batches count per item ([usage](https://docs.zapier.com/mcp/overview/usage.md)). There are no per-session or per-server call limits; the task allowance is the only cap. When tasks run out without pay-per-task, "Tool calls stop until your billing cycle resets".
- **Plans** ([pricing](https://zapier.com/pricing)):
  - **Free:** 100 tasks/mo (= **50 MCP calls**), two-step Zaps only, **no premium apps**, no webhooks, 15-min polling, Tables 2,500 records, Agents 400 activities/mo.
  - **Professional:** from $19.99/mo annual for 750 tasks.
- **Trial:** a new account gets a **14-day Professional trial** with no card, then moves to Free automatically.
- **The critical constraint:** Zapier help says **"PayPal is a premium app on Zapier"** and a **"paid Zapier plan"** is required. A trial started Nov 10 ends ~**Nov 24**, *before judging (Dec 1–15)*. After that, PayPal actions and triggers stop working on the Free plan. To keep the integration live through Dec 21, you'd need a paid plan; whether a new account could restart the trial is UNVERIFIED and may conflict with Zapier's terms.
- **PayPal trigger caveat:** "App versions 2.0.0 and later do not support manual payments for instant triggers". The workaround is a Webhooks by Zapier catch hook, which is itself premium.
- **Transport:** SSE-only clients cannot connect.

### 5.5 Prize criteria
None. The sponsor page offers only "free access" (the 14-day trial) and support on the PayPal Discord.

### 5.6 Combines naturally with PayPal primitives like…
- Zapier PayPal "Create Payment" (Orders v2) / "Create Invoice" + "Send Invoice" ↔ **Orders v2** and **Invoicing v2**, invoked by an AI via MCP without the app holding PayPal credentials
- Zapier "Failed Payment / Payment Refund / Recurring Payment Webhooks" triggers ↔ **PayPal webhook events** fanned out to 9,000 apps (Slack, Sheets, CRM, email)
- Search Order / Captured Payment / Subscription by ID ↔ **Orders v2 GET**, **Captures GET** and **Subscriptions GET** as model-callable read tools
- Managed-mode locked fields ↔ constraining **currency, payee or amount ceilings** on payment-creating tool calls
- MCP connection token from custom code ↔ an agent backend (e.g. on Render) calling cross-app actions next to direct **PayPal REST/Agent Toolkit** calls for operations Zapier lacks: **Payouts, Refund create, Disputes**

---

## 6. Cross-sponsor table: primitive verb → provider

Legend: ● native and documented · ◐ partial, limited, beta or experimental · — not offered

| Primitive verb | APIMatic | Astropods | Postman | Render | Zapier |
|---|---|---|---|---|---|
| Ground a coding agent in API/SDK facts | ● Context Plugin (PayPal Server SDK skills) | — | ● `postman init` skills | — | — |
| Generate SDKs | ● 7 langs | — | ● SDK Generator | — | — |
| Generate an MCP server from an API | ◐ alpha, by request | — | ● MCP Generator (public API Network) | — | — |
| Expose many SaaS actions to an LLM via MCP | — | ◐ connects to OAuth MCP servers | ◐ Postman's own MCP server (Postman ops) | — | ● 9,000+ apps |
| Convert spec formats at runtime (API) | ● Transformer API | — | ◐ import/export in app | — | — |
| Host a web app / HTTP endpoint | ◐ static portal only | ● agent URL (OIDC-gated) | ◐ deployed Flow / mock server | ● web service | — |
| Receive webhooks | — | ◐ agent URL (UNVERIFIED for unauthenticated POSTs) | ● deployed Flow | ● web service | ● Zap triggers (PayPal events) |
| Fan out parallel compute | — | — | — | ● Workflows tasks | — |
| Durable, checkpointed multi-step execution | — | — | — | ● Workflows flows (step replay) | ◐ multi-step Zaps (paid) |
| Automatic retries with backoff | ◐ SDK retry config | — | — | ● per task/step | — |
| Idempotent triggering | ◐ SDK passes headers | — | — | ● `idempotencyKey` | — |
| Schedule (cron) | — | ● ingestion `schedule` | ● monitors / scheduled runs | ● cron jobs | ● Zap schedule (UNVERIFIED on Free) |
| Background / long-running worker | — | ● agent container | — | ● workers, 24 h runs | — |
| Relational DB | — | ● postgres knowledge store | ◐ `pm.datasets` (SQL in mocks) | ● Postgres (free 30-day expiry) | ◐ Tables |
| Vector / graph store | — | ● qdrant, pinecone, neo4j, pgvector | — | ◐ Postgres + pgvector (UNVERIFIED) | — |
| Cache / KV | — | ● redis | ◐ `pm.state` | ● Key Value | — |
| Managed LLM access (no key) | — | ● AI Gateway (OpenAI-compatible + Anthropic passthrough) | ◐ AI credits (100 free) | — | ◐ AI inside Agents/Tables |
| Typed classification / decision call | — | ● `/v1/decisions` | — | — | — |
| Human-in-the-loop confirmation | — | ● ask-for-input form | — | — | — |
| Chat surfaces (Slack/Teams/web) | — | ● Messaging SDK | — | — | ● Slack etc. as actions |
| Act as the end user (delegated OAuth) | — | ◐ GitHub/Postman/Box only | — | — | ● Zapier-held connections |
| Sandboxed code execution | — | ◐ experimental VM (Python/Node/Browser) | — | ◐ Sandboxes (public beta) | ◐ `write_code_action` |
| Mock / simulate an API (stateful, faults) | — | — | ● code mocks + Simulator | — | — |
| Automated API tests / monitors | ◐ generated SDK tests | — | ● | — | — |
| Agent tracing / observability | — | ● OTel + Insights | ◐ monitor results | ◐ run history (30 d) | ◐ MCP call history |
| Evaluate agent output | — | ● evaluators on traces | ◐ Flows AI evals | — | — |
| Spend / usage governance | — | ● policies + spend limits | — | — | ◐ task caps |
| Per-PR preview stacks | — | ● environments (per-env vars) | — | ◐ previews (Pro; skip Workflows) | — |
| Infra-as-code | ◐ `APIMATIC-BUILD.json` | ● `astropods.yml` | ◐ Native Git | ● `render.yaml` | — |
| Developer portal + docs copilot | ● portal + API Copilot (Business) | — | ◐ published docs | — | — |
| Agent↔agent protocol | — | ● AMP (A2A-interoperable) | — | — | — |

### Access summary vs Dec 21

| Sponsor | Free access | Survives to Dec 21? |
|---|---|---|
| APIMatic | PayPal Context Plugin free with no credentials. Basic is 1 month from approval. | Plugin: yes, unless the preview repo is removed. Basic subscription: depends on approval date. |
| Astropods | Oldest agent's compute is free, plus one-time signup credits for models. | Compute: yes. Model calls: only while credits last, or with your own provider key. |
| Postman | Free plan, no expiry. | Yes, but Flows are capped at 25 credits/mo. |
| Render | Free web services; $50 credits for paid services and Workflows. | Free web services: yes, with cold starts. **Free Postgres expires after 30 days.** Credit expiry is UNVERIFIED. |
| Zapier | 14-day Pro trial, then Free. | **No for PayPal.** It's a premium app, and the trial ends ~Nov 24. |
