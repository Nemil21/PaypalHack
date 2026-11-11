# HF-016: Cancel bid, my bids and bid detail APIs

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 5
- **Estimate:** 2
- **Depends on:** HF-014a
- **Spec refs:** api.md §`POST /bids/:id/cancel`, §`PATCH /bids/:id`, §`GET /bids/mine`, §`GET /bids/:id`; features/15-audit-ops.md §Logic 3; data-model.md §Bid state machine

## Goal
Shoppers (and their agents and MCP clients) can release a hold and see every bid with its full timeline, including raise chains.

## Scope
- `cancelBid(bidId, actor)` on top of `voidBid` (HF-003a):
  - HELD → VOIDING (conditional) → `pp.void` with `PayPal-Request-Id = void-<bidId>` (D4) → VOIDED, `void_reason=CANCELLED`. Retry the void 3 times in-call; "already voided" (`AUTHORIZATION_ALREADY_VOIDED`) = success. Record the void PayPal id and attempt count on the bid. If still failing, the bid stays VOIDING and the HF-034 sweeper re-voids it after 2 min.
  - PENDING_APPROVAL → ABANDONED with no PayPal call for wallet/card-fields bids; VAULT/server-card bids follow the HF-014a reconcile rule.
  - WON/LOST during CLEARING → 409 `STATE_CONFLICT`.
  - Naturally idempotent (a second cancel returns the current state); route still takes `Idempotency-Key`. Audit; SSE `bid.voided`.
- `GET /api/bids/mine`: shopper's bids with status, listing, amount, `belowCutoff` + `cutoffCents` **only during ROUNDS** (read from the latest round's nudge snapshot, HF-036a); `null` outside ROUNDS. Clients poll it every 5 s during ROUNDS (D18).
- `GET /api/bids/:id`: bid + timeline from `audit_events`, walking the `replaces_bid_id` chain both ways and merging events (Held $229 → Raised → Held $241 → Won). Owner only.
- Copy keys: "releasing" while VOIDING, "released" only once VOIDED.

## Out of scope
- UI (HF-020). Raise (HF-018). `PATCH /bids/:id {releaseIfCheaper}` (HF-020).

## Acceptance criteria
- [ ] Cancel voids the PayPal authorization and records the PayPal id in audit.
- [ ] Voiding twice with the same request id returns the same result; a second void is handled as success.
- [ ] Cancelling a WON bid during CLEARING → 409 `STATE_CONFLICT`.
- [ ] Cancelling a PENDING_APPROVAL wallet bid → ABANDONED, no PayPal call.
- [ ] Another shopper's bid → 404.
- [ ] Timeline of a raised bid shows both holds in order.

## Test plan
- Integration (sandbox): hold → cancel → VOIDED; double void.
- Integration (stub): void failure leaves VOIDING; chain walk.

## Notes & risks
- Resolved (D4, Q#14): `void-<bidId>` on every void path; no VOID settlement rows outside Clear (keeps W08 clean).
- Resolved (D14): every release message adds "Your bank may show it as pending for a few days."
