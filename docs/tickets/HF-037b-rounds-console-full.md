# HF-037b: Live rounds console full: raises feed, extensions, raise flash

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 8
- **Estimate:** 1.5
- **Depends on:** HF-037a, HF-036b
- **Spec refs:** features/19-live-rounds.md §Screens, §User stories; screens.md §W06

## Goal
The brand watches raises arrive and expected revenue climb, round by round, including soft-close extensions.

## Scope
- Raises feed from SSE `bid.raised` / `round.nudged`, using the shared `bid.raised` contract `{bidId, replacesBidId, oldCents, newCents, shopperLabel, source, isSimulated}` (`packages/shared`, owned by HF-018). Row copy: "New $241 hold placed · $219 hold released" (PayPal has no in-place increase); SIM chip for simulated shoppers.
- Per-round summary line: nudged N, raised M, expected gross Δ.
- `round.extended`: timer jumps with a short "+10 min (late raise)" note; `round.ended` shows the reason (time cap, no raises, nobody below cutoff, stopped).
- Raise flash in the bids grid (via HF-025's `bid.raised` handling).

## Out of scope
- Bryntum phase timeline (HF-060, P1).

## Acceptance criteria
- [ ] Raises appear live with the correct copy and SIM chips, and gross updates within 2 s.
- [ ] Extensions and end reasons are shown as they happen.

## Test plan
- Manual with the fixture replay, then a scaled 2-round run with SIM round agents.

## Notes & risks
- Resolved (user override): the full console ships alongside the basic one; nothing is gated behind CP4.
