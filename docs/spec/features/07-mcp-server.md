# 07: MCP Server for Outside Agents

**Priority:** P0 · **Owner:** D · **Effort:** 5 h

## Purpose
Any AI assistant (Claude Desktop, other MCP clients) can bid into a book with real money. This is the growth channel and the "exchange for shopping agents" story. Claude Desktop is a side door, not the main entry point.

## User stories
- As a Claude Desktop user, I say "put in a $215 bid for those Sonys" and it happens with a real PayPal hold.
- As a developer, I connect my shopping agent with a token in under 2 minutes.
- As a brand, I see which bids came via agents (source tag).

## Screens
W19 Developer / MCP connect page · W06 (source column "MCP") · W14 (bids show "via Claude Desktop")

## Logic
1. W19:
   - the shopper creates a token: name it, choose scopes (`read`, `bid`);
   - the token is shown once and stored as a SHA-256 hash;
   - the page shows a Claude Desktop config snippet (`npx mcp-remote https://<app>/mcp --header "Authorization: Bearer …"`).
2. `/mcp` uses Streamable HTTP via `@modelcontextprotocol/sdk`. Auth middleware maps the token → `shopper_id` and scopes.
3. Tools are `get_book`, `place_bid`, `cancel_bid` and `my_bids`, as in [api.md](../api.md). Each tool calls the same internal service as REST, so the same mandate checks, idempotency and audit apply (`actor_type=MCP_CLIENT`).
4. `place_bid`:
   - if the shopper has a vault + ACTIVE mandate that covers it → HELD immediately;
   - otherwise → return `approveUrl` with text "Open this link to approve the PayPal hold."
5. `get_book` returns anonymized price bands (e.g. $10 bands with bid counts). It never returns the floor, shopper IDs or exact bids.
6. `my_bids` includes `belowCutoff` and, during live rounds, the real `cutoffCents` (19). `raise_bid` raises within the mandate.

## Edge cases
| Case | Handling |
|---|---|
| Token leaked | Revoke in W19; `revoked_at` set; immediate 401 |
| Agent loops calling place_bid | Idempotency key required; rate limit 30/min; mandate cap |
| Listing not OPEN | Tool error `WINDOW_CLOSED` with plain message |
| Outside agent tries to read other brands' data | Only `get_book` by public slug; anonymized |

## Acceptance criteria
- [ ] Claude Desktop can list tools and place a bid that shows on W06 within 2 s with source MCP.
- [ ] Without a covering mandate, `place_bid` returns an approval URL and creates no hold.
- [ ] Revoked tokens fail immediately.

## Test plan
Integration: MCP client SDK test calling all 4 tools. Manual: Claude Desktop demo beat 3 (record this shot early).
