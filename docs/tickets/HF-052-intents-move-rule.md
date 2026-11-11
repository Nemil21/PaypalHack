# HF-052: Multi-product intents and the move rule

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 8
- **Estimate:** 4
- **Depends on:** HF-039, HF-017a, HF-018
- **Spec refs:** features/04-buyer-agent-intent-bids.md §Logic 3–4, §Edge cases (no open book), §Acceptance criteria (P1); data-model.md §intents

## Goal
One want across several products, with exactly one live bid at a time, moved by plain code to the book most likely to clear.

## Scope
- Tools `create_intent(text, productIds, maxPriceCents)` and `move_bid(bidId, toListingId, amountCents)`, both behind the HF-039 pending-action confirm gate.
- Intent creates its mandate **PAUSED** until the shopper confirms (no "draft" mandate status).
- `core/intents.ts`: pick listing by lowest required bid vs max, then earliest close; move when a better book opens or the current one closes lost.
- **Move = cross-listing `landHold` swap (D1):** new bid PENDING_APPROVAL with `replaces_bid_id = old.id`; in one transaction lock **both** listings `FOR SHARE` in id order, re-check biddable on the target, lock the mandate and re-check cap (D12, replaced bid excluded), flip old HELD→VOIDING(`REPLACED`) and new→HELD. Lost race → void the new authorization.
- DB guarantee: `UNIQUE INDEX ON bids(intent_id) WHERE status='HELD'` (plus D3's one-live-bid-per-listing).
- No open book → create intent and watch. Agent explains moves ("why did you move my bid?").

## Out of scope
- Auto-roll cron (HF-053).

## Acceptance criteria
- [ ] An intent across 2 products moves the bid when one book closes lost.
- [ ] Never two live bids for one intent (two concurrent moves on the stub: one wins, the other's hold is voided).
- [ ] A move racing Clear on the source listing never leaves both bids HELD.

## Test plan
- Unit: move rule. Integration (FakePayPal stub): two listings, lose one; concurrent moves; move vs Clear.

## Notes & risks
- Kept P1 by user override (§5 proposed P2/README); sequenced after the P0 bid chain.
- Resolved (D1, D3, D12): moves use the shared swap and cap rules.
