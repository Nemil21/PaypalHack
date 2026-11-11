# HF-043: MCP tokens and developer connect page (W19) with readiness panel

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 2
- **Depends on:** HF-006, HF-007, HF-017a
- **Spec refs:** features/07-mcp-server.md §Logic 1–2, 4, §Edge cases, §Acceptance criteria; data-model.md §mcp_clients; screens.md §W19

## Goal
A shopper creates a scoped token and connects Claude Desktop in under 2 minutes, and can see whether their account is ready for instant holds.

## Scope
- `POST/GET/DELETE /api/mcp-clients`: name, scopes (`read`, `bid`); token = 32+ random bytes with prefix `hf_mcp_`, shown once, stored as SHA-256 and looked up by hash; revoke sets `revoked_at` (immediate 401).
- `/mcp` auth: bearer only (session cookies ignored, so a browser can't be driven into MCP calls) → shopper id + scopes; `last_used_at`; rate limit 30 calls/min per `mcp_clients.id` using HF-006's limiter (in-memory is fine with one instance).
- W19: explainer; create form; one-time reveal + copy; Claude Desktop config in the env form:
  `"args":["mcp-remote","https://<app>/mcp","--header","Authorization:${AUTH_HEADER}"], "env":{"AUTH_HEADER":"Bearer hf_mcp_…"}`;
  tool list rendered from HF-044a's exported schemas (static text until HF-044a lands); token table (last used, revoke).
- Readiness panel (M23): "Saved card ✓ / Active mandate covering $X ✓", with links to the offer page (to vault a card) and W17.
- Shopper sign-in on Render via the `DEMO_MODE` "Sign in as demo shopper" button (D13).

## Out of scope
- The MCP tools (HF-044a/b).

## Acceptance criteria
- [ ] A token is never retrievable after creation.
- [ ] A revoked token fails immediately.
- [ ] A `read`-only token calling `place_bid`, `cancel_bid` or `raise_bid` gets `FORBIDDEN`.
- [ ] The 31st call in a minute → `RATE_LIMITED`.
- [ ] A request to `/mcp` with only a session cookie → 401.
- [ ] The config snippet works in macOS Claude Desktop (checked before recording).

## Test plan
- Integration: create → use → revoke; scope matrix; cookie-only request.
- Manual: paste the snippet into Claude Desktop.

## Notes & risks
- Resolved (D13, Q#28): console-logged magic link locally; `DEMO_MODE` sign-in buttons on Render, listed in HF-049 testing instructions.
- The token holder's own PayPal pays; a token is scoped to one shopper.
