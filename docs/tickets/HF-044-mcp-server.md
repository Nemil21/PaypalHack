# HF-044: MCP server (`/mcp`) with get_book, place_bid, cancel_bid, my_bids, raise_bid

- **Track / owner:** D integrations & demo
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-043, HF-014, HF-016, HF-018, HF-022
- **Spec refs:** features/07-mcp-server.md §Logic 2–6, §Acceptance criteria; api.md §MCP server

## Goal
Any MCP client can bid into a book with a real PayPal hold through the same service code as REST.

## Scope
- Streamable HTTP via `@modelcontextprotocol/sdk` at `/mcp`.
- Tools (descriptions say "Places a real PayPal hold. If you win, you're charged exactly amountCents; otherwise it's released."):
  - `get_book {listingSlug}` → product, bestPublicPriceCents, windowClosesAt, `$10` demand bands only (no floor, no shopper data, no exact bids);
  - `place_bid {listingSlug, amountCents, idempotencyKey}` → `placeBid(source=MCP)`: VAULT if mandate + saved method covers it, else `approveUrl` and no hold;
  - `cancel_bid {bidId}`; `my_bids {}` (with `belowCutoff`, `cutoffCents` only in ROUNDS); `raise_bid {bidId, amountCents, idempotencyKey}`.
- Audit `actor_type=MCP_CLIENT`; tool errors map codes to plain messages (e.g. `WINDOW_CLOSED`).

## Out of scope
- OAuth for MCP; token auth only.

## Acceptance criteria
- [ ] Claude Desktop can list tools and place a bid that shows on W06 within 2 s with source MCP.
- [ ] Without a covering mandate, `place_bid` returns an approval URL and creates no hold.
- [ ] `get_book` never returns floor or shopper data.

## Test plan
- Integration: MCP client SDK test calling all tools.
- Manual: Claude Desktop demo beat 3 — **record this shot early**.

## Notes & risks
- Spec question: 07 lists four tools but api.md (and 07 §Logic 6) add `raise_bid`; ticket includes all five.
