# HF-044b: MCP `raise_bid` tool

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 8
- **Estimate:** 1
- **Depends on:** HF-044a, HF-018
- **Spec refs:** features/07-mcp-server.md §Logic 6; features/19-live-rounds.md §User stories; api.md §MCP server (`raise_bid`)

## Goal
An MCP client can raise its shopper's bid during live rounds through the same `raiseBid` swap as REST.

## Scope
- `raise_bid {bidId, amountCents, idempotencyKey}` → `raiseBid(source=MCP)` (HF-018 `landHold` swap), same cents schema and `amountFormatted` echo as HF-044a.
- Vaulted shopper with a covering mandate → new hold immediately; otherwise return the offer/bid page link (or HF-018's `approveUrl` for wallet bids) and create no hold.
- Refuse lowering (`amountCents ≤ current` → tool error); `isRaisable` per D7 (`WINDOW_CLOSED` after `rounds_end_at`).
- Result copy: "New $241 hold placed · $219 hold released".
- Tool-error mapping for `ABOVE_MANDATE_MAX`, `WINDOW_CLOSED`, `DUPLICATE`.

## Out of scope
- Auto-raise (HF-038b).

## Acceptance criteria
- [ ] During ROUNDS, Claude Desktop raises a nudged bid; the console feed shows source MCP and the old hold is released.
- [ ] Same key, same args → same result; same key, different amount → `DUPLICATE`.
- [ ] A raise after `rounds_end_at` → `WINDOW_CLOSED`; a lower amount is rejected.

## Test plan
- Integration: MCP client SDK test on the stub during a fixture ROUNDS listing.

## Notes & risks
- Resolved (Other answers, Q#24): `raise_bid` is the fifth tool; it ships after the 4-tool shot.
