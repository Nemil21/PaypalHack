# HF-038: Buyer side of live rounds: auto-raise or ask, raise sheet (M07)

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-018, HF-036, HF-017
- **Spec refs:** features/19-live-rounds.md §Logic 4–5, §Acceptance criteria; features/05-mandates-rolling.md §Logic 4; features/07-mcp-server.md §Logic 6; screens.md §M07

## Goal
When a shopper's bid is nudged, their agent raises once straight to cutoff + minimum raise if the mandate allows, otherwise asks.

## Scope
- Nudge consumer (`core/rounds-buyer.ts`, plain code): for each nudge, target = cutoff + max($1, 1%); if ACTIVE mandate covers target → `raiseBid` (actor BUYER_AGENT, vaulted MIT hold); else mark "ask shopper".
- Shopper surfaces: W14/W15 nudge event "You're out at $219. The cutoff is $240. Raise to $241?"; M07 raise sheet (current bid, suggested raise, new hold amount, "Raise to $X (new hold, old one released)", "Keep $Y").
- After 5 raises on one bid, warn once: "Your bank may show several pending holds for a few days."
- `my_bids` exposes `belowCutoff` + `cutoffCents` during ROUNDS (shared with MCP, HF-044).
- Declined raise → "Couldn't raise. Your $229 bid still stands."

## Out of scope
- Push delivery (HF-054, P1). LLM decision-making for raises: the rule is code; the chat agent only explains.

## Acceptance criteria
- [ ] A buyer agent with a mandate raises once to cutoff + minimum raise; without one, it asks.
- [ ] Raise never exceeds mandate max.
- [ ] The 5-raise warning appears exactly once.

## Test plan
- Unit: target computation and mandate gating.
- Integration: nudged bid with/without mandate.

## Notes & risks
- Uses vaulted MIT holds (S2 proven); a bid placed via wallet without vault cannot auto-raise and must ask.
