# HF-036: Live rounds engine: start/stop, round runner, nudges

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 4
- **Depends on:** HF-005, HF-008, HF-012
- **Spec refs:** features/19-live-rounds.md §Logic 1–3, 5–7, §Rules that keep it honest, §Edge cases, §Acceptance criteria; features/09-brand-agent.md §Purpose (send_nudge); api.md §rounds/start, rounds/stop; data-model.md §listings (target_quantity, rounds_end_at, clear_deadline_at)

## Goal
Run truthful, code-computed rounds: every bid below the cutoff gets one nudge per round with numbers equal to `clear()` output.

## Scope
- `POST /api/listings/:id/rounds/start {targetQuantity}` (brand user only) → OPEN→ROUNDS; `target_quantity`; `rounds_end_at = now + 6h` (hard cap); recompute `clear_deadline_at`; SSE `round.started`.
- `POST /api/listings/:id/rounds/stop` → rounds end; `clear_deadline_at = now + 6h`.
- Changing Q during rounds allowed (next round uses new Q).
- Round runner (cron/tick): 30-min rounds; compute `clear(bids, Q, floor)`; for each HELD bid below cutoff, at most one nudge per round `{cutoffCents, yourBidCents, unitsLeft: Q, roundEndsAt}` → `nudges` row + audit + SSE `round.nudged`.
- Brand agent `send_nudge(bidId)`: the runner calls it; Claude may phrase the text from the numbers only; fallback template if Claude is down. Numbers come from code.
- Soft close: raise in the last 5 min extends the round by 10 min, never past `rounds_end_at`.
- End: at `rounds_end_at`, a round with no raises, brand stop, or early end when the hold-age guard would be breached.
- Demo time scaling: configurable round length (e.g. 2 min) via env for recording.

## Out of scope
- Buyer reaction to nudges (HF-038). Console controls (HF-037).

## Acceptance criteria
- [ ] Only bids below the cutoff are nudged, once per round, with numbers equal to `clear()` output.
- [ ] Rounds never run past 6 h; Clear still possible within the hold-age guard.
- [ ] Floor never appears in any nudge.

## Test plan
- Unit: nudge selection on fixture books.
- Integration: 20 SIM agents + 1 real sandbox bidder, 2 rounds (with HF-038, HF-046).

## Notes & risks
- Spec question: 09 acceptance says "the agent has no tool that changes state", but 09/19 give it `send_nudge`. Treat send_nudge as the single allowed write.
- Spec question: can rounds start before `window_closes_at` (state table allows OPEN→ROUNDS any time, 19 says "after the 48 h bidding window")? And data-model says `rounds_end_at ≤ window_closes_at + 6h` while 19 says `now + 6h`.
- Spec question: 19 says "a shopper can mute nudges" but no column exists.
- Nudges are delivered in-app/MCP (`my_bids.belowCutoff`); push is P1 (HF-054).
