# 07 — PayPal AI & Agent Tools

Sources: https://github.com/paypal/AI-Toolkit · https://github.com/paypal/agent-toolkit · https://developer.paypal.com/ai-tools/get-started · https://developer.paypal.com/ai-tools/mcp-server · https://developer.paypal.com/agent-ready/overview · https://developer.paypal.com/agentic-commerce-services/about

## Which PayPal AI tool for what

| Goal | Tool |
|---|---|
| Your own AI agent/app that takes PayPal actions (in code) | **Agent Toolkit** (`@paypal/agent-toolkit`) |
| Let Claude/ChatGPT/Cursor/any MCP client operate PayPal via natural language | **PayPal MCP server** (local `@paypal/mcp` or remote `mcp.sandbox.paypal.com`) |
| Help *your coding agent* write correct PayPal integration code | **PayPal AI Toolkit** plugin (skills + hooks + MCP) — and APIMatic Context Plugin (doc 08) |
| Let AI shopping surfaces (ChatGPT, Gemini, Google AI Mode) buy from merchants | **Agentic Commerce Services / Agent Ready** (ACP, UCP) — mostly requires access request |

PayPal's own decision tree: custom AI assistant for your site/app → agent toolkit · integration with major LLM platforms → LLM integration · AI-powered shopping through an AI platform → agentic commerce services.

---

## 1. PayPal AI Toolkit (dev-time plugin)
Repo: https://github.com/paypal/AI-Toolkit (Apache-2.0). Plugin for Claude Code, OpenAI Codex, Cursor, IBM Bob.

**Features:** `paypal-best-practices` skill (auto-injected: recommended vs deprecated APIs, auth, Orders/Subscriptions/Invoices flows, webhook verification, error handling, sandbox testing) · slash commands · a `PreToolUse` hook that forces the agent to consult best practices + correct SDK version (v5/v6) before editing PayPal code · sandbox MCP server integration.

**Install (Claude Code):**
```
/plugin install paypal@claude-plugins-official
/reload-plugins
```
Codex: `codex plugin marketplace add paypal/AI-Toolkit && codex plugin add paypal@paypal-ai-toolkit`
Cursor: `cursor-agent plugin marketplace add https://github.com/paypal/AI-Toolkit`

**Configure sandbox token:**
```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
  -u "YOUR_SANDBOX_CLIENT_ID:YOUR_SANDBOX_CLIENT_SECRET" \
  -d "grant_type=client_credentials" | jq -r .access_token
```
Claude Code → `~/.claude/settings.json`: `"env": { "PAYPAL_SANDBOX_ACCESS_TOKEN": "A21AA…" }`. Fully quit/reopen, then `/paypal:setup`. Tokens expire in up to 8 h → `/paypal:setup refresh` on 401. Don't put it in `~/.zshrc` (GUI apps don't read it; wrapped lines break headers).

**Commands:**
| Command | Does |
|---|---|
| `/paypal:doctor [symptom]` | Scan codebase for PayPal integration issues |
| `/paypal:explain-error <code>` | Explain an error code (e.g. `INSTRUMENT_DECLINED`, `422 UNPROCESSABLE_ENTITY`) |
| `/paypal:sandbox [topic]` | Sandbox setup, test accounts, tips (e.g. `subscriptions`, `webhooks`) |
| `/paypal:setup [mode]` | Configure plugin, verify MCP, refresh tokens |
| `/paypal:test-accounts [topic]` | Test cards, BNPL, Venmo, webhooks, scenarios |

MCP: sandbox server via SSE at `/sse`; IBM Bob uses Streamable HTTP at `https://mcp.sandbox.paypal.com/mcp` with OAuth.

---

## 2. PayPal Agent Toolkit (runtime, in your app)
Repo: https://github.com/paypal/agent-toolkit · `npm install @paypal/agent-toolkit` (Node 18+, TypeScript).
Works with **OpenAI Agents SDK, LangChain, Vercel AI SDK, MCP** via function calling.

### All available tools
**Invoices:** `create_invoice`, `list_invoices`, `get_invoice`, `send_invoice`, `send_invoice_reminder`, `cancel_sent_invoice`, `generate_invoice_qr_code`, `delete_invoice`, `generate_invoice_number`, `search_invoicing`, `update_invoicing`, `cancel_invoice_auto_reminder`, `record_payment_for_invoice`, `record_refund_for_invoice`, `create_conditional_rules_for_invoice` (e.g. early-payment discount, auto-cancel date)
**Recurring invoices:** `create_recurring_series`, `activate_recurring_series`, `get_recurring_series`, `cancel_recurring_series`, `delete_recurring_series`
**Payments:** `create_order`, `get_order`, `pay_order`, `create_refund`, `get_refund`
**Disputes:** `list_disputes`, `get_dispute`, `accept_dispute_claim`
**Shipment tracking:** `create_shipment_tracking`, `get_shipment_tracking`, `update_shipment_tracking`
**Catalog:** `create_product`, `list_products`, `show_product_details`
**Subscriptions:** `create_subscription_plan`, `list_subscription_plans`, `show_subscription_plan_details`, `create_subscription`, `show_subscription_details`, `update_subscription`, `cancel_subscription`
**Reporting:** `list_transactions`, `get_merchant_insights`

### Usage (Vercel AI SDK)
```ts
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';

const paypalToolkit = new PayPalAgentToolkit({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  configuration: {
    actions: {
      invoices: { create: true, list: true, send: true, sendReminder: true, cancel: true, generateQRC: true },
      products: { create: true, list: true, update: true },
      subscriptionPlans: { create: true, list: true, show: true },
      shipment: { create: true, show: true, cancel: true },
      orders: { create: true, get: true },
      disputes: { list: true, get: true },
    },
    context: { sandbox: true },   // sandbox mode
  },
});

const { text } = await generateText({
  model: llm,
  tools: paypalToolkit.getTools(),
  maxSteps: 10,
  prompt: 'Create an order for $50 for custom handcrafted item and get the payment link.',
});
```
Workflows: `import { PayPalWorkflows, ALL_TOOLS_ENABLED } from '@paypal/agent-toolkit/ai-sdk'`.
Env vars: `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX|PRODUCTION` (defaults to SANDBOX).
Token life: sandbox 3–8 h, production 8 h (`expires_in` ~32400 s) — implement refresh.

---

## 3. PayPal MCP server
Docs: https://developer.paypal.com/ai-tools/mcp-server

**Local** (Node 18+), e.g. Claude Desktop `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "paypal": {
      "command": "npx",
      "args": ["-y", "@paypal/mcp", "--tools=all"],
      "env": { "PAYPAL_ACCESS_TOKEN": "YOUR_PAYPAL_ACCESS_TOKEN", "PAYPAL_ENVIRONMENT": "SANDBOX" }
    }
  }
}
```

**Remote:**
| Env | Base |
|---|---|
| Sandbox | `https://mcp.sandbox.paypal.com` |
| Production | `https://mcp.paypal.com` |

Transports: SSE `…/sse`, Streamable HTTP `…/http` (Bob uses `…/mcp`). Use `npx mcp-remote <url>`; optional `--header "Authorization: Bearer <token>"`, otherwise browser PayPal login/consent. Trouble connecting → `rm -rf ~/.mcp-auth`.
Same tool catalog as the Agent Toolkit (orders, invoices, subscriptions, disputes, catalog, shipment, reporting). Example prompt: "create an invoice for landscaping services for Green Lawns for $200 dated last Friday."

---

## 4. Agentic Commerce (relevant to the "Best Use of Agentic Commerce" $5K prize)

### Agentic commerce services
Lets merchants create AI-powered shopping experiences (natural-language product discovery, cart, checkout across stores/platforms). **Access requires a form** (https://www.paypal.ai/us/home#form) and onboarding — likely not usable within the hackathon window, but the concepts are fair game.
- **Agent Ready:** accept payments from AI assistants with minimal changes; supports supervised and automatic shopping.
- **Store Sync:** make products discoverable by AI assistants; orders flow into your existing OMS. Partners: Wix, Commerce (BigCommerce & Feedonomics), Shopware.

### Agent Ready protocols
| Protocol | AI platform | Path |
|---|---|---|
| Agentic Commerce Protocol (ACP) — https://developer.paypal.com/agent-ready/agentic-commerce-protocol | ChatGPT / OpenAI | Delegated payment tokens through Braintree |
| Universal Commerce Protocol (UCP) with Braintree | Google AI Mode, Gemini | Google Pay payment handler via Braintree |
| UCP with PayPal — https://developer.paypal.com/agent-ready/universal-commerce-protocol-with-paypal | Google AI Mode, Gemini | Encrypted Google Pay credential forwarded to PayPal **Orders v2 API** |

### Practical "agentic commerce" in sandbox
The official inspiration list explicitly wants agents that **actually transact, not just recommend**: an agent that shops and checks out for you; an assistant that pays contractors when a job is marked complete; **two agents negotiating and settling a payment between themselves (agent-to-agent commerce)**. Achievable with Agent Toolkit/MCP (orders, invoices) + direct REST calls for what the toolkit lacks (Payouts, authorize/capture/void, saved payment methods, dispute evidence and offers) + Channel3 (product data) + KERNEL (browser agents).
