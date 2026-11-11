# HF-038a: Buyer rounds basic: raise from the bid page, ROUNDS polling

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** HF-018, HF-036a, HF-020
- **Spec refs:** features/19-live-rounds.md §Logic 4–5, §User stories; screens.md §W14, §W15, §M07

## Goal
A shopper who has been nudged sees it on their bid page and raises in one tap; MCP clients see the same state through `my_bids`.

## Scope
- W14/W15 poll `GET /bids/mine` every 5 s while any of the shopper's bids is on a ROUNDS listing (D18; shoppers have no SSE channel).
- Nudge event on the bid timeline: "You're out at $219. The cutoff is $240. Raise to $241?" with the suggested amount from the nudge (`max(cutoff + minRaise(cutoff), current + minRaise(current))`).
- Inline raise action calling `raiseBid` (HF-018) with a fresh Idempotency-Key per user action; copy "New $241 hold placed · $219 hold released". Wallet-only bids get the `approveUrl` path from HF-018.
- `GET /bids/mine` and MCP `my_bids` expose `belowCutoff` and `cutoffCents` only while ROUNDS (`null` otherwise).
- Declined raise → "Couldn't raise. Your $229 bid still stands."
- Frozen book (after `rounds_end_at`): raise action hidden, "Rounds ended. Waiting for the brand to clear."

## Out of scope
- Auto-raise runner and the M07 raise sheet (HF-038b). MCP `raise_bid` tool (HF-044b). Push (HF-054b).

## Acceptance criteria
- [ ] A nudged shopper sees the nudge within 5 s and raises; the new bid is HELD and the old hold released (D1 swap).
- [ ] `belowCutoff` is `null` outside ROUNDS and never leaks the floor.
- [ ] Raise after `rounds_end_at` → `WINDOW_CLOSED` with the frozen-book copy.

## Test plan
- Integration (FakePayPal): fixture nudge → poll → raise.
- Manual: real sandbox bidder with a vaulted card during a scaled round.

## Notes & risks
- Resolved (D18, Q#27): in-app polling + MCP `my_bids` are the P0 nudge delivery.
- The demo's real bidder must hold a vaulted card (S7 flow or the test-card fallback) so raises don't need a redirect.
