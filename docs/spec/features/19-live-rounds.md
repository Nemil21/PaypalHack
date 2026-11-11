# 19: Live Rounds (Brand Agent ↔ Buyer Agents)

**Priority:** P0 (demo centrepiece), shipped in full: a **basic part** (start/stop, "Next round" button, nudge snapshots, template text, shopper raise from the bid page, 5 s polling) built first, then the **full part** (timer tick, soft close, end rules, Claude-phrased nudges, auto-raise runner, M07 raise sheet) · **Owner:** B (brand side) + C (buyer side) · **Effort:** 6 h + 6 h

## Purpose
Once per listing, the brand can run short live rounds, either after the bidding window or before it closes (starting rounds ends new bidding). The brand agent tells bidders who are currently below the cutoff the real number ("the cutoff for 240 units is now $240"), and their buyer agents decide whether to raise, within their owner's limits. Winners pay their own final bid (10). This is the agent-to-agent negotiation in the demo.

## User stories
- As a brand manager, I set a target quantity and start live rounds; I watch raises arrive and the expected revenue climb.
- As a shopper, my agent tells me "You're out at $219. The cutoff is $240. Raise to $241?" or raises automatically if my mandate allows it.
- As a shopper, every nudge I get is true and based on the real book.

## Screens
W06 console: "Start live rounds" control, round timer, raises feed · W15 / M04 bid timeline (nudge, raise events) · M07 raise sheet · W16 / M05 agent chat

## Logic
1. **Start** (once per listing; D6, D7): a brand OWNER/MANAGER (not the agent) clicks "Start live rounds" with a target quantity Q. Listing OPEN → ROUNDS. In the same update:
   - `window_closes_at = least(window_closes_at, now())`: **no new bids from here on**; ROUNDS accepts **raises only**;
   - `rounds_end_at = least(now() + 6 h, window_closes_at + 6 h)` (hard cap);
   - `clear_deadline_at` recomputed: `least(rounds_end_at + 6 h, window_opens_at + 60 h)`.
2. **Each round (30 min, scaled by `ROUNDS_TIME_SCALE` for the demo; hold-age math is never scaled):**
   - the round advances by a conditional `UPDATE … WHERE current_round = n`, one tick at a time (in-process, under an advisory lock). Basic part: the brand's "Next round" button; full part: the timer;
   - compute `clear(bids, Q, floor)` on the shared eligible set → cutoff;
   - `belowCutoff = !winners.has(bid)`; for every HELD bid below the cutoff, snapshot **one nudge per round** (`unique(listing, round, shopper)`): `{ cutoffCents, yourBidCents, unitsLeft: Q, roundEndsAt }`;
   - nudges reach the buyer in-app (bid timeline, `GET /bids/mine` polled every 5 s during ROUNDS) and over MCP `my_bids.belowCutoff` (D18), and are written to the audit log. Push is P1 (13).
3. **Nudge text:** template text first ("You're out at $219. The cutoff for 240 units is $240. Raise to $241?"). Full part: the brand agent phrases it from the numbers only, falling back to the template if Claude is slow or down. Its single write tool, `send_nudge(bidId)`, is called by the round runner; numbers come from code, never from the model. It still cannot clear.
4. **Buyer side:** basic part: the shopper raises from the bid page (or MCP `raise_bid`). Full part: the auto-raise runner raises once, to `max(cutoff + minimum raise, current + minimum raise)`, if that is within the mandate max, otherwise it asks the shopper (M07 sheet). Auto-raises are keyed `raise:<nudgeId>`, at most once per round and 3 times per listing, and never go above the public price when `release_if_cheaper` is on. Raises follow 05 (`landHold` swap).
5. **Minimum raise:** $1 or 1% of the bid, whichever is larger. No cap on the number of raises; after 5 raises the agent warns "Your bank may show several pending holds for a few days."
6. **Soft close:** a raise in the last 5 min of a round extends that round by 10 min, never past `rounds_end_at`.
7. **End:** rounds end at `rounds_end_at`, when a round produces no raises, or when the brand stops them (stop sets `rounds_end_at = now()` and recomputes `clear_deadline_at`). After that the book is frozen. The brand then has until `clear_deadline_at` (≤ 6 h) to press Clear (10); otherwise the listing expires and all holds are voided. During ROUNDS the Clear button reads "Stop rounds & clear".

## Rules that keep it honest
- Nudges quote only the live book (cutoff, units). No invented scarcity, no "others are about to buy" unless true.
- The floor is never revealed.
- A shopper can mute nudges; muted bids still count.

## Data / API
`listings.status` adds `ROUNDS`; `listings.rounds_started_at`, `current_round`, `round_ends_at`, `rounds_end_at`, `target_quantity`; `nudges` (see data-model, unique per listing, round and shopper). `POST /listings/:id/rounds/start`, `/rounds/next`, `/rounds/stop`, `PATCH /listings/:id/rounds`, SSE `round.started`, `round.nudged`, `round.extended`, `round.ended`, `bid.raised`. Raise copy: "New $241 hold placed · $219 hold released. Your bank may show it as pending for a few days." 

## Edge cases
| Case | Handling |
|---|---|
| Raise's new hold declined | Old bid stands; shopper told "Couldn't raise. Your $229 bid still stands." |
| Price watcher releases a bid mid-round | Bid leaves the book; cutoff recomputed next round |
| Brand changes Q during rounds | Allowed (`PATCH … targetQuantity`); next round uses the new Q |
| New bid during ROUNDS | Refused `WINDOW_CLOSED`; only raises are accepted |
| Brand cancels during ROUNDS | Allowed; async cancel voids every hold (M7) |
| A shopper mutes nudges | Stored on the bid's shopper; muted bids still count |
| Hold-age guard would be breached | Rounds end early so Clear can run before 66 h |

## Acceptance criteria
- [ ] Only bids below the cutoff are nudged, once per round, with numbers equal to `clear()` output.
- [ ] A buyer agent with a mandate raises once to cutoff + minimum raise; without one, it asks.
- [ ] Starting rounds stops new bids; after `rounds_end_at` even raises are refused.
- [ ] Two ticks for the same round never both run (conditional update).
- [ ] Rounds never run past 6 h; Clear is still possible within the hold-age guard.

## Test plan
Unit: nudge selection on fixture books. Integration: 20 SIM agents + 1 real sandbox bidder; run 2 rounds; verify raises and audit rows.
