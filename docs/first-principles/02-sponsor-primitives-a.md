# 02: Sponsor primitives (A): AG Grid, Bryntum, Channel3, Elastic, KERNEL

This is a first-principles inventory of what each sponsor tool can do. It is raw material for inventing a product, not a list of product ideas. It does not look at what other teams built.

- **Researched:** Nov 9–10, 2026.
- **Key dates:** submission deadline Thu Nov 12, 2026, 12:00 PM PST. Judging runs Dec 1–15. Winners are announced on or around Dec 21. The demo and any trials must stay live through Dec 21 (see `../02-dates-timeline.md`).
- **Sourcing:** every claim cites an official source. Anything that could not be confirmed is marked **UNVERIFIED**. Sponsor-page quotes come from `https://paypalaihackathon.devpost.com/details/<sponsor>`, fetched Nov 9 2026.
- **Access notes:** bryntum.com is behind a Cloudflare challenge, so the Bryntum facts below come from Bryntum's own npm packages (READMEs, `.d.ts` typings and JS source, read as data and never executed) and from the official `github.com/bryntum/skills` repo.

---

## 1. AG Grid: AG Studio, Studio Agent Framework, AG Grid, AG Charts

AG Studio v3.1 (React, Angular, Vue and vanilla JS) is an embeddable dashboard component built on AG Grid and AG Charts. Developers set the guardrails, and end users or agents build reports inside them.
Docs: https://www.ag-grid.com/studio/llms.txt. Every docs page also has a `.md` twin, e.g. https://www.ag-grid.com/studio/react/ai.md.

### 1.1 Core primitives
| Verb | What it does | Source |
|---|---|---|
| **Ingest** | `data.sources[]` takes arrays of plain objects (sync), async fetch-on-demand sources, or a fully custom `AgDataEngine` that pushes queries to a backend. | [Data](https://www.ag-grid.com/studio/react/data/), [Loading Data](https://www.ag-grid.com/studio/react/loading-data/), [Custom Engine](https://www.ag-grid.com/studio/react/server-side-data/) |
| **Model** | Declares multi-table `relationships` (e.g. many-to-one), named `calendars` (a date spine), custom date `buckets`, and `expressions` (calculated columns and measures). An AI-facing `description` can sit on the dataset, each table and each field. | [Data](https://www.ag-grid.com/studio/react/data/), boilerplate `app/dashboard/studio/data.ts` |
| **Query** | A built-in in-browser data engine handles aggregation (group-by plus measures) and projection (raw rows). `executeCube` (custom engines) unlocks pivot and tree widgets. | [Custom Engine](https://www.ag-grid.com/studio/react/server-side-data/) |
| **Cross-filter** | Page filters, widget filters and cross-filters apply live to every widget that reads the table. | [Cross-Filtering](https://www.ag-grid.com/studio/analysts/cross-filtering/) |
| **Stream** | `api.getDataEngine().applyTransaction({tableId, add, update, remove})` changes rows in place. It is atomic across tables, and only the widgets that read a changed table re-query. The live demo pushes a transaction every 100 ms. `createLiveQuery` keeps result sets current. | [Live Data](https://www.ag-grid.com/studio/react/live-data/) |
| **Lay out** | A grid layout with configurable columns and row height, min/max width, auto or fixed height (slide or poster style), standalone single-widget pages and multi-page reports. | [Modes & Layout](https://www.ag-grid.com/studio/react/modes-layout/) |
| **Theme** | Uses the same theming API as AG Grid (`studioTheme.withParams`), CSS vars `--ag-*`, light/dark through `data-ag-theme-mode`, custom colour modes, icon overrides, a visual Theme Builder and a Figma design system. | [Theming](https://www.ag-grid.com/studio/react/theming/) |
| **Extend (widgets)** | `AgWidgetDefinition` plus a React component. The `form` sets the edit panel, `dataMapping` declares required fields, and `widgetApi.getData()` / `getDataHandle()` subscribe to live data. A widget becomes agent-configurable once `formatShape` and `ai` are set. | [Custom Widgets](https://www.ag-grid.com/studio/react/custom-widgets/) |
| **Persist** | `getState()`, `setState()` and `initialState` save reports as JSON. `stateUpdated` events say whether report or view state changed. Undo/redo history can be persisted. | [State](https://www.ag-grid.com/studio/react/state/) |
| **Drill** | The `drillThrough` property opens a detail report under an immutable filter, either in place or in a popup. It is triggered from context-menu items. | [Drill Through](https://www.ag-grid.com/studio/react/drill-through/) |
| **Export** | Print or PDF layout sized in px at 96 px per inch. | [Exporting](https://www.ag-grid.com/studio/react/exporting/) |
| **Mode** | `mode="edit"` or `"view"`. `enableFilterEditingInViewMode` allows filter changes in view mode. | [Modes & Layout](https://www.ag-grid.com/studio/react/modes-layout/) |

### 1.2 How agents build, query and edit dashboards (Studio Agent Framework)
The framework is opt-in through the `AgStudioAiModule`. **AG Studio ships no model, server or backend, and makes no network calls of its own.** You supply an adapter or endpoint. The examples include an OpenAI Responses API adapter that can be repurposed. Source: [Agent Framework Overview](https://www.ag-grid.com/studio/react/ai/).

- **Harness** (`createAiHarness`): owns conversations (threads), the agent roster and delegation, persistence (pluggable `history` store with `listThreads`, `loadThread`, `saveThread`, `deleteThread`), and observability (typed telemetry events for runs, turns, tool calls and token usage, consumed by `observers` such as cost meters or eval scorers). Sources: [Harness](https://www.ag-grid.com/studio/react/ai-harness/), [Built-in Harness](https://www.ag-grid.com/studio/react/ai-builtin-harness/).
- **Three runners:**
  - `directLlmRunner`: you bring a model and Studio runs the loop and the tools.
  - `clientToolRunner`: you bring a server request that answers one turn, and Studio executes any tool calls left unresolved. **The loop can be remote while the actions stay in the browser.**
  - Custom `{...def, run}`: you bring a whole loop.

  Source: [Agent Overview](https://www.ag-grid.com/studio/react/ai-agents/).
- **AG-UI compatible:** agent events mirror the [AG-UI](https://docs.ag-ui.com) wire format (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`…), so an AG-UI-native server drives Studio with no translation layer.
- **Five built-in agents:** Lead (coordinates and delegates), Planning (`create_plan`), Data (`execute_query`, expressions), Page (add, position and remove widgets, page filters) and Widget (`configure_widget`, narrowed per widget type; several run concurrently). The plan is a durable artefact on the thread. Source: [Built-in Agents](https://www.ag-grid.com/studio/react/ai-builtin-agents/).
- **Built-in tools:**
  - Read: `view_schema`, `view_report`, `view_page`, `view_widget`, `execute_query` (row-capped).
  - Mutate: `add_widget`, `position_widget`, `remove_widget`, `configure_widget`, `create_expression`, `update_expression`, `delete_expression`, `add_page_filter`, `remove_page_filter`, `add_widget_filter`, `remove_widget_filter`.
  - Harness: `view_plan`, `create_plan`, `update_plan`, `clear_plan`, `rename_thread`, `delegate_to`, plus an auto-added `complete_task`.

  Tools can be bound to a page (`studio.addWidget({pageId})`). Source: [Built-in Tools](https://www.ag-grid.com/studio/react/ai-tools-builtin/).
- **Custom agents:** spread `builtIn`, re-point the model, replace instructions or tool sets, or declare a whole new team. Instructions and tools are re-resolved every run, never snapshotted. Source: [Agent Configuration](https://www.ag-grid.com/studio/react/ai-custom-agents/).
- **Custom tools:**
  - Defined with `api.defineAiTool`. Parameters can use live helpers such as `s.widgetId()`, whose enums track the dashboard.
  - Built-in commands can be wrapped (`AgExecuteQueryCommand`, `AgAddWidgetCommand`…) and used without any agent through `parse()`, `apply()` and `toJSONSchema()`.
  - Tool `kind` is `client` (runs in the page), `server` (Studio only advertises the schema) or `provided` (a provider-hosted tool such as web search).
  - Emits JSON Schema 2020-12.

  Sources: [Custom Tools](https://www.ag-grid.com/studio/react/ai-custom-tools/), [External Tools](https://www.ag-grid.com/studio/react/ai-tools-external/).
- **Harness swap:** implement `AgAiHarness` and Studio's chat panel still renders it. You can also keep the harness and render your own chat UI, or drop the harness and use only the tools. Source: [Custom Harness](https://www.ag-grid.com/studio/react/ai-custom-harness/).
- **Agent context:** `api.getAiContext()` exposes `schema()`, `catalogue()` (widget types with sizing guidance) and `health` (page and widget health reports that agents use to self-correct). Source: [Agent Context](https://www.ag-grid.com/studio/react/ai-context/).

### 1.3 Unusual or under-used capabilities
- **WebMCP export.** `api.getAiTools()` can be registered with Chrome's `document.modelContext`, so any browser-resident agent can drive the dashboard. The example publishes 4 read-only tools, and the mutating ones work the same way. This is experimental and needs Chrome 149+ behind an origin trial ([WebMCP](https://www.ag-grid.com/studio/react/ai-webmcp/)). It pairs with KERNEL's WebMCP discovery (section 5).
- **Health reports as an agent feedback signal.** A mutating tool can return health issues, so the model fixes misconfigured charts on its own ([Agent Context](https://www.ag-grid.com/studio/react/ai-context/)).
- **Commands work without an LLM.** Validated `apply()` lets deterministic code (for example a webhook handler) mutate dashboards through the same path agents use.
- **The telemetry observer stream** exposes token usage per run, which can feed a cost meter.
- **`server`-kind tools.** The browser advertises a schema whose result your server fills in, e.g. a PayPal lookup.
- **Model picker and prompt starters** in the chat panel. An ag-grid.com AI proxy (`https://ai-api.ag-grid.com/api/openai/v1`) appears in the doc examples. Whether third parties may use it is **UNVERIFIED**, so assume you bring your own key.
- **Boilerplate:** [paypaldev/hackathon-paypal-ag-grid-boilerplate](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate) (Next.js 16, `ag-studio@3.0.0`, `ag-grid-community@36.2.0`).
  - `lib/paypal.ts` handles sandbox OAuth and paging and pulls Catalog Products, Billing Plans, Invoicing v2, Transaction Search and Balances.
  - `lib/dashboard-data.ts` builds related tables: customers, invoices, line items, payments, products, plans, transactions, payouts and balances.
  - `app/api/ai/responses` is a server proxy that holds the OpenAI key and caps output tokens.
  - Reports are saved to localStorage. The README warns that the AI route has no auth or rate limit.
  - The README also notes Transaction Search limits: at most 31 days per request, and new activity takes up to 3 hours to appear.

### 1.4 Inputs and outputs
- **In:** JSON row arrays, async fetchers, or a custom engine over any backend (SQL, REST, warehouse). Also report state JSON, theme params, custom widget definitions, and LLM adapter responses (AG-UI events).
- **Out:** interactive dashboards (grids, pivots, about 9 chart families, value and filter widgets), report state JSON, print or PDF output, tool results (query rows as tables) and a telemetry event stream.

### 1.5 Limits
- **Licence:**
  - AG Studio is an Enterprise product: "Subscription with tailored pricing", plus a **free 45-day trial licence**. Without a key it shows a watermark and console warnings ([Enterprise Licence](https://www.ag-grid.com/studio/react/enterprise-licence/), [Pricing](https://www.ag-grid.com/studio/license-pricing/)).
  - AG Grid Community and AG Charts Community are MIT. AG Grid and AG Charts Enterprise have a separate 30-day trial.
  - **A Studio licence does not cover AG Grid or AG Charts Enterprise used inside custom widgets.**
- **Trial vs. judging:** a key requested Nov 10 lasts 45 days, until about Dec 25, which covers Dec 21. A key requested before ~Nov 6 expires before Dec 21. What happens after expiry (watermark only, or hard block) is **UNVERIFIED**.
- **Data scale:** the built-in engine holds all rows in browser memory. Use a custom engine for large data.
- **Async sources** do not accept transactions (no live updates).
- **WebMCP** is experimental, Chrome-only, behind an origin trial.
- **LLM costs** are yours, since you bring your own provider.

### 1.6 Prize criteria (quoted)
> "**Best Use of AG Grid**. This award covers both what your dashboard looks like and how you build it. Show us polish: custom widgets, theming, and layout tools, not just AG Grid or AG Charts on their own. Take Studio Agent Framework for a spin: a custom agent talking to Studio's built-in agents, or a swapped-in harness."

Prizes: $5,000 / $2,000 / 3 × $1,000 (`../_sources/devpost-overview.txt`).

### 1.7 Combines naturally with PayPal primitives like…
- `applyTransaction` (live rows) ↔ **PayPal webhooks** (`PAYMENT.CAPTURE.COMPLETED`, `...REFUNDED`, `CUSTOMER.DISPUTE.CREATED`) as a row-level event feed.
- Multi-table `relationships` plus a `calendars` date spine ↔ PayPal's joinable entities (Orders, Captures, Refunds, Invoices, Subscriptions, Payouts), keyed by IDs and timestamps.
- `server`-kind or custom tools ↔ **PayPal Agent Toolkit or MCP** functions (`list_invoices`, `get_order`, `list_transactions`) called by a Studio agent.
- `clientToolRunner` (remote loop, local tools) ↔ server-held PayPal credentials, with dashboard mutations still in the browser.
- `drillThrough` immutable filter ↔ one PayPal object's ID (an order, payer or dispute) as the detail scope.
- Calculated measures (`expressions`) ↔ PayPal amount fields (`gross`, `fee`, `net`; multi-currency `{value, currency_code}`).
- Health and telemetry observers ↔ token cost and run accounting set against PayPal transaction value.

---

## 2. Bryntum: Gantt, Scheduler (incl. former Scheduler Pro), Calendar

Bryntum makes pure-JS timeline components with React, Angular and Vue wrappers. **Bryntum 8.0.0 shipped on npm Oct 23, 2026** with three tiers (Community, Business, Enterprise). 7.3.8 trial packages also still exist. Sources:
- npm `@bryntum/gantt-enterprise@8.0.0`, its `AGENTS.md`, `gantt.d.ts` and `lib/` source
- https://github.com/bryntum/skills (`bryntum/SKILL.md`, `bryntum-crud`, `bryntum-features`)
- npm READMEs for `@bryntum/{gantt,scheduler,schedulerpro,calendar}-trial@7.3.8`

### 2.1 Core primitives
| Verb | What it does | Source |
|---|---|---|
| **Propagate** | The scheduling engine (the `ProjectModel`) recalculates dependent tasks whenever one moves. It is asynchronous, constraint-based, and "runs in browser or server-side on Node.js". | gantt-trial README |
| **Link** | Dependencies of type `0` Start-to-Start, `1` Start-to-End, `2` End-to-Start (the default) and `3` End-to-End, with lag and lead (not available on Gantt Community). | skills `bryntum-features/references/timeline.md` |
| **Constrain** | `constraintType` options: `startnoearlierthan`, `startnolaterthan`, `finishnoearlierthan`, `finishnolaterthan`, `muststarton`, `mustfinishon`, `assoonaspossible`, `aslateaspossible`. Also `deadlineDate`, and backward (ALAP) scheduling via `project.direction`. | `gantt.d.ts`; skills `references/gantt.md` |
| **Calendar** | Working-time calendars (recurrent intervals, holidays and shifts) at project, resource or event level. The engine skips non-working time. | skills timeline.md |
| **Allocate** | Assign resources to events or tasks (multi-assignment via the `assignments` store). `schedulingMode` can be `Normal`, `FixedDuration`, `FixedEffort` or `FixedUnits`. Resource histogram and utilization views (Enterprise), plus skill-based matching. | `gantt.d.ts`; schedulerpro README |
| **Cost** | Assignments carry a projected `cost`, calculated from a resource **`rateTable`** (Business tier and up). | `gantt.d.ts` (`AssignmentModelBusiness#config-rateTable`) |
| **Analyse** | Critical path (`criticalPaths`), early and late dates, `totalSlack`, baselines, progress line, S-curve, conflict detection (`schedulingConflict` event) and resolution. | gantt README; `gantt.d.ts` |
| **Drag / drop / resize** | Built in, including dragging from external grids. Veto hooks: `beforeEventDrop`, `beforeEventResize`, `beforeEventAdd`, `beforeDragCreate`. | scheduler README; `scheduler.d.ts` |
| **Sync** | The project is the CrudManager: `loadUrl` and `syncUrl` with `autoLoad` / `autoSync`. Sync sends changed fields only and expects phantom-ID mapping back. API includes `changes`, `acceptChanges()`, `revertChanges()` and `hasChanges()`. Events: `beforeSync`, `sync`, `syncFail`, `hasChanges`, `dataChange`. | skills `bryntum-crud`; `.d.ts` |
| **Recur** | Calendar handles recurring events with exceptions and travel time. Views: day, week, month, year and agenda; Enterprise adds resource, day-resource, year-planner and others. | calendar README; skills SKILL.md |
| **Export** | Excel, MS Project, PDF and PNG, and ICS. | gantt and scheduler READMEs |
| **Version** | `versions` (save and compare), undo/redo. | gantt README |

### 2.2 AI and agent features
- **Built-in AI feature (Enterprise tier only).** `features: { ai: {...} }` on Grid, Scheduler and Gantt adds a chat panel where natural language filters, sorts, selects and **adds, updates or deletes records**.
  - Provider plugins ship for OpenAI, Anthropic and Google.
  - `promptUrl` points at your backend proxy.
  - `tools` lets you add custom tools or remove existing ones.
  - `trainingData` takes few-shot example conversations.
  - Planning tools: `planning: true` enables `createPlan` / `completePlanSteps`.
  - `undo` / `redo` for AI actions.
  - Confirmation gates: `requireConfirmationOnAdds`, `requireConfirmationOnUpdates`, `requireConfirmationOnRemovals`.
  - Voice: `transcribeUrl`, `textToSpeechUrl`, `voiceOnly`, `voiceActivation`.
  - Also `@mentions`, `highlightRelatedItems`, `feedbackUrl` (thumbs up/down) and a model selector.

  Sources: `grid.d.ts` `AIConfig`; `gantt.d.ts` (`class AI extends SchedulerAI`); `lib/Core/feature/ai/apiPlugins/{OpenAI,Anthropic,Google}Plugin.js`. Business and Community core packages contain no AI files.
- **Scheduler agent tools** (from `SchedulerToolHost.js`): select, filter, highlight and unhighlight events; change the timeline span; scroll to a date; set the data scope; copy and paste events; assign and unassign resources; **find the next available slot** (`duration` like "2hours" with an "all matching resources available" flag); link and unlink dependencies. Gantt adds: get children, toggle critical path, WBS-code addressing.
- **`toolAdapter` (experimental, Enterprise).** It hands the feature's tools to an external agent, with no chat panel or `promptUrl` needed:
  - `toolAdapter.listTools()` returns `{name, description, inputSchema, annotations}` with MCP- and WebMCP-style hints (`readOnlyHint`, `destructiveHint`, …).
  - `callTool(name, args)` runs a tool, and `onToolsChanged` reports changes.
  - Options: `writes: false` gives a read-only set, `prefix` namespaces the tools, `confirmTimeout` bounds confirmations.
  - `webMCP: true` also registers the tools with `document.modelContext`, with `exposedTo` origins and an `allowInIframe` option.

  Source: `lib/Core/feature/ai/adapters/{AgentToolAdapter,WebMCPAdapter}.js`.
- **Developer AI:** a hosted docs MCP server at `https://mcp.bryntum.com` (`search_bryntum_docs`), agent skills (`npx skills add bryntum/skills`), and an `AGENTS.md` inside each npm package.

### 2.3 Unusual or under-used capabilities
- **Server-side scheduling engine:** `@bryntum/gantt-node-enterprise` and `@bryntum/scheduler-node-enterprise` run `ProjectModel` in Node, "do the scheduling calculations and find the conflicts on the server", and push live updates over WebSocket. The package README says Enterprise licence only, so **whether the trial covers it is UNVERIFIED**.
- **"Next available slot" as a callable tool:** a constraint solver an agent can invoke.
- **Rate tables and cost** turn scheduled time into money natively.
- **Veto hooks** (`before*`) give a synchronous gate in front of any drag, resize or create, so the UI can refuse a change.
- **`highlightRelatedItems` and the AI undo stack** make agent edits visible and reversible.
- **Pure data layer:** the engine works headless (no UI) for what-if simulation.

### 2.4 Inputs and outputs
- **In:**
  - JSON stores for tasks or events, resources, assignments, dependencies, calendars and time ranges, inline or through CrudManager `load`.
  - User gestures (drag, resize, editor).
  - Natural-language prompts (AI feature) and external tool calls (`toolAdapter`).
- **Out:**
  - Recalculated start and end dates, slack, critical-path flags, conflicts, and cost.
  - Change sets sent to `syncUrl` (changed fields only).
  - Events (`dataChange`, `eventDrop`, `schedulingConflict`).
  - Exports (XLSX, MPP-compatible, PDF/PNG, ICS).

### 2.5 Limits
- **Tiers (8.0):**
  - **Community:** free, MIT, no key. It runs a lighter engine: no working-time calendars, constraints, critical path, lag/lead, effort or scheduling direction.
  - **Business** and **Enterprise:** "work without [a key] as a 14-day trial with every feature, counted per product from the first time it runs in the browser… after it, the component is masked. A free trial key (https://bryntum.com/download/) extends the trial to 45 days."
  - Source: skills `bryntum/SKILL.md`.
  - AI, `toolAdapter`, critical path, baselines, histograms and nested events are **Enterprise**. Rate tables are **Business**.
- **Trial vs. judging:** a 14-day keyless trial started Nov 10 ends about Nov 24, **before judging**. Get the free 45-day key, which runs to about Dec 25 and covers Dec 21. The trial is counted per product and per browser from first run; how that behaves on judges' browsers is **UNVERIFIED**, so get the key regardless.
- **The Devpost page's command** `npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial` installs **7.3.8** (watermarked, un-minified). 8.0 uses `@bryntum/<product>-<tier>` instead. Don't mix versions or tiers.
- One licence covers only the products listed on it, so a Gantt key does not cover a Scheduler on the same page.
- AI adapter/WebMCP marked `@experimental`.

### 2.6 Prize criteria (quoted)
> "**Best Use of Bryntum**. This prize goes to the project that puts Gantt, Scheduler, and/or Calendar to the best use, whether that's the cleanest timeline, the smartest resource booking, or an agent that drives the schedule itself."

Prizes: 3 × $1,000.

### 2.7 Combines naturally with PayPal primitives like…
- Dependency engine (End-to-Start plus lag) ↔ the **PayPal authorization window**: authorize, then capture within the honor period or validity (3 days / 29 days per PayPal docs; **UNVERIFIED in this pass**, see https://developer.paypal.com/docs/checkout/standard/customize/authorization/).
- `finishnolaterthan` / `deadlineDate` constraints ↔ **dispute response deadlines** (`seller_response_due_date` on Disputes API) and invoice `due_date`.
- Rate tables and assignment `cost` ↔ **Orders v2 `purchase_units.amount`** and **Invoicing line items** (the computed cost becomes the charge).
- `before*` veto hooks ↔ PayPal order status (`APPROVED` / `COMPLETED`) as the gate before a booking is locked.
- CrudManager `sync` / `syncFail` ↔ **PayPal webhooks** as the server-side writer, with the engine re-propagating on load.
- Recurrence (Calendar) ↔ **Subscriptions billing cycles** (`frequency.interval_unit`, `total_cycles`).
- Find next available slot ↔ **Pay Later / payment-plan** due dates. (UNVERIFIED that Pay Later exposes installment dates via API.)
- Node engine ↔ **webhook handlers**, so the schedule is recomputed server-side on `PAYMENT.CAPTURE.*` events.

---

## 3. Channel3

Channel3 is one product-data API over **100M+ products from 25,000+ retailers** (sponsor page). It is exposed through REST, SDKs (TS and Python), a CLI, an MCP server, UCP, MPP, and agent-toolkit packages for the Vercel AI SDK, LangChain and Mastra.
Docs index: https://docs.trychannel3.com/llms.txt (docs served from channel3.mintlify.dev). OpenAPI: https://channel3.mintlify.dev/docs/openapi/openapi.json (base `https://api.trychannel3.com`, header `x-api-key`).

### 3.1 Core primitives (endpoints)
| Verb | Endpoint | Credits | Notes |
|---|---|---|---|
| **Search** | `POST /v1/search` | 1 | `query`, `image_url` or `base64_image`, `limit`, `filters`, `config`, `page_token`. `config.mode` is `keyword`, `default` (lexical plus semantic) or `agentic`. |
| **Agentic search** | `config.mode: "agentic"` | 1 | An LLM plans the search: it extracts filters (category, brand, retailer, gender, age, condition, price ranges, hex colours, category attributes, dimensions), splits OR/AND branches, pins SKU/MPN/GTIN/UPC/EAN, and merges results ([guide](https://docs.trychannel3.com/docs/guides/agentic-search)). |
| **Browse** | `POST /v1/browse` | 1 | Pages through products for a filter set. |
| **Image search** | `POST /v1/image-search` | 1 | By URL or base64. |
| **Find in image** | `POST /experimental/find-products-in-image` | 1 + 1 per thing | Detects objects in a scene, localises them (optional masks), and searches per crop. |
| **Sticker** | `POST /experimental/sticker` | 1 | Turns the best product image into a transparent cut-out. |
| **Similar** | `POST /v1/similar` | 1 | |
| **Lookup** | `POST /v1/lookup` | 1 | Any retailer product URL to a canonical product plus offers. |
| **Detail** | `GET /v1/products/{id}` | **free** | Fresh prices, availability and offers. Recommended at display time. |
| **Taxonomy** | `/v1/brands`, `/v1/websites`, `/v1/categories` (+ `/search`, `/{id}`) | free | Brands and websites carry `best_commission_rate`. Categories have attribute schemas. |
| **Collections** | `/v1/collections` CRUD | free | Saved scopes of brand, website and category clauses, applied via `config.collection_id`. |
| **Conversations** | `POST /v1/conversations` (turn), `GET /v1/conversations/{id}` | 1 per turn + searches | Hosted shopping agent with memory, streaming, follow-up questions and offer comparison. Browser-safe **client tokens** (`c3_ct_…`, 60–7200 s TTL, scope pinned server-side). |
| **Watch** | `POST /v1/product-subscriptions` | free | Webhooks `offer.price.changed`, `offer.availability.changed`, `offer.created` and `offer.deleted`, pinned to one variant `selection` and up to 25 domains. HMAC-signed; respond 2xx within 15 s. |
| **Price history** | `GET /v0/price-tracking/history/{id}` | (UNVERIFIED) | `start`/`stop` tracking is deprecated (1 credit per product per day). History is still supported. |
| **Report** | `GET /v1/reporting/{clicks,transactions,usage}` | (UNVERIFIED, probably free) | Windows of up to 90 days. `x-user-id` on search attributes clicks and sales to your users. |
| **Monetize** | `POST /v1/monetize` | | **Restricted access.** Returns monetizable offers for a URL. |

Sources: [Pricing](https://docs.trychannel3.com/docs/pricing), OpenAPI.

### 3.2 Data fields (inputs and outputs)
- **Product:** `id`, `title`, `description`, `brands`, `images[]`, `category`, `gender`, `age`, `materials`, `key_features`, `colors`, `offers[]`, `variants`, `structured_attributes`, `ratings` (`value` 0–5 count-weighted, `count`, `source_count`).
- **Image:** `url`, `cleaned_url` (background removed, square), `is_main_image`, `shot_type` (hero, lifestyle, on_model, detail, size_chart, packaging…), `alt_text`.
- **Offer** (price lives here, not on the product): `url` (an attributed `buy.trychannel3.com` link), `domain`, `price{price, compare_at_price, currency}`, `availability` (`InStock`/`OutOfStock`), `condition` (new/used/refurbished), `max_commission_rate` (decimal), `dimensions`. Source: [Offer](https://docs.trychannel3.com/docs/guides/offer).
- **Variants:** `{options:[{name, values:[{label, exists, available}]}], selected:[…]}`. "Variant support is rolling out. It is not yet live on all products." Source: [Variant](https://docs.trychannel3.com/docs/guides/variant).
- **Filters** (`SearchFilters`): `price{min_price, max_price}`, `brand_ids` / `exclude_brand_ids`, `website_ids` / `exclude_website_ids`, `category_ids` / `exclude_category_ids`, `gender`, `age`, `conditions`, `availability`, `sale`, `colors`, `attributes`, `dimensions`. A product matches if at least one offer satisfies all offer-level filters.
- **Locale:** 20 countries plus a pan-EU option, 10 currencies (USD, CAD, AUD, GBP, EUR, SEK, CZK, RON, CHF, PLN) and 13 languages ([Catalog & Coverage](https://docs.trychannel3.com/docs/faq/catalog-and-coverage)).
- **`offer_refresh_timeout_ms`** (2000–10000) checks each returned offer against the merchant's live site and drops dead ones.

### 3.3 MCP server
- **Free tier:** `https://mcp.trychannel3.com/` with no key and "generous" personal-use limits. Adding `X-API-Key` gives unlimited, pay-as-you-go usage and attributed buy links ([Free Tier](https://docs.trychannel3.com/docs/mcp/free-tier)).
- **Tools:**
  - `search_products`: plain language and/or `image_url`. "Search is semantic and takes **no filter parameters**, so constraints belong inside the description."
  - `get_products`: up to **40** products by ID or retailer URL, with all offers, variants and attributes.
  - Source: [Available Tools](https://docs.trychannel3.com/docs/mcp/tools).
- **MCP Apps:** on hosts that support it (Claude, ChatGPT), results render as a browsable storefront.
- **UCP catalog:** `https://ucp.trychannel3.com/mcp` exposes `search_catalog`, `lookup_catalog` and `get_product` (Universal Commerce Protocol), with anonymous or token tiers ([UCP](https://docs.trychannel3.com/docs/ucp/index)).

### 3.4 Checkout and monetization model
- **No checkout today.** "Checkout is **coming soon**. Today, Channel3 helps you discover products and earn commissions when shoppers buy through retailer links." ([Checkout](https://docs.trychannel3.com/docs/checkout))
- **Affiliate model:** buy links are tracked automatically. Sales are attributed after the retailer's return window closes and paid out via **Stripe**. **Channel3 takes 50% of commissions.** You must show the disclosure: "We may earn a commission when you buy through links on this page." Retailers can claw back commissions for returns or fraud ([Commissions](https://docs.trychannel3.com/docs/commissions)).
- **MPP pay-per-call:** $0.007 USDC.e per call on Tempo, no signup, for `/v1/search`, `/v1/image-search`, `/v1/similar` and `/v1/lookup` ([MPP](https://docs.trychannel3.com/docs/mpp)).

### 3.5 Unusual or under-used capabilities
- **Offer-level price, availability and condition webhooks, which are free.** A canonical product can be watched across retailers.
- **`compare_at_price`** captures sale and markdown signals, and **new-vs-used offers** sit on the same canonical product.
- **Find-products-in-image with masks** turns a scene image into purchasable line items.
- **Client tokens** give a browser-side hosted shopping agent without exposing the API key.
- **Collections** act as server-pinned catalog scopes (allow and deny lists).
- **`x-user-id` attribution** joins clicks and commissions back to your own users.
- **Shadcn UI blocks** (`product-search`, `product-details` with price-history chart and variant picker): `npx shadcn@latest add https://ui.trychannel3.com/r/all.json` ([UI + Hooks](https://docs.trychannel3.com/docs/guides/ui-and-hooks)).
- **Caching rule:** cache only IDs. Prices, offers and buy URLs are unstable and must be refreshed, using the free detail endpoint ([Caching](https://docs.trychannel3.com/docs/guides/caching)).

### 3.6 Limits
- **Credits:** normally 1,000 free per month, then $0.007 each. **Hackathon:** promo `PAYPAL-HACKATHON-2026` gives 20,000 credits, "good for 20,000 product searches". If you run out, "your key stays active. Message us in the #channel3 hackathon Discord channel and we'll top you up" (sponsor page). Whether the promo credits expire is **UNVERIFIED**.
- **Rate limits:** a new key starts on `default`: 10 req/s on most endpoints, 10/s search, 5/s lookup, **10,000 requests per day** shared. A 429 comes with `Retry-After: 5` ([Rate Limits](https://docs.trychannel3.com/docs/faq/rate-limits)).
- **Product subscriptions** read in en/US/USD only. Variant data is partial. Coverage outside the US is still growing.
- There is no trial clock: the key does not expire, so it is safe through Dec 21 (per sponsor page; credit balance UNVERIFIED).

### 3.7 Prize criteria (quoted)
> "Your project may use the Channel3 API or our MCP server as a meaningful part of the product experience: search, product enrichment or recommendations. Projects that only reference Channel3 without calling it will not meet this requirement."

Prize: **Best Use of Channel3, $1,500 (1 winner)** (`../_sources/devpost-overview.txt`).

### 3.8 Combines naturally with PayPal primitives like…
- `offers[].price{price, currency}` ↔ **Orders v2 `purchase_units[].amount` / `items[]`** (unit_amount, quantity, SKU from GTIN or attributes).
- `offer.price.changed` / `offer.availability.changed` webhooks ↔ the **authorization hold**: re-check price and stock between PayPal `authorize` and `capture`.
- `max_commission_rate` + reporting transactions ↔ **PayPal Payouts** (splitting earned commission onward).
- Canonical product with N offers ↔ **multi-`purchase_units` orders** (one per retailer or payee).
- `compare_at_price` / price history ↔ **Pay Later** messaging thresholds by amount.
- Find-in-image line items ↔ **Invoicing** line items.
- The buy-link-only model ↔ PayPal used for the *user's own* funds flow (wallet, escrow-like authorize, reimbursement). Channel3 itself cannot take a PayPal payment.

---

## 4. Elastic

Elasticsearch, Kibana and Elastic Cloud Serverless.
Docs index: https://www.elastic.co/docs/llms.txt. Every docs page has a `.md` twin.

### 4.1 Core primitives
| Verb | What it does | Source |
|---|---|---|
| **Index** | JSON documents, with `semantic_text` / `semantic` fields that auto-embed at ingest, or your own vectors (`dense_vector`). | [Vector Database](https://www.elastic.co/docs/solutions/vector-database) |
| **Search (lexical, vector, hybrid)** | BM25, kNN, sparse ELSER, and hybrid fusion via retrievers (RRF / linear). | [Vector Database](https://www.elastic.co/docs/solutions/vector-database), [Semantic reranking](https://www.elastic.co/docs/solutions/search/ranking/semantic-reranking) |
| **Rerank** | `RERANK` in ES\|QL and rerank inference endpoints (Jina). | [ES\|QL processing commands](https://www.elastic.co/docs/reference/query-languages/esql/commands/processing-commands) |
| **Query (ES\|QL)** | A piped query language. Commands include `STATS`, `INLINE STATS`, `LOOKUP JOIN`, `ENRICH`, `FORK` + `FUSE` (hybrid in ES\|QL), `RERANK`, `COMPLETION` (LLM call per row), `CHANGE_POINT` (detect shifts or spikes), `SAMPLE`, `MMR`, `DENSE_VECTOR`, `GROK`/`DISSECT`, `IP_LOCATION`, `TS_*` time-series. | same |
| **Embed / infer** | Inference API endpoints (`embedding`, `rerank`, `chat_completion`…) for EIS-hosted models or external providers. | [Inference API](https://www.elastic.co/docs/explore-analyze/elastic-inference/inference-api), [EIS](https://www.elastic.co/docs/explore-analyze/elastic-inference/eis) |
| **Agent (Agent Builder)** | Chat, agents, skills and tools over your indices. **GA on Serverless and on Stack 9.3+.** | [Agent Builder](https://www.elastic.co/docs/explore-analyze/ai-features/elastic-agent-builder) |
| **Automate (Workflows)** | YAML workflows with triggers, steps and Liquid templating. GA on Stack 9.4+. | [Workflows](https://www.elastic.co/docs/explore-analyze/workflows) |
| **Alert / detect** | Alerting rules, ML anomaly detection, Security detections, Observability (logs, metrics, APM). Mostly general knowledge; only alert triggers and `platform.alerting.*` tools were verified here. | [AI features](https://www.elastic.co/docs/explore-analyze/ai-features) |

### 4.2 Agent Builder detail
- **Built-in tools:** `platform.core.search`, `execute_esql`, `generate_esql`, `get_document_by_id`, `index_explorer` and `list_indices`, plus `create_visualization`, cases, alerting, workflows and streams families. Serverless also gives every agent HTTP API tools for calling Elasticsearch and Kibana APIs ([Built-in tools](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/tools/builtin-tools-reference)).
- **Custom tool types:** **ES|QL tools** (parameterised fixed queries), **Index search tools** (the LLM builds the query, scoped to indices), **MCP tools** (import an external MCP server's tools) and **Workflow tools** (an agent triggers a workflow). Per-tool human-in-the-loop `confirmation.askUser` can be `never`, `once` or `always`. Direct Tools API calls skip confirmation ([Custom tools](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/tools/custom-tools)).
- **Skills:** bundles of knowledge plus tools that load based on the user's query ([overview](https://www.elastic.co/docs/explore-analyze/ai-features/elastic-agent-builder)).
- **Out to external clients:**
  - **MCP server** at `{KIBANA_URL}/api/agent_builder/mcp`, authenticated by API key, or OAuth 2.1 on Serverless ([MCP server](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/mcp-server)).
  - **A2A server:** `GET /api/agent_builder/a2a/{agentId}.json` returns the agent card and `POST /api/agent_builder/a2a/{agentId}` speaks the protocol. Non-blocking `message/send` plus `tasks/get` works on Serverless and 9.4.5+. `message/stream` is Serverless only ([A2A](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/a2a-server)).
  - Kibana REST APIs for agents, tools and conversations.
- **Models:** preconfigured LLMs on Cloud and Serverless, or any inference endpoint, local LLMs included.
- **Agents and workflows:**
  - Pre-execution workflows run before the LLM. They can rewrite the prompt, add context or cancel the run, with a 120 s cap.
  - Post-execution workflows run after the response (Serverless).
  - An `ai.agent` step invokes an agent from a workflow.
  - Workflows can also be generated from chat in plain language.
  - Source: [Agents & workflows](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/agents-and-workflows).

### 4.3 Elastic Workflows detail
- **Triggers:** `manual` (UI or **API**), `scheduled` (intervals or RRule), `alert` (a rule fires and the full alert context is passed), and event-driven triggers (`workflows.failed`, cases changes, entity-store risk changes, Agent Builder conversation events) ([Triggers](https://www.elastic.co/docs/explore-analyze/workflows/triggers)).
- **Steps:**
  - Action: Elasticsearch, Kibana, Cases, Security, Streams, and external systems via connectors (Slack, email, **any HTTP API**).
  - Flow control: `if`, `switch`, `foreach`, `while`, `parallel`, `wait`, **`waitForInput`** (human pause).
  - AI: `ai.prompt` (structured output), `ai.classify`, `ai.summarize`, `ai.agent`.
  - Data transforms, and composition (call child workflows sync or async).
  - Source: [Steps](https://www.elastic.co/docs/explore-analyze/workflows/steps), [Action steps](https://www.elastic.co/docs/explore-analyze/workflows/steps/action-steps).
- **No inbound-webhook trigger type is listed.** An external event (e.g. a PayPal webhook) would reach a workflow through your own relay calling the manual-trigger API. Whether there is a public "run workflow" REST endpoint and how it authenticates is **UNVERIFIED**; the docs only say "UI or API".

### 4.4 Jina embeddings, rerankers and the inference API
Source: [Jina models](https://www.elastic.co/docs/explore-analyze/machine-learning/nlp/ml-nlp-jina), [EIS](https://www.elastic.co/docs/explore-analyze/elastic-inference/eis).

**Models available on EIS (Elastic-hosted, no ML nodes to manage):**
- Text embeddings: `jina-embeddings-v5-text-small` (1024-d, 32K tokens), `-v5-text-nano` (768-d, 8K) and `jina-embeddings-v3`.
- **Multimodal embeddings:** `jina-embeddings-v5-omni-small` and `-omni-nano` put text, image, **audio, video and PDF** in one vector space, with Matryoshka truncation. `jina-clip-v2` covers text and image.
- **Rerankers:** `jina-reranker-v3.5` (listwise, 131K) and `jina-reranker-v2-base-multilingual`.
- **OCR:** `jina-ocr-v1` turns a page image into Markdown (tables, formulas, reading order). Its task type is `chat_completion`. GA on Serverless.
- Also ELSER (sparse) on EIS.

**Available only through the external Jina API:** `jina-embeddings-v4`, `jina-vlm` (visual question answering), `jina-code-embeddings`, `ReaderLM-v2` (HTML to Markdown/JSON), `jina-reranker-m0` (multimodal) and `jina-colbert-v2`.

**Example inference endpoint:** `{"service":"elastic","service_settings":{"model_id":"jina-embeddings-v5-omni-small"}}` with the `embedding` task type.

### 4.5 Unusual or under-used capabilities
- **`COMPLETION` and `RERANK` inside ES|QL:** LLM and reranker calls run per row inside a query pipeline.
- **`CHANGE_POINT`:** native spike and shift detection on a time series, inside the query.
- **`FORK` / `FUSE`:** hybrid retrieval expressed in a single ES|QL query.
- **Pre-execution workflows as a policy gate:** deterministic code decides whether the LLM runs.
- **Multimodal Jina omni embeddings:** audio, video and PDF searchable next to text.
- **`waitForInput`** gives a human-approval pause inside automation.
- **A2A agent cards** let other agent frameworks discover and call Elastic agents.

### 4.6 Inputs and outputs
- **In:** JSON docs, logs, metrics and traces (Elastic Agent / OTel), files via OCR, images, audio and video (through multimodal embeddings), natural-language chat, MCP/A2A calls, alert events, schedules.
- **Out:** ranked hits, ES|QL tables, agent answers grounded in tool results, visualizations, cases, workflow side-effects (HTTP calls, Slack, index writes), A2A/MCP responses.

### 4.7 Limits
- **Cloud trial:** 14 days, 1 hosted deployment + 3 Serverless projects. Serverless Search Power is capped at 100 and the Boost Window at 7 days. Scaling is limited. **"Token usage for LLMs and other ML models is restricted during the trial period"** ([Evaluate during a trial](https://www.elastic.co/docs/get-started/evaluate-elastic)).
- **Extension:** "Once your 14-day free trial ends, you are able to self-extend for a further 30 days" via https://www.elastic.co/trialextension (sponsor page).
- **Trial vs. judging:** started Nov 10, the trial ends ~Nov 24; with the extension it ends ~Dec 24, which covers Dec 21. **The extension must be filed promptly**, and the demo must not depend on lapsed tokens.
- **Local install:** a free **Basic** licence never expires. **Agent Builder and Workflows need higher subscriptions** (Workflows: "Enterprise subscription" on Stack). A self-managed 30-day trial started Nov 10 ends ~Dec 10, **before Dec 21**. Running locally therefore covers search and ES|QL, but not Agent Builder or Workflows, through judging.
- Whether the Serverless trial's project feature tier includes Workflows and the Agent Builder MCP server is **UNVERIFIED** (likely "Complete").
- Several features are Serverless-first or "Planned" on Stack: post-execution workflows, A2A streaming, HTTP API tools.

### 4.8 Prize criteria
**No dedicated Elastic prize** (an Elastic judge, Carly Richmond, sits on the panel). Sponsor-page guidance, quoted:
> "You can build a multi-step AI agent that uses Elasticsearch combining a Jina embedding model. You are also free to combine it with one or more of Elastic's available capabilities (such as Elastic Agent Builder, Elastic Workflows, Search, ES|QL, Observability, Security, or the A2A/MCP connectivity) to automate real-world tasks."

### 4.9 Combines naturally with PayPal primitives like…
- Index of **Transaction Search** rows (`/v1/reporting/transactions`, event codes such as `T0001`) ↔ ES|QL `STATS` / `CHANGE_POINT` over amount and fee.
- **Alert trigger → workflow `if` + HTTP step** ↔ PayPal REST actions (refund a capture, add dispute evidence, hold a payout).
- `waitForInput` ↔ the human approval needed before PayPal `capture` or `refund`.
- Agent Builder **MCP tools** importing the **PayPal MCP server** ↔ PayPal tools next to `execute_esql` in a single agent.
- Hybrid search plus Jina rerank ↔ matching free-text **dispute reasons**, invoice memos and `item.description` to policy or precedent.
- `jina-ocr-v1` ↔ receipts and invoices as PDF or images turned into PayPal **Invoicing** line items or dispute evidence.
- `LOOKUP JOIN` ↔ joining PayPal payer, payee and merchant IDs to an enrichment index.
- **A2A** ↔ a PayPal-side agent (e.g. one using the Agent Toolkit) calling an Elastic agent for retrieval.

---

## 5. KERNEL

KERNEL provides cloud Chromium browsers for agents (it asks to be written "KERNEL" in caps).
Docs: https://www.kernel.sh/docs/llms.txt and https://www.kernel.sh/llms.txt. API base `https://api.onkernel.com`, OpenAPI at https://www.kernel.sh/openapi.json, MCP at `https://mcp.onkernel.com/mcp`. SDKs: TS `@onkernel/sdk`, Python and Go. CLI: `brew install kernel/tap/kernel` or `npm i -g @onkernel/cli`.

### 5.1 Core primitives
| Verb | What it does | Source |
|---|---|---|
| **Spawn** | `browsers.create()` returns `session_id`, `cdp_ws_url` and `browser_live_view_url`. Headful (8 or 16 GB) or headless (1, 2 or 4 GB). | [Concurrency & limits](https://www.kernel.sh/docs/browsers/concurrency-and-limits) |
| **Pool** | Pre-warmed browser pools give instant `acquire`/`release`, skip the create rate limit, and cost nothing while idle (but still count against concurrency). | [Browser Pools](https://www.kernel.sh/docs/browsers/pools) |
| **Drive** | CDP (Playwright, Puppeteer), WebDriver BiDi, **Playwright code executed inside the browser VM**, computer controls (mouse, keyboard, screenshot), a persistent JS REPL, shell `exec` / process management. | [Control](https://www.kernel.sh/docs/introduction/control.md) |
| **Watch** | The live view URL can be embedded in an iframe. `?readOnly=true` makes it view-only, and it posts parent-frame events (`KERNEL_CONNECTED`, `KERNEL_PLAYING`…). | [Live View](https://www.kernel.sh/docs/browsers/live-view) |
| **Record** | Replays: start and stop multiple mp4 recordings per session. | [Replays](https://www.kernel.sh/docs/browsers/replays) |
| **Persist** | Profiles save and reuse cookies and storage across sessions (with concurrency and sharing rules). | [Profiles](https://www.kernel.sh/docs/browsers/profiles) |
| **Authenticate** | Managed Auth connections log in per domain, store the result in a profile, run health checks, and auto-reauthenticate when no human input is needed. Comes with a hosted UI and a React component. | [Managed Auth](https://www.kernel.sh/docs/auth/managed-auth) |
| **Vault / fill** | Encrypted credentials, passkeys and payment items. The `fill` API injects values into fields **without the values passing through your app or the model**. 1Password agentic autofill. | [Vaults](https://www.kernel.sh/docs/vaults/overview), [Payments](https://www.kernel.sh/docs/browsers/payments) |
| **Pay** | Wallet integrations: the user's own card (network token plus one-time code), Link by Stripe, Shop Pay, AgentCard, single-use cards, BYO VGS vault, embedded card capture. **PayPal is not listed** (no "paypal" anywhere in llms-full.txt). | [Wallets](https://www.kernel.sh/docs/integrations/wallets/overview.md) |
| **Stealth** | Anti-detection defaults, stealth mode with a CAPTCHA solver, residential, ISP, mobile and custom proxies, per-host proxy routes, egress allowlists, and Web Bot Auth (a verifiable agent identity, Start-Up plan and up). | [Stealth](https://www.kernel.sh/docs/browsers/bot-detection/overview) |
| **Fetch as browser** | Browser `curl` sends HTTP requests with the browser's cookie jar, TLS fingerprint, proxy and headers. | [Curl](https://www.kernel.sh/docs/browsers/curl) |
| **Files** | Download, upload and filesystem APIs. Files are deleted when the session ends. | [File I/O](https://www.kernel.sh/docs/browsers/file-io) |
| **Observe** | Opt-in telemetry categories (`control`, `platform`, `connection`, `system`, `captcha`…) streamed over SSE or exported via OTLP. | [Telemetry categories](https://www.kernel.sh/docs/browsers/telemetry/categories) |
| **Host code** | Apps: deploy actions co-located with browsers and invoke them via API or CLI (sync calls time out at 100 s; async also available). | [Invoke an App](https://www.kernel.sh/docs/apps/invoke) |
| **Discover tools** | WebMCP: `GET /browsers/{id}/webmcp/tools` lists the structured tools a page registered via `document.modelContext`, and invokes them instead of clicking. Enabled by default. | [WebMCP](https://www.kernel.sh/docs/browsers/webmcp) |

### 5.2 Spin-up time and performance (as claimed)
- **"<30ms browser spin-up"** (sponsor page; the docs say each browser is its own VM, "that's what makes a 30ms start and strong isolation possible").
- **KERNEL's own llms.txt** cites **794 ms average cold start**, request to ready browser, on browserbench (Jan 2026), and 6.43 actions/sec on ComputeSDK (Aug 2026).
- Reading the two together: 30 ms is likely VM start or pool acquire, while ~0.8 s is the end-to-end create. The exact figure for an on-demand create is **UNVERIFIED**.
- **Standby:** after 5 s of inactivity a browser goes to standby, keeps its state and incurs **zero usage cost** (it still holds a concurrency slot). GPU browsers don't support standby ([Standby](https://www.kernel.sh/docs/browsers/standby)).

### 5.3 APIs, SDKs and integrations
- **MCP server tools:** `manage_browsers`, `manage_profiles`, `manage_browser_pools`, `manage_proxies`, `manage_extensions`, `manage_apps`, `computer_action`, `execute_playwright_code`, `browser_repl`, `webmcp`, `manage_replays`, `exec_command`, `search_docs`. OAuth or API key; streamable HTTP or stdio ([MCP Server](https://www.kernel.sh/docs/reference/mcp-server)).
- **Agent harnesses:** Claude Code/Desktop, Claude Managed Agents, Claude Agent SDK, OpenAI Agents SDK and Codex, Vercel AI SDK, Replit, Hermes.
- **CUA models:** Anthropic, OpenAI, Gemini 2.5 Computer Use, Yutori, OpenAGI, Tzafon.
- **Frameworks:** Playwright, Stagehand, Vercel Agent Browser, Vibium, **Browser Use** (cookbook at github.com/kernel/cookbooks), Magnitude.
- Source: [Integrations](https://www.kernel.sh/docs/integrations/overview).

### 5.4 Unusual or under-used capabilities
- **Value-free `fill`:** secrets and card data go into DOM fields without the LLM ever seeing them. Results are per-field outcomes, not values.
- **Read-only embeddable live view** with postMessage state events, usable as a "watch the agent" pane in your own UI.
- **WebMCP tool discovery** makes sites that publish tools (e.g. an AG Studio or Bryntum page with WebMCP enabled) agent-callable inside a KERNEL browser.
- **Managed Auth health checks plus auto re-auth** keep "logged-in" sessions alive for days.
- **Browser `curl`** gives scrape-free HTTP calls with a real browser fingerprint and the profile's cookies.
- **Buy a browser via MPP:** $0.50 buys 30 minutes of a stealth headful browser, with no account ([Pricing](https://www.kernel.sh/docs/info/pricing)).
- **Spending caps** per organisation or project.

### 5.5 Inputs and outputs
- **In:** create configuration (headful/headless, memory, stealth, proxy, profile, vault attachment, extensions, viewport), CDP/BiDi commands, Playwright code, computer actions, shell commands, credentials collected via hosted UI, wallet connections.
- **Out:** live video stream (iframe), mp4 replays, screenshots, downloaded files, page data, telemetry events (SSE/OTLP), fill outcomes, persisted profiles, WebMCP tool lists and results.

### 5.6 Limits
- **Pricing** (as of Sep 2026):
  - Usage: headful **$0.0001333/s** (about **$0.48 per hour**), headless $0.0000167/s (about $0.06 per hour), GPU headful $0.0008/s, app invocations $0.0000667/s. Idle and standby time is free.
  - Developer (free) plan: $5/month credits, 5 concurrent browsers, 5 app invocations, 1-day replay retention, 3 managed-auth connections, 3 vaults, no configurable proxies.
  - Source: [Pricing](https://www.kernel.sh/docs/info/pricing), [Limits](https://www.kernel.sh/docs/browsers/concurrency-and-limits).
- **Hackathon credits:** **$50** via `https://dashboard.onkernel.com/hackathon?code=KERNELDEVPOST2026` (documented here, **not redeemed**). That buys about 100 headful hours or about 800 headless hours. Credit expiry and whether the code also upgrades the plan's concurrency or replay limits are **UNVERIFIED**.
- **Trial vs. judging:** no trial clock, since the account is pay-as-you-go. Credits must last through Dec 21. **Replays expire after 1 day on the free plan**, so record and download the demo video yourself.
- **Files** vanish when the session ends.
- **Acceptable Use Policy** limits what can be automated, including proxy fair use ([AUP](https://www.kernel.sh/docs/acceptable-use)).

### 5.7 Prize criteria
**No dedicated KERNEL prize.** Sponsor page: "KERNEL works with every agent harness and cua model out of the box."

### 5.8 Combines naturally with PayPal primitives like…
- KERNEL browser plus computer use ↔ **PayPal JS SDK v6 checkout / approval page (sandbox)**: a buyer-side agent clicks through `approve` on a real rendered checkout.
- The `fill` API ↔ **sandbox buyer credentials** stored in a KERNEL vault, so the model never sees the PayPal login.
- Managed Auth profiles ↔ a persistent **sandbox merchant dashboard** session (sandbox.paypal.com) for UI-only actions. (UNVERIFIED: managed auth works on PayPal's login flow.)
- Read-only live view iframe ↔ a **human-approval UI** shown before the PayPal `capture` call.
- Replays (mp4) ↔ **dispute evidence** (`provide-evidence` on the Disputes API accepts documents; whether video is accepted is UNVERIFIED).
- File downloads ↔ PayPal **statements and reports** (CSV/PDF) pulled from UIs that have no API.
- KERNEL Payments (Link, Shop Pay, cards) ↔ **contrast, not overlap**: KERNEL has no PayPal wallet, so PayPal sandbox remains the funds rail and KERNEL only drives web UIs.

---

## 6. Cross-sponsor primitive table

| Primitive verb | AG Grid (Studio) | Bryntum | Channel3 | Elastic | KERNEL |
|---|---|---|---|---|---|
| Visualize / dashboard | **Yes** (core) | Timelines | UI blocks (shadcn) | Kibana / `create_visualization` | Live view video |
| Real-time row updates | **`applyTransaction`** | CrudManager sync, Node WebSocket | Offer webhooks | Ingest + alerts | Telemetry SSE |
| Natural-language query / edit | **Studio Agent Framework** | **AI feature** (Ent.) | Agentic search, Conversations | **Agent Builder** | via CUA models |
| Multi-agent orchestration | Lead + 4 specialists, `delegate_to` | Single built-in agent + planning | Hosted shopping agent | Agents + workflows + A2A | Hosts any harness |
| Swap the harness / bring your own loop | **Yes** (3 runners, AG-UI) | `toolAdapter` | REST/SDK | MCP / A2A / REST | Yes (CDP/MCP) |
| Expose tools via MCP | No (WebMCP only) | WebMCP (exp.) | **MCP server** | **MCP server** | **MCP server** |
| WebMCP (browser tools) | **Publish** | **Publish** | No | No | **Discover + invoke** |
| A2A | No | No | No | **Yes** | No |
| Scheduling / dependency propagation | No | **Yes** (core) | No | No | No |
| Constraint / slot finding | No | **Yes** (next available slot) | No | No | No |
| Cost from time × rate | Expressions | **Rate tables** | No | ES\|QL math | No |
| Product catalog search | No | No | **Yes** (core) | Bring-your-own index | Scrape via browser |
| Price / stock change events | No | No | **Webhooks** | Alert triggers on your data | No |
| Image → products | No | No | **Find-in-image** | Multimodal embeddings | Screenshots |
| Embeddings / vector / hybrid | No | No | Internal (semantic search) | **Yes** (Jina, ELSER) | No |
| Rerank | No | No | Internal | **Jina rerankers / `RERANK`** | No |
| OCR / document parsing | No | No | No | **jina-ocr-v1** | File download only |
| LLM call per record in a query | No | No | No | **`COMPLETION`** | No |
| Anomaly / change detection | Health reports (config only) | Conflict detection | Price history | **`CHANGE_POINT`, ML** | No |
| Deterministic workflow automation | Commands without an LLM | Engine + hooks | No | **Elastic Workflows** | Apps (invocations) |
| Human-in-the-loop gate | View or edit mode | **`requireConfirmationOn*`**, veto hooks | No | **`waitForInput`**, tool `askUser` | **Live view takeover** |
| Undo agent actions | Undo/redo history | **AI undo/redo** | No | No | No |
| Browser automation | No | No | No | No | **Yes** (core) |
| Secret-safe credential / payment fill | No | No | No | No | **Vault `fill`** |
| Persistent logged-in sessions | No | No | No | No | **Profiles + Managed Auth** |
| Session recording | No | No | No | No | **Replays** |
| Export (PDF / XLSX / ICS) | Print/PDF | **XLSX, MPP, PDF, ICS** | No | Reports (Kibana) | mp4, files |
| Monetization built in | No | No | **Affiliate commissions** | No | No |
| Checkout / payment | No | No | **No** (coming soon) | No | Link / Shop Pay / cards (no PayPal) |
| Server-side headless engine | Custom engine | **Node engine** (Ent.) | API | **Yes** | **Yes** |

**Access through Dec 21 at a glance:**
- **AG Studio:** 45-day key. Request it after ~Nov 6 for it to cover Dec 21.
- **Bryntum 8.0:** 14-day keyless trial, or 45 days with the free key. Get the key.
- **Channel3:** non-expiring key with 20k promo credits and a 10k/day request cap.
- **Elastic Cloud:** 14 days + 30-day extension, which reaches Dec 21 only if the extension is filed. A local Basic licence lacks Agent Builder and Workflows.
- **KERNEL:** pay-as-you-go with $50 credits. Free-plan replays last 1 day.
