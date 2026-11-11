# 19: Live Rounds (Brand Agent ↔ Buyer Agents)

**Priority:** P0 (demo centrepiece) · **Owner:** B (brand side) + C (buyer side) · **Effort:** 6 h

## Purpose
After the 48 h bidding window, the brand can run short live rounds. The brand agent tells bidders who are currently below the cutoff the real number ("the cutoff for 240 units is now $240"), and their buyer agents decide whether to raise, within their owner's limits. Winners pay their own final bid (10). This is the agent-to-agent negotiation in the demo.

## User stories
- As a brand manager, I set a target quantity and start live rounds; I watch raises arrive and the expected revenue climb.
- As a shopper, my agent tells me "You're out at $219. The cutoff is $240. Raise to $241?" or raises automatically if my mandate allows it.
- As a shopper, every nudge I get is true and based on the real book.

## Screens
W06 console: "Start live rounds" control, round timer, raises feed · W15 / M04 bid timeline (nudge, raise events) · M07 raise sheet · W16 / M05 agent chat

## Logic
1. **Start:** brand user (not the agent) clicks "Start live rounds" with a target quantity Q. Listing OPEN → ROUNDS; `rounds_end_at = now + 6 h` (hard cap).
2. **Each round (30 min):**
   - compute `clear(bids, Q, floor)` → cutoff;
   - for every HELD bid below the cutoff, send **one nudge per round**: `{ cutoffCents, yourBidCents, unitsLeft: Q, roundEndsAt }`;
   - nudges go to the buyer agent (in-app / push / MCP `my_bids.belowCutoff`) and are written to the audit log.
3. **Brand agent's role:** it writes the nudge text from the numbers only. It has a single write tool, `send_nudge(bidId)`, which the round runner calls; numbers come from code, never from the model. It still cannot clear.
4. **Buyer side:** the buyer agent raises once, straight to `cutoff + minimum raise`, if that is within the mandate max; otherwise it asks the shopper. Raises follow 05 (new hold first, then release).
5. **Minimum raise:** $1 or 1% of the bid, whichever is larger. No cap on the number of raises; after 5 raises the agent warns "Your bank may show several pending holds for a few days."
6. **Soft close:** a raise in the last 5 min of a round extends that round by 10 min, never past `rounds_end_at`.
7. **End:** rounds end at `rounds_end_at`, when a round produces no raises, or when the brand stops them. The brand then has **6 h to press Clear** (10); otherwise the listing expires and all holds are voided.

## Rules that keep it honest
- Nudges quote only the live book (cutoff, units). No invented scarcity, no "others are about to buy" unless true.
- The floor is never revealed.
- A shopper can mute nudges; muted bids still count.

## Data / API
`listings.status` adds `ROUNDS`; `listings.rounds_end_at`, `listings.target_quantity`; `nudges(id, bid_id, round, cutoff_cents, sent_at)`. `POST /listings/:id/rounds/start`, `POST /listings/:id/rounds/stop`, SSE `round.started`, `round.nudged`, `bid.raised`.

## Edge cases
| Case | Handling |
|---|---|
| Raise's new hold declined | Old bid stands; shopper told "Couldn't raise. Your $229 bid still stands." |
| Price watcher releases a bid mid-round | Bid leaves the book; cutoff recomputed next round |
| Brand changes Q during rounds | Allowed; next round uses the new Q |
| Hold-age guard would be breached | Rounds end early so Clear can run before 66 h |

## Acceptance criteria
- [ ] Only bids below the cutoff are nudged, once per round, with numbers equal to `clear()` output.
- [ ] A buyer agent with a mandate raises once to cutoff + minimum raise; without one, it asks.
- [ ] Rounds never run past 6 h; Clear is still possible within the hold-age guard.

## Test plan
Unit: nudge selection on fixture books. Integration: 20 SIM agents + 1 real sandbox bidder; run 2 rounds; verify raises and audit rows.
