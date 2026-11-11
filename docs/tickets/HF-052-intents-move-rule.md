# HF-052: Multi-product intents and the move rule

- **Track / owner:** C shopper & agents
- **Priority:** P1
- **Estimate:** 4
- **Depends on:** HF-040, HF-017
- **Spec refs:** features/04-buyer-agent-intent-bids.md §Logic 3–4, §Edge cases (no open book), §Acceptance criteria (P1); data-model.md §intents

## Goal
One want across several products, with exactly one live bid at a time, moved by plain code to the book most likely to clear.

## Scope
- Tools `create_intent(text, productIds, maxPriceCents)` (intent + draft mandate) and `move_bid(bidId, toListingId, amountCents)` (new hold first, then void old).
- `core/intents.ts`: pick listing by lowest required bid vs max, then earliest close; move when a better book opens or the current one closes lost; one live bid per intent.
- No open book → create intent and watch.
- Agent explains moves ("why did you move my bid?").

## Out of scope
- Auto-roll cron (HF-053).

## Acceptance criteria
- [ ] An intent across 2 products moves the bid when one book closes lost.
- [ ] Never two live bids for one intent.

## Test plan
- Unit: move rule. Integration: two listings, lose one.

## Notes & risks
- Moves go through `mandates.authorize` with the replaced hold excluded.
