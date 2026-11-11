# HF-044a: MCP server (`/mcp`): get_book, place_bid, cancel_bid, my_bids

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2.5
- **Depends on:** HF-043, HF-014a, HF-016, HF-022
- **Spec refs:** features/07-mcp-server.md §Logic 2–6, §Acceptance criteria; api.md §MCP server

## Goal
Any MCP client can bid into a book with a real PayPal hold through the same service code as REST. Record the Claude Desktop shot as soon as these four tools are green; `raise_bid` follows in HF-044b.

## Scope
- `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` in **stateless** mode (`sessionIdGenerator: undefined`) mounted in Fastify via `reply.hijack()` with `req.raw`/`reply.raw`, so deploys don't break Claude Desktop sessions.
- Tool descriptions say "Places a real PayPal hold. If you win, you're charged exactly amountCents; otherwise it's released." Amount schemas say "integer US cents, e.g. 21500 = $215.00" (bound 100–1,000,000); every result echoes `amountFormatted` (M23).
- Tools:
  - `get_book {listingSlug}` → product, bestPublicPriceCents, windowClosesAt, phase, demand bands from a dedicated `publicBookBands(slug)` service (floor-blind `likelyBand()` rules: $10 buckets, bands with < 3 bids merged, only OPEN/ROUNDS listings and HELD eligible bids; DRAFT/unknown → `NOT_FOUND`). Never calls the tenant-scoped brand `/book` route.
  - `place_bid {listingSlug, amountCents, idempotencyKey}` → `placeBid(source=MCP)`: VAULT hold if the shopper has a vaulted card and a covering ACTIVE mandate; otherwise return our own offer-page link `/o/:slug?amount=21500&src=mcp` and create no hold (M23). Existing live bid → tool error `ALREADY_BID {bidId, amountCents}` "Use raise_bid" (D3).
  - `cancel_bid {bidId}`: naturally idempotent (an already VOIDING/VOIDED bid returns its status).
  - `my_bids {}`: `belowCutoff`/`cutoffCents` only in ROUNDS, `null` otherwise.
- Idempotency keys scoped per caller (`unique(shopper_id, idempotency_key)` + request hash, M3): the same key with a different body → `DUPLICATE` ("this key was used for a $215 bid").
- Audit `actor_type=MCP_CLIENT`; tool errors returned as `isError: true` results with plain messages (e.g. `WINDOW_CLOSED`), not JSON-RPC errors.

## Out of scope
- `raise_bid` (HF-044b). OAuth for MCP (token auth only).

## Acceptance criteria
- [ ] Precondition: the token's shopper has a vaulted card and a covering mandate (W19 readiness panel green). Claude Desktop lists the tools and places a bid that shows on W06 within 2 s with source MCP.
- [ ] Without a covering mandate or vault, `place_bid` returns the offer-page link and creates no hold.
- [ ] `get_book` never returns floor or shopper data; changing the floor never changes its response.
- [ ] Two shoppers using the same `idempotencyKey` get independent bids; same key + different amount → `DUPLICATE`.
- [ ] A second `place_bid` on the same listing → `ALREADY_BID`.
- [ ] Claude Desktop shot recorded as soon as green (safety take for HF-050b).

## Test plan
- Integration: MCP client SDK test calling all four tools (FakePayPal).
- Manual: Claude Desktop demo beat 3 on the deployed URL.

## Notes & risks
- Resolved (Other answers, Q#24): MCP ships 5 tools; these 4 are recorded first, `raise_bid` in HF-044b.
- Resolved (D3, Q#25): one live bid per shopper per listing; a second `place_bid` is `ALREADY_BID`, never a silent raise; lowering = cancel + new bid.
