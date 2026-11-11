# HF-036a: Live rounds basic: start/stop, "Next round", nudge snapshots, template text

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 4
- **Estimate:** 2.5
- **Depends on:** HF-002, HF-003a, HF-005, HF-006 (build on a fixture listing; no HF-012a dependency)
- **Spec refs:** features/19-live-rounds.md §Logic 1–3, 6–7, §Rules that keep it honest, §Edge cases, §Acceptance criteria; features/09-brand-agent.md §Purpose (send_nudge); api.md §rounds/start, rounds/stop; data-model.md §listings (target_quantity, rounds_started_at, current_round, round_ends_at, rounds_end_at, clear_deadline_at), §nudges

## Goal
The basic, always-working half of live rounds: the brand starts rounds, advances them with a "Next round" button, and every bid that would lose gets exactly one truthful nudge per round whose numbers equal `clear()` output. HF-036b adds the timer, soft close and Claude phrasing on top of this; both ship.

## Scope
- `POST /api/listings/:id/rounds/start {targetQuantity}` (OWNER/MANAGER only; VIEWER and every agent actor → 403). Conditional `OPEN→ROUNDS`, allowed while OPEN (before or after `window_closes_at`), once only (D6). In the same transaction (D6/D7):
  - `rounds_started_at = now()`, `current_round = 1`, `target_quantity`;
  - `window_closes_at = least(window_closes_at, now())` (starting rounds closes new bidding);
  - `rounds_end_at = least(now() + 6h, original window_closes_at + 6h)`;
  - `clear_deadline_at = least(rounds_end_at + 6h, window_opens_at + 60h)` (DB CHECKs from HF-002 back this).
  - SSE `round.started` via `emit(tx, …)` from HF-003a (`pg_notify` in the same transaction); HF-008 delivers it to clients when it lands.
- `POST /api/listings/:id/rounds/stop` → `rounds_end_at = now()`, `clear_deadline_at = least(clear_deadline_at, now() + 6h)`; SSE `round.ended`. After `rounds_end_at` the book is frozen (`isRaisable` false, D7).
- `PATCH /api/listings/:id/rounds {targetQuantity}` (OWNER/MANAGER, `1 ≤ Q ≤ quantity`); the next round uses the new Q.
- `POST /api/listings/:id/rounds/next` ("Next round", OWNER/MANAGER): advances with a conditional `UPDATE listings SET current_round = n + 1 … WHERE id = $1 AND status = 'ROUNDS' AND current_round = $n AND now() < rounds_end_at` (0 rows → 409), then writes the nudge snapshot for round n + 1.
- Nudge snapshot (M10), computed once per round from `loadClearInput` (HF-005, D8 eligibility) and `clear(bids, Q, floor)`:
  - nudged = HELD eligible bids **not in `winners`** (`belowCutoff = !winners.has(bid)`), which covers ties lost on time priority and below-floor bids;
  - payload `{cutoffCents, yourBidCents, targetQuantity, roundEndsAt, suggestedCents}` with `suggestedCents = max(cutoff + minRaise(cutoff), current + minRaise(current))`, `minRaise(x) = max(100, ceil(x/100))` cents;
  - `insert into nudges … on conflict (listing_id, round, shopper_id) do nothing`; audit `NUDGE_SENT`; SSE `round.nudged`.
  - If nobody is below the cutoff, end rounds immediately (`round.ended`).
- Nudge text: **template only** in this ticket ("You're out at $219. The cutoff is $240. Raise to $241?"). The brand agent's `send_nudge(bidId)` is the single permitted brand-agent write and only inserts the `nudges` row (Resolved, Other answers Q#26).
- Shared nudge contract in `packages/shared` (agreed in Wave 1 so HF-038a/b build against fixture nudges): `nudges` row shape and `onNudge(nudge)` signature.
- Fixture SSE replay script (`npm run dev:rounds-replay`: `round.started` → `round.nudged` × N → `bid.raised` × M) for HF-037a/b and HF-038a/b.

## Out of scope
- Timer tick, soft close, extensions, automatic end rules, `ROUNDS_TIME_SCALE`, Claude phrasing (HF-036b).
- Buyer reaction to nudges (HF-038a/b). Console controls (HF-037a/b).

## Acceptance criteria
- [ ] Start sets every deadline per D6/D7 in one transaction; a second start → 409; start on a non-OPEN listing → 409.
- [ ] After start, `POST /bids` (new bid) → `WINDOW_CLOSED`; raises are accepted until `rounds_end_at`, then refused (frozen book).
- [ ] Only bids not in `winners` are nudged, once per round, with numbers equal to `clear()` output; a bid tied at the cutoff that lost on time priority is nudged.
- [ ] Race (stub, from old HF-047): two concurrent "Next round" calls advance `current_round` exactly once and write one nudge per (listing, round, shopper).
- [ ] The floor never appears in any nudge, SSE or `my_bids` payload (test changes the floor and diffs the payloads).
- [ ] VIEWER, BUYER_AGENT, MCP_CLIENT and the brand agent get 403 on start/stop/next/PATCH.
- [ ] Stop sets `rounds_end_at = now()`; the oldest hold is ≤ 60 h old at `clear_deadline_at` (CHECK holds).

## Test plan
- Unit: nudge selection on the HF-005 fixture books (ties, below floor, nobody below cutoff).
- Integration (Postgres + FakePayPal): start → next × 2 → stop; concurrent next; role matrix.
- Manual: fixture replay drives HF-037a.

## Notes & risks
- Resolved (D6, Q#7): rounds can start while OPEN, once; `rounds_end_at = least(now()+6h, window_closes_at+6h)`; `clear_deadline_at` is recomputed and capped at `window_opens_at + 60h`.
- Resolved (D7, Q#5/Q#6): ROUNDS accepts raises only, until `rounds_end_at`; starting rounds closes new bidding.
- Resolved (D6, Q#9): `clear_deadline_at` recomputed on start and stop as above; the runtime "end early for hold age" check is unnecessary under these clamps.
- Resolved (Other answers, Q#26): template text in P0; `send_nudge` is the brand agent's only write. Claude phrasing is added in HF-036b with the template as fallback.
- Resolved (D18, Q#27): nudges reach shoppers in-app (W14/W15/M07 polling `GET /bids/mine` every 5 s during ROUNDS) and via MCP `my_bids`; push is HF-054b.
- Nudge mute (19): no column in P0; muted bids would still count. Tracked with HF-054a/b (user override: kept in scope, P1).
- Payload field is `targetQuantity`, not `unitsLeft` (it is the target, not units left).
