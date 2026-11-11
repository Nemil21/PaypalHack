# HF-043: MCP tokens and developer connect page (W19)

- **Track / owner:** D integrations & demo
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-006, HF-007
- **Spec refs:** features/07-mcp-server.md §Logic 1–2, §Edge cases, §Acceptance criteria; data-model.md §mcp_clients; screens.md §W19

## Goal
A shopper creates a scoped token and connects Claude Desktop in under 2 minutes.

## Scope
- `POST/GET/DELETE /api/mcp-clients`: name, scopes (`read`, `bid`); token shown once; stored as SHA-256; revoke sets `revoked_at` (immediate 401).
- Auth middleware for `/mcp`: bearer → shopper id + scopes; `last_used_at`; 30 calls/min/token.
- W19: explainer, create form, one-time reveal + copy, Claude Desktop config snippet (`npx mcp-remote https://<app>/mcp --header "Authorization: Bearer …"`), tool list with schemas, token table (last used, revoke).

## Out of scope
- The MCP tools (HF-044).

## Acceptance criteria
- [ ] Token is never retrievable after creation.
- [ ] Revoked tokens fail immediately.
- [ ] 31st call in a minute → `RATE_LIMITED`.

## Test plan
- Integration: create → use → revoke.

## Notes & risks
- The token holder's own PayPal pays; scope the token to one shopper.
