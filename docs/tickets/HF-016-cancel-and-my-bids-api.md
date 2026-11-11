# HF-016: Cancel bid, my bids and bid detail APIs

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-014
- **Spec refs:** api.md §`POST /bids/:id/cancel`, §`GET /bids/mine`, §`GET /bids/:id`; features/15-audit-ops.md §Logic 3; data-model.md §Bid state machine

## Goal
Shoppers (and their agents and MCP clients) can release a hold and see every bid with its timeline.

## Scope
- `core/bids.ts#cancelBid(bidId, actor)`: HELD→VOIDING (`transition`) → `pp.void` (request id = a VOID settlement-like id stored on the bid/settlement row) → VOIDED, `void_reason=CANCELLED`; audit; SSE `bid.voided`. Idempotency-Key on the route.
- `GET /api/bids/mine`: shopper's bids with status, listing, amount, `belowCutoff` (+ `cutoffCents` only during ROUNDS).
- `GET /api/bids/:id`: bid + timeline from `audit_events` filtered by bid (owner only).

## Out of scope
- UI (HF-021). Raise (HF-018).

## Acceptance criteria
- [ ] Cancel voids the PayPal authorization and records the PayPal id in audit.
- [ ] Cancelling a WON bid during CLEARING → 409 `STATE_CONFLICT` (conditional update).
- [ ] Another shopper's bid → 404.

## Test plan
- Integration (sandbox): hold → cancel → VOIDED.

## Notes & risks
- Spec question: data-model defines VOID request id = `settlement.id`, but shopper cancels happen outside Clear where no settlement row exists. Proposed: insert a VOID `settlements` row for every void (unique(bid_id, action) still holds); confirm.
